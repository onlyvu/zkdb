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
import { Glyph, PerkArt, perkKind } from './art';
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

export const savedKey = (cfg: ChainConfig) => `zkdb.card.${cfg.address.toLowerCase()}`;
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
export function Perks({ s, cfg, wallet, l1, l1Live, onChanged, onSignIn }: { s: Snapshot; cfg: ChainConfig; wallet: Wallet | null; l1?: SchoolL1State; l1Live?: L1Live; onChanged: () => void; onSignIn: () => void }) {
  const [perkId, setPerkId] = useState(0);
  const [targets, setTargets] = useState({ fuji: true, l1: false });
  const [choice, setChoice] = useState<Where | null>(null);
  const [secret, setSecret] = useState('');
  const [verdict, setVerdict] = useState<Verdict>({ kind: 'idle' });
  const [demo, setDemo] = useState<{ card: string; secret: Hex }[]>([]);
  const [saved, setSaved] = useState<Hex | null>(() => readSaved(cfg));
  // Where "get a card" sits is decided once, on arrival, so making a key does not move the block it was made in.
  const [enrolFirst] = useState(() => !readSaved(cfg));
  const cards = useMemo(() => s.rows.filter((r) => r.table === PROGRAM.table), [s]);
  // The L1 is offered when its RPC answers and the server has a claim relayer the L1 lets send.
  const l1Ready = targets.l1 && !!cfg.l1?.live && !!l1Live;
  // Every reward is listed, whichever gate holds it. A reward the school L1 also offers is claimed there (free for
  // students) unless chain details switch it to Fuji; one only Fuji offers, such as the trial's, is claimed on Fuji.
  const l1PerkOf = (id: number) => l1Live?.perks.find((p) => p.id === id);
  // Each gate keeps its own perks and its own count of claims.
  const offered: Perk[] = [...s.perks, ...(l1Live?.perks ?? []).filter((p) => !s.perks.some((f) => f.id === p.id))];
  const picked: Perk | undefined = offered.find((p) => p.id === perkId) ?? offered[0];
  const where: Where = l1Ready && picked && l1PerkOf(picked.id) && choice !== 'fuji' ? 'l1' : 'fuji';
  // The gate that will check the claim holds its own copy of the perk (threshold and table).
  const perk: Perk | undefined = picked && (where === 'l1' ? l1PerkOf(picked.id) : s.perks.find((p) => p.id === picked.id)) || picked;
  const claimsOf = (p: Perk) => (s.perks.find((f) => f.id === p.id)?.claims ?? 0) + (l1PerkOf(p.id)?.claims ?? 0);
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
    if (value === null) return refuse('Card key missing', 'Paste the card key your device made, or pick a card below.');
    const code = newPickupCode();
    const built = buildClaim(s.state, perk.tableId, { id: BigInt(perk.id), minPoints: perk.minPoints }, value, pickupHash(code));
    if (!built.ok) {
      return built.reason === 'unknown_card'
        ? refuse('Card not found', 'No card in this ledger has that key.')
        : refuse('Not enough points', `This card has ${formatAmount(built.balance ?? 0n)}. ${perk.name} needs ${formatAmount(perk.minPoints)}.`);
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
      if (onFuji || onL1) return refuse('Already claimed', `This card already claimed ${perk.name}. One claim per card.`);
      setVerdict({ kind: 'busy', label: 'Making the proof on this device…' });
      const { proof, ms } = await proveClaimHere(built.input);
      setVerdict({ kind: 'busy', label: 'Sending the proof…' });
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

  if (!cfg.gate) return <Empty>No rewards on this ledger.</Empty>;
  const perkName = (id: number) => s.perks.find((p) => p.id === id)?.name ?? l1Live?.perks.find((p) => p.id === id)?.name ?? `Perk ${id}`;
  // Claims checked on the school L1, joined with the receipts Fuji recorded for them.
  const onL1 = cfg.l1 ? joinClaims(l1?.claims ?? [], l1Live?.forwarded) : [];
  return (
    <>
      <div className="page-title with-switch">
        <div>
          <h2>Rewards, <em>claimed privately.</em></h2>
        </div>
        {l1Ready && picked && l1PerkOf(picked.id) && (
          <div className="where tech-only">
            <span className="lab" id="claim-where">Checked on</span>
            <div className="segmented" role="group" aria-labelledby="claim-where">
              <button type="button" aria-pressed={where === 'l1'} onClick={() => { setChoice('l1'); setVerdict({ kind: 'idle' }); }}>School L1</button>
              <button type="button" aria-pressed={where === 'fuji'} onClick={() => { setChoice('fuji'); setVerdict({ kind: 'idle' }); }}>Fuji C-Chain</button>
            </div>
          </div>
        )}
      </div>
      {/* Without a card on this device, getting one comes first; with one, it moves down beside the desk. */}
      {enrolFirst && <Enrol cfg={cfg} saved={saved} onSaved={setSaved} first />}
      <h3 className="step-label"><span>1</span>Pick a reward</h3>
      {offered.length === 0 ? <Empty>No rewards yet.</Empty> : (
        <div className="perk-grid">
          {offered.map((p) => (
            <button key={p.id} type="button" className={`box perk k-${perkKind(p.name)}`} aria-pressed={perk?.id === p.id} onClick={() => { setPerkId(p.id); setVerdict({ kind: 'idle' }); }}>
              <PerkArt name={p.name} />
              <h3>{p.name}</h3>
              <span className="need"><b>{formatAmount(p.minPoints)}</b><span className="note">pts</span></span>
              <span className="foot">
                <span title={`${qualifying(p)} of ${inTable(p).length} members have enough points`}><Glyph name="people" /><b>{qualifying(p)}</b>/{inTable(p).length}</span>
                <span title={`Claimed ${claimsOf(p)} times`}><Glyph name="gift" /><b>{claimsOf(p)}</b></span>
              </span>
            </button>
          ))}
        </div>
      )}

      {perk && (
        <section className="section">
          <h3 className="step-label"><span>2</span>Prove it with your card</h3>
          <form className="box padded stack-form claim" onSubmit={claim}>
            {l1Ready && (
              <p className="note tech-only">
                {where === 'l1'
                  ? `The gate on ${cfg.l1!.name} checks the proof, the school's relayer pays in ${cfg.l1!.token}, and the receipt comes back to Fuji over ICM.`
                  : 'The gate on Fuji checks the proof against the root ZkDB holds.'}
              </p>
            )}
            {l1Ready && where === 'l1' && syncOf(l1Live!.mirror, s) !== 'synced' && (
              <p className="tx error" role="status">{STALE_TITLE}. {staleDetail(l1Live!.mirror.batchNo, s.batchCount)}</p>
            )}
            <div className="claim-row">
              <label className="sr-only" htmlFor="claim-secret">Card key</label>
              <input id="claim-secret" className="mono" value={secret} onChange={(e) => { setSecret(e.target.value); setVerdict({ kind: 'idle' }); }} placeholder="Paste your card key (0x…)" autoComplete="off" spellCheck={false} />
              <button type="submit" className="primary" disabled={busy}>Claim {perk.name}</button>
            </div>
            {(demoCards.length > 0 || saved) && (
              <div className="demo-cards">
                <span className="lab">Or use</span>
                {saved && <button type="button" className="chip" onClick={() => pick(saved)}>My card</button>}
                {demoCards.map((d) => (
                  <button key={d.card} type="button" className="chip" onClick={() => pick(d.secret)}>Card {formatCard(BigInt(d.card))}</button>
                ))}
              </div>
            )}
            <p className="checked-by"><Glyph name="lock" />Your key never leaves this device</p>
            <ClaimVerdict v={verdict} cfg={cfg} receipt={verdict.kind === 'accepted' && verdict.where === 'l1' ? l1?.claims.find((c) => c.nullifier.toLowerCase() === verdict.nullifier.toLowerCase()) : undefined} />
          </form>
        </section>
      )}

      {enrolFirst
        ? <PickupDesk s={s} cfg={cfg} wallet={wallet} l1={l1} onChanged={onChanged} onSignIn={onSignIn} />
        : (
          <div className="columns">
            <Enrol cfg={cfg} saved={saved} onSaved={setSaved} />
            <PickupDesk s={s} cfg={cfg} wallet={wallet} l1={l1} onChanged={onChanged} onSignIn={onSignIn} />
          </div>
        )}

      <Section title="Recent claims" count={s.claims.length + onL1.length} note={<span className="checked-by"><Glyph name="lock" />Who claimed stays hidden</span>}>
        {s.claims.length + onL1.length === 0 ? <Empty>No claims yet.</Empty> : (
          <ul className="box feed">
            {[...onL1.map((c) => ({ key: `l1:${c.perkId}:${c.nullifier}`, perkId: c.perkId, done: !!c.redeemTx })), ...[...s.claims].reverse().map((c) => ({ key: c.txHash, perkId: c.perkId, done: c.collected }))]
              .slice(0, 8)
              .map((c) => (
                <li key={c.key}>
                  <PerkArt name={perkName(c.perkId)} />
                  <span className="feed-what"><b>{perkName(c.perkId)}</b><span className="note">by a hidden member</span></span>
                  {c.done
                    ? <span className="status delivered"><i aria-hidden="true" />Picked up</span>
                    : <span className="status pending"><i aria-hidden="true" />Ready</span>}
                </li>
              ))}
          </ul>
        )}
        {s.claims.length + onL1.length > 0 && (
          <div className="tech-only" style={{ marginTop: 16 }}>
          <Table className="t-claims" head={[['Reward'], ...(cfg.l1 ? [['Checked on', 'hide-m tech-only'] as [string, string]] : []), ['Receipt', 'hide-m tech-only'], ['Proof', 'hide-m tech-only'], ['Handed out'], ['Transaction', 'right tech-only']]}>
            {onL1.map((c) => (
              <tr key={`l1:${c.perkId}:${c.nullifier}`}>
                <td>{perkName(c.perkId)}</td>
                <td className="hide-m tech-only">School chain</td>
                <td className="hide-m tech-only"><Hash value={c.nullifier} /></td>
                <td className="mono hide-m tech-only"><a className="link" href={`#batch/${c.batchNo}`}>#{c.batchNo}</a></td>
                <td>{c.redeemTx
                  ? <span className="status delivered"><i aria-hidden="true" />Yes</span>
                  : <span className="status pending"><i aria-hidden="true" />{c.fujiTx ? 'Not yet' : 'Receipt on its way'}</span>}</td>
                <td className="right tech-only">{c.l1Tx ? <L1Tx hash={c.l1Tx} /> : c.fujiTx ? <OnChain value={c.fujiTx} kind="tx" /> : '—'}</td>
              </tr>
            ))}
            {[...s.claims].reverse().map((c) => {
              const batch = batchOf(c.root);
              return (
                <tr key={c.txHash}>
                  <td>{perkName(c.perkId)}</td>
                  {cfg.l1 && <td className="hide-m tech-only">Fuji</td>}
                  <td className="hide-m tech-only"><Hash value={c.nullifier} /></td>
                  <td className="mono hide-m tech-only">{batch === undefined ? '—' : <a className="link" href={`#batch/${batch}`}>#{batch}</a>}</td>
                  <td>{c.collected
                    ? <span className="status delivered"><i aria-hidden="true" />Yes</span>
                    : <span className="status pending"><i aria-hidden="true" />Not yet</span>}</td>
                  <td className="right tech-only"><OnChain value={c.txHash} kind="tx" /></td>
                </tr>
              );
            })}
          </Table>
          </div>
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
      <p>{v.perk}. Your card stays hidden among {v.qualifying} that qualify.</p>
      <div className="pickup">
        <div className="lab">Your pickup code · show it at the desk</div>
        <Hash value={v.code} full />
      </div>
      {v.where === 'l1' ? (
        <>
          <p className="note">Proved here in {formatMs(v.ms)}<span className="tech-only"> · checked on {cfg.l1?.name} · <L1Tx hash={v.txHash} /></span></p>
          <p className="note tech-only" role="status">
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
export function Enrol({ cfg, saved, onSaved, first }: { cfg: ChainConfig; saved: Hex | null; onSaved: (s: Hex | null) => void; first?: boolean }) {
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
    <Section title={<><Glyph name="card" />{first ? 'Get your card' : 'No card yet?'}</>}>
      <div className={first ? 'box padded stack-form enrol-first' : 'box padded stack-form'}>
        <div className="row-actions">
          <button type="button" className="secondary" onClick={create}><Glyph name="plus" />{saved ? 'New card key' : 'Make a card key'}</button>
        </div>
        {made && (
          <div className="issued">
            <div className="lab">Enrol code · give this to the club</div>
            <Hash value={made.code} full />
            <div className="lab">Card key · keep it, it stays on this device</div>
            <Hash value={made.secret} full />
          </div>
        )}
      </div>
    </Section>
  );
}

/** At the desk: the member shows the pickup code; the page finds the claim it belongs to. */
function PickupDesk({ s, cfg, wallet, l1, onChanged, onSignIn }: { s: Snapshot; cfg: ChainConfig; wallet: Wallet | null; l1?: SchoolL1State; onChanged: () => void; onSignIn: () => void }) {
  const [code, setCode] = useState('');
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; hash: string } | { kind: 'error'; message: string }>({ kind: 'idle' });
  const valid = /^0x[0-9a-fA-F]{64}$/.test(code.trim());
  const pickup = valid ? (toHex32(pickupHash(code.trim() as Hex)) as string).toLowerCase() : null;
  // A code belongs to a claim on the Fuji gate, or to a receipt the school L1 sent to ClaimRegistry.
  const onGate = pickup ? s.claims.find((c) => c.pickup.toLowerCase() === pickup) : undefined;
  const onRegistry = pickup && !onGate ? l1?.claims.find((c) => c.pickup.toLowerCase() === pickup) : undefined;
  const claim = onGate ? { perkId: onGate.perkId, collected: onGate.collected } : onRegistry ? { perkId: onRegistry.perkId, collected: !!onRegistry.redeemTx } : undefined;
  const perk = claim ? s.perks.find((p) => p.id === claim.perkId)?.name ?? `Reward ${claim.perkId}` : '';

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
    <Section title={<><Glyph name="desk" />Hand-out desk</>} actions={<span className="status pending">Staff</span>}>
      <div className="box padded stack-form">
        <label className="sr-only" htmlFor="pickup-code">Pickup code</label>
        <input id="pickup-code" className="mono" value={code} onChange={(e) => { setCode(e.target.value); setState({ kind: 'idle' }); }} placeholder="Paste a pickup code (0x…)" autoComplete="off" spellCheck={false} />
        {valid && !claim && <div className="verdict-card refused small"><h3>No claim for this code</h3></div>}
        {claim && !claim.collected && state.kind !== 'done' && (
          <div className="verdict-card accepted small">
            <h3>Valid code</h3>
            <p>{perk}</p>
            {wallet
              ? <div className="row-actions"><button type="button" className="primary small" disabled={state.kind === 'busy'} onClick={() => void handOut()}>Hand out</button></div>
              : <div className="row-actions"><button type="button" className="secondary small" onClick={onSignIn}>Staff sign in to hand out</button></div>}
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
