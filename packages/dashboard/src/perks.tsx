import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createPublicClient, http, type Hex } from 'viem';
import { buildClaim, cardKey, P } from '@zkdb/core';
import { gateAbi, type ChainConfig, type Perk, type Snapshot } from './chain';
import { proveClaimHere } from './claimProver';
import { friendlyError } from './errors';
import { formatAmount, toHex32 } from './format';
import { newCardSecret, newPickupCode, pickupHash } from './pickup';
import { BALANCE_FIELD, formatCard, KEY_FIELD, PROGRAM } from './points';
import { Empty, Hash, OnChain, Section, Table } from './ui';
import { formatMs } from './useProofMeta';
import { claimTargets, listDemoCards, relayClaim, relayClaimL1, type Wallet } from './wallet';
import { claimedOnL1, syncOf, type L1Live } from './l1live';
import { L1Tx } from './l1view';
import { claimRegistryAbi, joinClaims, type L1Claim, type SchoolL1State } from './schoolL1';

/** Which gate checks the claim: the one on the school L1 (the receipt then comes back to Fuji over ICM) or the one on Fuji. */
type Where = 'l1' | 'fuji';

type Verdict =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'accepted'; where: Where; perk: string; qualifying: number; ms: number; txHash: string; code: Hex; nullifier: Hex }
  | { kind: 'refused'; title: string; detail: string };

/** A card secret as typed or pasted: decimal or 0x hex, inside the field. */
function parseSecret(raw: string): bigint | null {
  const s = raw.trim();
  if (!/^(\d+|0x[0-9a-fA-F]+)$/.test(s)) return null;
  const v = BigInt(s);
  return v > 0n && v < P ? v : null;
}

/** The L1 checks claims against the root it holds. Until the newest one arrives, nothing is relayed there. */
const STALE_TITLE = 'The L1 has not received the newest root';
const staleDetail = (l1Batch: number, batchCount: number) =>
  `The school L1 holds root #${l1Batch}; the ledger is at #${batchCount}. Try again once the root is sent (School L1 page), or claim on Fuji.`;

const savedKey = (cfg: ChainConfig) => `zkdb.card.${cfg.address.toLowerCase()}`;
const readSaved = (cfg: ChainConfig): Hex | null => {
  try {
    return localStorage.getItem(savedKey(cfg)) as Hex | null;
  } catch {
    return null;
  }
};

/**
 * Perks unlocked by a zero-knowledge claim. The proof is made in this browser from the card's secret and the rows
 * this page rebuilt from the chain; PointsGate checks it against the root ZkDB holds. Nothing in the proof or the
 * transaction says which card claimed. The claim is made out to a one-time pickup code that stays on this device.
 */
