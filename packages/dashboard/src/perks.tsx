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
import { listDemoCards, relayClaim, type Wallet } from './wallet';

type Verdict =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'accepted'; perk: string; qualifying: number; ms: number; txHash: string; code: Hex }
  | { kind: 'refused'; title: string; detail: string };

/** A card secret as typed or pasted: decimal or 0x hex, inside the field. */
function parseSecret(raw: string): bigint | null {
  const s = raw.trim();
  if (!/^(\d+|0x[0-9a-fA-F]+)$/.test(s)) return null;
  const v = BigInt(s);
  return v > 0n && v < P ? v : null;
}

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
export function Perks({ s, cfg, wallet, onChanged }: { s: Snapshot; cfg: ChainConfig; wallet: Wallet | null; onChanged: () => void }) {
  const [perkId, setPerkId] = useState(0);
  const [secret, setSecret] = useState('');
  const [verdict, setVerdict] = useState<Verdict>({ kind: 'idle' });
  const [demo, setDemo] = useState<{ card: string; secret: Hex }[]>([]);
  const [saved, setSaved] = useState<Hex | null>(() => readSaved(cfg));
  const cards = useMemo(() => s.rows.filter((r) => r.table === PROGRAM.table), [s]);
  const perk: Perk | undefined = s.perks.find((p) => p.id === perkId) ?? s.perks[0];
  const qualifying = (p: Perk) => cards.filter((r) => r.table === p.tableId && r.fields[BALANCE_FIELD] >= p.minPoints).length;
  const batchOf = (root: bigint) => s.batches.find((b) => b.newRoot === root)?.batchNo;
  const busy = verdict.kind === 'busy';

  // Demo cards exist only where this machine seeded the story and the server runs in demo mode.
  useEffect(() => {
    let cancelled = false;
    listDemoCards().then((list) => { if (!cancelled) setDemo(list); }).catch(() => {});
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
      const client = createPublicClient({ transport: http(cfg.rpcUrl) });
      if (await client.readContract({ address: cfg.gate, abi: gateAbi, functionName: 'claimed', args: [BigInt(perk.id), nullifier] })) {
        return refuse('Already claimed', 'This card has claimed this perk before. One claim per card.');
      }
      setVerdict({ kind: 'busy', label: 'Proving on this device…' });
      const { proof, ms } = await proveClaimHere(built.input);
      setVerdict({ kind: 'busy', label: 'Sending the proof…' });
      const { txHash } = await relayClaim({ proof, perkId: perk.id, nullifier, pickup: toHex32(built.input.pickup) as Hex });
      setVerdict({ kind: 'accepted', perk: perk.name, qualifying: qualifying(perk), ms, txHash, code });
      setSecret('');
      onChanged();
    } catch (err) {
      refuse('Claim not made', (err as Error).message || 'The claim could not be made.');
    }
  }

  if (!cfg.gate) return <Empty>This deployment has no perk gate.</Empty>;
  return (
    <>
      <Section title="Perks" count={s.perks.length} note="Prove you have enough points. The proof does not say which card is yours.">
        {s.perks.length === 0 ? <Empty>No perks yet.</Empty> : (
          <Table head={[['Perk'], ['Needs', 'right'], ['Cards that qualify', 'right'], ['Claimed', 'right']]}>
            {s.perks.map((p) => (
              <tr key={p.id}>
                <td><b>{p.name}</b></td>
                <td className="mono right">{formatAmount(p.minPoints)}</td>
                <td className="mono right">{qualifying(p)} of {cards.length}</td>
                <td className="mono right">{p.claims}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      {perk && (
        <Section title="Claim with your card">
          <form className="box padded stack-form claim" onSubmit={claim}>
            <div className="field-grid two">
              <div className="field">
                <label htmlFor="claim-perk">Perk</label>
                <select id="claim-perk" value={perk.id} onChange={(e) => { setPerkId(Number(e.target.value)); setVerdict({ kind: 'idle' }); }}>
                  {s.perks.map((p) => <option key={p.id} value={p.id}>{p.name} · {formatAmount(p.minPoints)} points</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="claim-secret">Card secret (stays on this device)</label>
                <input id="claim-secret" className="mono" value={secret} onChange={(e) => { setSecret(e.target.value); setVerdict({ kind: 'idle' }); }} placeholder="0x…" autoComplete="off" spellCheck={false} />
              </div>
            </div>
            {(demoCards.length > 0 || saved) && (
              <div className="demo-cards">
                {saved && <button type="button" className="chip" onClick={() => pick(saved)}>Card saved on this device</button>}
                {demoCards.length > 0 && <span className="lab">Demo cards · secrets on this machine</span>}
                {demoCards.map((d) => (
                  <button key={d.card} type="button" className="chip" onClick={() => pick(d.secret)}>{formatCard(BigInt(d.card))}</button>
                ))}
              </div>
            )}
            <div className="row-actions">
              <button type="submit" className="primary" disabled={busy}>Prove and claim</button>
            </div>
            <ClaimVerdict v={verdict} />
          </form>
        </Section>
      )}

      <div className="columns">
        <Enrol cfg={cfg} saved={saved} onSaved={setSaved} />
        <PickupDesk s={s} cfg={cfg} wallet={wallet} onChanged={onChanged} />
      </div>

      <Section title="Claims" count={s.claims.length}>
        {s.claims.length === 0 ? <Empty>No claims yet.</Empty> : (
          <Table head={[['Perk'], ['Card'], ['Claim receipt', 'hide-m'], ['Checked against', 'right hide-m'], ['Perk handed out'], ['Transaction', 'right']]}>
            {[...s.claims].reverse().map((c) => {
              const batch = batchOf(c.root);
              return (
                <tr key={c.txHash}>
                  <td>{s.perks.find((p) => p.id === c.perkId)?.name ?? `Perk ${c.perkId}`}</td>
                  <td className="note">hidden</td>
                  <td className="hide-m"><Hash value={c.nullifier} /></td>
                  <td className="mono right hide-m">{batch === undefined ? '—' : <a className="link" href={`#batch/${batch}`}>proof #{batch}</a>}</td>
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
function ClaimVerdict({ v }: { v: Verdict }) {
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
        <div className="lab">Pickup code · show it at the desk · it is not stored anywhere else</div>
        <Hash value={v.code} full />
      </div>
      <p className="note">Proved on this device in {formatMs(v.ms)}. The transaction names no card. <OnChain value={v.txHash} kind="tx" /></p>
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
    <Section title="Get a card">
      <div className="box padded stack-form">
        <p className="note">Your device makes the card's secret. The club only ever gets the enrol code, which is a hash of it.</p>
        <div className="row-actions">
          <button type="button" className="secondary" onClick={create}>{saved ? 'Make a new card secret' : 'Make my card secret'}</button>
        </div>
        {made && (
          <div className="issued">
            <div className="lab">Enrol code · give this to the treasurer</div>
            <Hash value={made.code} full />
            <div className="lab">Card secret · keep it; it is saved in this browser</div>
            <Hash value={made.secret} full />
          </div>
        )}
      </div>
    </Section>
  );
}

/** At the desk: the member shows the pickup code; the page finds the claim it belongs to. */
function PickupDesk({ s, cfg, wallet, onChanged }: { s: Snapshot; cfg: ChainConfig; wallet: Wallet | null; onChanged: () => void }) {
  const [code, setCode] = useState('');
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; hash: string } | { kind: 'error'; message: string }>({ kind: 'idle' });
  const valid = /^0x[0-9a-fA-F]{64}$/.test(code.trim());
  const pickup = valid ? (toHex32(pickupHash(code.trim() as Hex)) as string).toLowerCase() : null;
  const claim = pickup ? s.claims.find((c) => c.pickup.toLowerCase() === pickup) : undefined;
  const perk = claim ? s.perks.find((p) => p.id === claim.perkId)?.name ?? `Perk ${claim.perkId}` : '';

  async function handOut() {
    if (!wallet || !cfg.gate || !claim) return;
    setState({ kind: 'busy' });
    try {
      const pub = createPublicClient({ transport: http(cfg.rpcUrl), pollingInterval: 500 });
      const call = { address: cfg.gate, abi: gateAbi, functionName: 'collect', args: [BigInt(claim.perkId), code.trim() as Hex], account: wallet.address } as const;
      await pub.simulateContract(call);
      const hash = await wallet.client.writeContract({ ...call, chain: null });
      await pub.waitForTransactionReceipt({ hash });
      setState({ kind: 'done', hash });
      onChanged();
    } catch (e) {
      setState({ kind: 'error', message: friendlyError(e) });
    }
  }

  return (
    <Section title="At the desk">
      <div className="box padded stack-form">
        <div className="field">
          <label htmlFor="pickup-code">Pickup code the member shows</label>
          <input id="pickup-code" className="mono" value={code} onChange={(e) => { setCode(e.target.value); setState({ kind: 'idle' }); }} placeholder="0x…" autoComplete="off" spellCheck={false} />
        </div>
        {valid && !claim && <div className="verdict-card refused small"><h3>No claim has this code</h3></div>}
        {claim && !claim.collected && (
          <div className="verdict-card accepted small">
            <h3>Valid claim</h3>
            <p>{perk} · not handed out yet</p>
            {wallet && <div className="row-actions"><button type="button" className="primary small" disabled={state.kind === 'busy'} onClick={() => void handOut()}>Mark as handed out</button></div>}
          </div>
        )}
        {claim?.collected && <div className="verdict-card refused small"><h3>Already handed out</h3><p>{perk}</p></div>}
        {state.kind === 'done' && <p className="tx done" role="status">Handed out. <OnChain value={state.hash} kind="tx" /></p>}
        {state.kind === 'error' && <p className="tx error" role="alert">{state.message}</p>}
      </div>
    </Section>
  );
}