export function Perks({ s, cfg, wallet, l1, l1Live, onChanged }: { s: Snapshot; cfg: ChainConfig; wallet: Wallet | null; l1?: SchoolL1State; l1Live?: L1Live; onChanged: () => void }) {
  const [perkId, setPerkId] = useState(0);
  const [targets, setTargets] = useState({ fuji: true, l1: false });
  const [choice, setChoice] = useState<Where | null>(null);
  const [secret, setSecret] = useState('');
  const [verdict, setVerdict] = useState<Verdict>({ kind: 'idle' });
  const [demo, setDemo] = useState<{ card: string; secret: Hex }[]>([]);
  const [saved, setSaved] = useState<Hex | null>(() => readSaved(cfg));
  const cards = useMemo(() => s.rows.filter((r) => r.table === PROGRAM.table), [s]);
  // The L1 is offered when its RPC answers and the server has a claim relayer the L1 lets send.
  const l1Ready = targets.l1 && !!cfg.l1?.live && !!l1Live;
  const where: Where = l1Ready && choice !== 'fuji' ? 'l1' : 'fuji';
  // Each gate keeps its own perks and its own count of claims.
  const offered: Perk[] = where === 'l1' ? l1Live!.perks : s.perks;
  const perk: Perk | undefined = offered.find((p) => p.id === perkId) ?? offered[0];
  const inTable = (p: Perk) => s.rows.filter((r) => r.table === p.tableId);
  const qualifying = (p: Perk) => inTable(p).filter((r) => r.fields[BALANCE_FIELD] >= p.minPoints).length;
  const batchOf = (root: bigint) => s.batches.find((b) => b.newRoot === root)?.batchNo;
  const busy = verdict.kind === 'busy';

  // Demo cards exist only where this machine seeded the story and the server runs in demo mode.
  useEffect(() => {
    let cancelled = false;
    listDemoCards().then((list) => { if (!cancelled) setDemo(list); }).catch(() => {});
    void claimTargets().then((t) => { if (!cancelled) setTargets(t); });
    return () => { cancelled = true; };
  }, []);
  // Offer only demo cards that are still in the ledger.
  const demoCards = demo.filter((d) => cards.some((r) => r.fields[KEY_FIELD] === cardKey(BigInt(d.secret))));
  const pick = (value: Hex) => { setSecret(value); setVerdict({ kind: 'idle' }); };

  async function claim(e: FormEvent) {
    e.preventDefault();
    if (!perk || !cfg.gate) return;
    const refuse = (title: string, detail: string) => setVerdict({ kind: 'refused', title, detail });
    const value = parseSecret(secret);
    if (value === null) return refuse('No card secret', 'Enter the secret your device made for your card.');
    const code = newPickupCode();
    const built = buildClaim(s.state, perk.tableId, { id: BigInt(perk.id), minPoints: perk.minPoints }, value, pickupHash(code));
    if (!built.ok) {
      return built.reason === 'unknown_card'
        ? refuse('Card not found', 'No card in this ledger has that secret.')
        : refuse('No proof exists', `This card has ${formatAmount(built.balance ?? 0n)} of the ${formatAmount(perk.minPoints)} points needed.`);
    }
    try {
      const nullifier = toHex32(built.input.nullifier) as Hex;
      const body = { perkId: perk.id, nullifier, pickup: toHex32(built.input.pickup) as Hex };
      // The proof opens the root this page rebuilt from Fuji, so the L1 must hold that same root.
      if (where === 'l1' && syncOf(l1Live!.mirror, s) !== 'synced') return refuse(STALE_TITLE, staleDetail(l1Live!.mirror.batchNo, s.batchCount));
      // Each gate has its own spent list, so the contracts would take this claim on the other chain too. The
      // dashboard does not send it there; that is a courtesy of this page and its relayer, not something on-chain.
      const client = createPublicClient({ transport: http(cfg.rpcUrl) });
      const [onFuji, onL1] = await Promise.all([
        client.readContract({ address: cfg.gate, abi: gateAbi, functionName: 'claimed', args: [BigInt(perk.id), nullifier] }),
        cfg.l1?.live ? claimedOnL1(cfg.l1.live, perk.id, nullifier).catch(() => false) : false,
      ]);
      if (onFuji || onL1) return refuse('Already claimed', `This card has claimed this perk before, on ${onL1 ? 'the school L1' : 'Fuji'}. This dashboard sends one claim per card and perk.`);
      setVerdict({ kind: 'busy', label: 'Proving on this device…' });
      const { proof, ms } = await proveClaimHere(built.input);
      setVerdict({ kind: 'busy', label: where === 'l1' ? `Sending the proof to ${cfg.l1!.name}…` : 'Sending the proof…' });
      const { txHash } = await (where === 'l1' ? relayClaimL1 : relayClaim)({ proof, ...body });
      setVerdict({ kind: 'accepted', where, perk: perk.name, qualifying: qualifying(perk), ms, txHash, code, nullifier });
      setSecret('');
      onChanged();
    } catch (err) {
      const { code, message } = err as { code?: string; message?: string };
      const title = code === 'l1_root_behind' ? STALE_TITLE : code === 'already_claimed' || code === 'claimed_elsewhere' ? 'Already claimed' : 'Claim not made';
      refuse(title, message || 'The claim could not be made.');
    }
  }

  if (!cfg.gate) return <Empty>This deployment has no perk gate.</Empty>;
  const perkName = (id: number) => s.perks.find((p) => p.id === id)?.name ?? l1Live?.perks.find((p) => p.id === id)?.name ?? `Perk ${id}`;
  // Claims checked on the school L1, joined with the receipts Fuji recorded for them.
  const onL1 = cfg.l1 ? joinClaims(l1?.claims ?? [], l1Live?.forwarded) : [];
  return (
    <>
      <div className="page-title with-switch">
        <h2>Perks, <em>claimed privately.</em></h2>
        {l1Ready && (
          <div className="where">
            <span className="lab" id="claim-where">Checked on</span>
            <div className="segmented" role="group" aria-labelledby="claim-where">
              <button type="button" aria-pressed={where === 'l1'} onClick={() => { setChoice('l1'); setVerdict({ kind: 'idle' }); }}>School L1</button>
              <button type="button" aria-pressed={where === 'fuji'} onClick={() => { setChoice('fuji'); setVerdict({ kind: 'idle' }); }}>Fuji C-Chain</button>
            </div>
          </div>
        )}
      </div>
      {offered.length === 0 ? <Empty>No perks yet.</Empty> : (
        <div className="perk-grid">
          {offered.map((p) => (
            <button key={p.id} type="button" className="box perk" aria-pressed={perk?.id === p.id} onClick={() => { setPerkId(p.id); setVerdict({ kind: 'idle' }); }}>
              <h3>{p.name}</h3>
              <span className="need"><b>{formatAmount(p.minPoints)}</b><span className="note">pts</span></span>
              <span className="foot"><span><b>{qualifying(p)}</b>/{inTable(p).length} qualify</span><span><b>{p.claims}</b> claimed{l1Ready ? (where === 'l1' ? ' on the L1' : ' on Fuji') : ''}</span></span>
            </button>
          ))}
        </div>
      )}

      {perk && (
        <Section title={`Claim · ${perk.name}`}>
          <form className="box padded stack-form claim" onSubmit={claim}>
            {l1Ready && (
              <p className="note">
                {where === 'l1'
                  ? `The gate on ${cfg.l1!.name} checks the proof, the school's relayer pays in ${cfg.l1!.token}, and the receipt comes back to Fuji over ICM.`
                  : 'The gate on Fuji checks the proof against the root ZkDB holds.'}
              </p>
            )}
            {l1Ready && where === 'l1' && syncOf(l1Live!.mirror, s) !== 'synced' && (
              <p className="tx error" role="status">{STALE_TITLE}. {staleDetail(l1Live!.mirror.batchNo, s.batchCount)}</p>
            )}
            <div className="claim-row">
              <label className="sr-only" htmlFor="claim-secret">Card secret</label>
              <input id="claim-secret" className="mono" value={secret} onChange={(e) => { setSecret(e.target.value); setVerdict({ kind: 'idle' }); }} placeholder="Card secret 0x…" autoComplete="off" spellCheck={false} />
              <button type="submit" className="primary" disabled={busy}>Prove and claim</button>
            </div>
            {(demoCards.length > 0 || saved) && (
              <div className="demo-cards">
                {saved && <button type="button" className="chip" onClick={() => pick(saved)}>My card</button>}
                {demoCards.map((d) => (
                  <button key={d.card} type="button" className="chip" onClick={() => pick(d.secret)}>{formatCard(BigInt(d.card))}</button>
                ))}
              </div>
            )}
            <ClaimVerdict v={verdict} cfg={cfg} receipt={verdict.kind === 'accepted' && verdict.where === 'l1' ? l1?.claims.find((c) => c.nullifier.toLowerCase() === verdict.nullifier.toLowerCase()) : undefined} />
          </form>
        </Section>
      )}

      <div className="columns">
        <Enrol cfg={cfg} saved={saved} onSaved={setSaved} />
        <PickupDesk s={s} cfg={cfg} wallet={wallet} l1={l1} onChanged={onChanged} />
      </div>

      <Section title="Claims" count={s.claims.length + onL1.length}>
        {s.claims.length + onL1.length === 0 ? <Empty>No claims yet.</Empty> : (
          <Table className={cfg.l1 ? 't-claims with-gate' : 't-claims'} head={[['Perk'], ...(cfg.l1 ? [['Gate'] as [string]] : []), ['Receipt', 'hide-m'], ['Proof', 'hide-m'], ['Handed out'], ['Tx', 'right']]}>
            {onL1.map((c) => (
              <tr key={`l1:${c.perkId}:${c.nullifier}`}>
                <td>{perkName(c.perkId)}</td>
                <td>School L1</td>
                <td className="hide-m"><Hash value={c.nullifier} /></td>
                <td className="mono hide-m"><a className="link" href={`#batch/${c.batchNo}`}>#{c.batchNo}</a></td>
                <td>{c.redeemTx
                  ? <span className="status delivered"><i aria-hidden="true" />Yes</span>
                  : <span className="status pending"><i aria-hidden="true" />{c.fujiTx ? 'Not yet' : 'Receipt on its way'}</span>}</td>
                <td className="right">{c.l1Tx ? <L1Tx hash={c.l1Tx} /> : c.fujiTx ? <OnChain value={c.fujiTx} kind="tx" /> : '—'}</td>
              </tr>
            ))}
            {[...s.claims].reverse().map((c) => {
              const batch = batchOf(c.root);
              return (
                <tr key={c.txHash}>
                  <td>{perkName(c.perkId)}</td>
                  {cfg.l1 && <td>Fuji</td>}
                  <td className="hide-m"><Hash value={c.nullifier} /></td>
                  <td className="mono hide-m">{batch === undefined ? '—' : <a className="link" href={`#batch/${batch}`}>#{batch}</a>}</td>
                  <td>{c.collected
                    ? <span className="status delivered"><i aria-hidden="true" />Yes</span>
                    : <span className="status pending"><i aria-hidden="true" />Not yet</span>}</td>
                  <td className="right"><OnChain value={c.txHash} kind="tx" /></td>
                </tr>
              );
            })}
          </Table>
        )}
      </Section>
    </>
  );
}

/** The result of a claim, large enough to read in a recording. */
function ClaimVerdict({ v, cfg, receipt }: { v: Verdict; cfg: ChainConfig; receipt?: L1Claim }) {
  if (v.kind === 'idle') return null;
  if (v.kind === 'busy') return <p className="tx busy" role="status">{v.label}</p>;
  if (v.kind === 'refused') {
    return (
      <div className="verdict-card refused" role="alert">
        <h3>{v.title}</h3>
        <p>{v.detail}</p>
      </div>
    );
  }
  return (
    <div className="verdict-card accepted" role="status">
      <h3>Claim accepted</h3>
      <p>{v.perk} · Card: hidden · 1 of {v.qualifying} qualifying cards</p>
      <div className="pickup">
        <div className="lab">Pickup code · show it at the desk</div>
        <Hash value={v.code} full />
      </div>
      {v.where === 'l1' ? (
        <>
          <p className="note">Proved here in {formatMs(v.ms)} · checked on {cfg.l1?.name} · <L1Tx hash={v.txHash} /></p>
          <p className="note" role="status">
            {receipt
              ? <>Receipt recorded on Fuji · <OnChain value={receipt.txHash} kind="tx" /></>
              : 'Receipt on its way to Fuji over ICM, usually within ten seconds.'}
          </p>
        </>
      ) : <p className="note">Proved here in {formatMs(v.ms)} · <OnChain value={v.txHash} kind="tx" /></p>}
    </div>
  );
}

/** A member makes their card secret here, on their own device, and gives the club only its hash. */
function Enrol({ cfg, saved, onSaved }: { cfg: ChainConfig; saved: Hex | null; onSaved: (s: Hex | null) => void }) {
  const [made, setMade] = useState<{ secret: Hex; code: Hex } | null>(null);
  const create = () => {
    const secret = newCardSecret();
    const hex = toHex32(secret) as Hex;
    try {
      localStorage.setItem(savedKey(cfg), hex);
    } catch {
      // Private mode: the member copies the secret by hand.
    }
    onSaved(hex);
    setMade({ secret: hex, code: toHex32(cardKey(secret)) as Hex });
  };
  return (
    <Section title="New card">
      <div className="box padded stack-form">
        <div className="row-actions">
          <button type="button" className="secondary" onClick={create}>{saved ? 'New secret' : 'Make a card secret'}</button>
        </div>
        {made && (
          <div className="issued">
            <div className="lab">Enrol code</div>
            <Hash value={made.code} full />
            <div className="lab">Secret · kept here</div>
            <Hash value={made.secret} full />
          </div>
        )}
      </div>
    </Section>
  );
}

/** At the desk: the member shows the pickup code; the page finds the claim it belongs to. */
function PickupDesk({ s, cfg, wallet, l1, onChanged }: { s: Snapshot; cfg: ChainConfig; wallet: Wallet | null; l1?: SchoolL1State; onChanged: () => void }) {
  const [code, setCode] = useState('');
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; hash: string } | { kind: 'error'; message: string }>({ kind: 'idle' });
  const valid = /^0x[0-9a-fA-F]{64}$/.test(code.trim());
  const pickup = valid ? (toHex32(pickupHash(code.trim() as Hex)) as string).toLowerCase() : null;
  // A code belongs to a claim on the Fuji gate, or to a receipt the school L1 sent to ClaimRegistry.
  const onGate = pickup ? s.claims.find((c) => c.pickup.toLowerCase() === pickup) : undefined;
  const onRegistry = pickup && !onGate ? l1?.claims.find((c) => c.pickup.toLowerCase() === pickup) : undefined;
  const claim = onGate ? { perkId: onGate.perkId, collected: onGate.collected } : onRegistry ? { perkId: onRegistry.perkId, collected: !!onRegistry.redeemTx } : undefined;
  const perk = claim ? `${s.perks.find((p) => p.id === claim.perkId)?.name ?? `Perk ${claim.perkId}`}${onRegistry ? ' · claimed on the school L1' : ''}` : '';

  async function handOut() {
    if (!wallet || !cfg.gate || !claim) return;
    setState({ kind: 'busy' });
    try {
      const pub = createPublicClient({ transport: http(cfg.rpcUrl), pollingInterval: 500 });
      const args = [BigInt(claim.perkId), code.trim() as Hex] as const;
      // The gate keeps its own claims; a claim made on the L1 is redeemed against its receipt in ClaimRegistry.
      const call = onRegistry && cfg.l1
        ? { address: cfg.l1.registry, abi: claimRegistryAbi, functionName: 'redeem', args, account: wallet.address } as const
        : { address: cfg.gate, abi: gateAbi, functionName: 'collect', args, account: wallet.address } as const;
      await pub.simulateContract(call as never);
      const hash = await wallet.client.writeContract({ ...call, chain: null } as never);
      await pub.waitForTransactionReceipt({ hash });
      setState({ kind: 'done', hash });
      onChanged();
    } catch (e) {
      setState({ kind: 'error', message: friendlyError(e) });
    }
  }

  return (
    <Section title="Desk">
      <div className="box padded stack-form">
        <label className="sr-only" htmlFor="pickup-code">Pickup code</label>
        <input id="pickup-code" className="mono" value={code} onChange={(e) => { setCode(e.target.value); setState({ kind: 'idle' }); }} placeholder="Pickup code 0x…" autoComplete="off" spellCheck={false} />
        {valid && !claim && <div className="verdict-card refused small"><h3>No claim</h3></div>}
        {claim && !claim.collected && state.kind !== 'done' && (
          <div className="verdict-card accepted small">
            <h3>Valid</h3>
            <p>{perk}</p>
            {wallet
              ? <div className="row-actions"><button type="button" className="primary small" disabled={state.kind === 'busy'} onClick={() => void handOut()}>Hand out</button></div>
              : <p className="note">Sign in to hand it out.</p>}
          </div>
        )}
        {claim?.collected && state.kind !== 'done' && <div className="verdict-card refused small"><h3>Already used</h3><p>{perk}</p></div>}
        {state.kind === 'busy' && <p className="tx busy" role="status">{wallet?.kind === 'browser' ? 'Confirm in your wallet…' : 'Sending…'}</p>}
        {state.kind === 'done' && <p className="tx done" role="status">Handed out. <OnChain value={state.hash} kind="tx" /></p>}
        {state.kind === 'error' && <p className="tx error" role="alert">{state.message}</p>}
      </div>
    </Section>
  );
}
