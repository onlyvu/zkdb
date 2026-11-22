import { useMemo, useState, type ReactNode } from 'react';
import type { ChainConfig, Snapshot } from './chain';
import { actionName, describeOp, FIELD_NAMES, formatAmount, formatFee, formatField, formatGas, formatGasShort, formatTime, plural, toHex32 } from './format';
import { cardOf, changeLabel, formatCard, members, pointsEvents, trialChange, unqueuedProposals, type Member, type PointsEvent, type UnqueuedProposal } from './points';
import { batchSlots, nextBatchSlots, type BatchView, type OpStatus, type OpView } from './replay';
import { Actor, Details, Empty, Hash, K, KeyValues, OnChain, OpStatusLabel, Section, SlotBar, SlotLegend, STATUS, Table } from './ui';
import type { Delivery } from './useIcm';
import { atRefPrice, type PriceRef } from './usePriceRef';
import { formatMs, rootKey, type ProofMetaMap } from './useProofMeta';
import { BatchArt, CardArt, ClaimArt, Glyph, Seal } from './art';
import { useMyCard, WalletCard } from './mycard';
import { L1Band, L1Tx } from './l1view';
import type { L1Live, L1LiveState } from './l1live';
import type { SchoolL1State } from './schoolL1';

interface PageProps { s: Snapshot; cfg?: ChainConfig; meta?: ProofMetaMap; deliveries?: Record<string, Delivery>; priceRef?: PriceRef }
/** The school L1 as both chains report it: what Fuji sent (l1) and what the L1 stored (l1Live). */
interface L1Props { l1?: SchoolL1State; l1Live?: L1Live }

/** Points events and members are derived once per snapshot. */
function usePoints(s: Snapshot) {
  return useMemo(() => {
    const events = pointsEvents(s.ops, s.proposals);
    return { events, members: members(s.rows, events), proposals: unqueuedProposals(s.proposals, s.ops) };
  }, [s]);
}

const average = (xs: bigint[]) => (xs.length ? xs.reduce((a, b) => a + b, 0n) / BigInt(xs.length) : undefined);

export function Overview({ s, stale, cfg, meta = {}, priceRef, l1, l1Live, onCheck }: PageProps & { stale: boolean; l1?: SchoolL1State; l1Live?: L1LiveState; onCheck?: () => Promise<number> }) {
  const { members: list } = usePoints(s);
  const latest = s.batches[s.batches.length - 1];
  const confirmMs = latest ? meta[rootKey(latest.newRoot)]?.confirmMs : undefined;
  const total = list.reduce((sum, m) => sum + m.balance, 0n);
  const fees = s.batches.map((b) => b.fee).filter((f): f is bigint => f !== undefined);
  const gas = s.batches.map((b) => b.gasUsed).filter((g): g is bigint => g !== undefined);
  const mine = useMyCard(cfg, s);
  const cost = atRefPrice(average(gas), priceRef, cfg?.currency) ?? (cfg?.currency && fees.length ? formatFee(average(fees), cfg.currency) : undefined);
  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <h1 id="hero-title">The ZK ledger <em>for students.</em></h1>
          <p className="lede">Volunteer, earn points, get rewards. Nobody can fake them.</p>
          <div className="cta">
            {mine
              ? <a className="button primary" href="#perks"><Glyph name="gift" />Use my points</a>
              : cfg?.gate && <a className="button primary" href="#try"><Glyph name="card" />Get a card · 1 min</a>}
            <Verify s={s} stale={stale} onCheck={onCheck} />
          </div>
          <VerifyDetails s={s} />
        </div>
        <div className="hero-card">
          {mine
            ? <a href={mine.trial ? '#perks' : `#member/${mine.rowId}`} aria-label="My card"><WalletCard card={mine.card} points={mine.balance} caption={mine.trial ? 'Trial card' : 'My card'} /></a>
            : <WalletCard ghost points={0n} caption="Your card here" />}
        </div>
      </section>

      <section className="how" aria-labelledby="how-title">
        <h2 id="how-title" className="sr-only">How it works</h2>
        <ol>
          <li><CardArt /><h3>Points go in</h3><p>Public, signed by name</p></li>
          <li><BatchArt /><h3>Math checks them</h3><p>Bad changes bounce</p></li>
          <li><ClaimArt /><h3>Claim privately</h3><p>Your card stays hidden</p></li>
        </ol>
      </section>

      <section className="tiles four" aria-label="Summary">
        <div className="box tile c-blue">
          <span className="tile-ico"><Glyph name="people" className="bounce" /></span>
          <div className="lab">Members</div>
          <div className="big">{list.length}</div>
        </div>
        <div className="box tile c-lime">
          <span className="tile-ico"><Glyph name="coins" className="bounce" /></span>
          <div className="lab">Points held</div>
          <div className="big">{formatAmount(total)}</div>
        </div>
        <div className="box tile c-amber">
          <span className="tile-ico"><Glyph name="hourglass" className="spin" /></span>
          <div className="lab">Waiting</div>
          <div className="big">{s.pending}</div>
          <p className="note tech-only">{s.pending}/{K} slots of the next proof</p>
        </div>
        <div className="box tile c-violet">
          <span className="tile-ico"><Glyph name="bolt" className="zap" /></span>
          <div className="lab">Cost per proof</div>
          <div className="big">{cost?.replace(/^≈\s*/, '').split(' at ')[0] ?? formatGasShort(average(gas))}</div>
          <p className="note tech-only">
            {[`${formatGasShort(average(gas))} gas`, cost?.includes(' at ') ? `at ${cost.split(' at ')[1]}` : '', confirmMs !== undefined ? `confirmed in ${formatMs(confirmMs)}` : ''].filter(Boolean).join(' · ')}
          </p>
        </div>
      </section>

      {cfg?.l1 && l1Live && <L1Band s={s} cfg={cfg} data={l1} live={l1Live} />}

    </>
  );
}

/**
 * Verification status, the size of a button: this browser re-ran every confirmed change and compared its root with
 * the contract's. Pressing it runs the check again.
 */
function Verify({ s, stale, onCheck }: { s: Snapshot; stale: boolean; onCheck?: () => Promise<number> }) {
  const state = stale ? 'unknown' : s.matches ? 'match' : 'mismatch';
  const [checking, setChecking] = useState(false);
  const [run, setRun] = useState(0);
  const label = checking ? 'Checking…' : { match: `Verified · ${s.head}/${s.head}`, mismatch: 'Does not match', unknown: 'Offline' }[state];
  const check = () => {
    if (!onCheck || checking) return;
    setChecking(true);
    // Reads the log from the chain again and re-runs every change; the pill then shows that fresh result.
    onCheck().finally(() => { setChecking(false); setRun((n) => n + 1); });
  };
  return (
    <button
      type="button"
      className={`verify ${state}`}
      onClick={check}
      disabled={!onCheck || state === 'unknown'}
      title="Your browser rebuilt the ledger from the chain and compared it. Press to check again."
      aria-busy={checking}
    >
      <Seal key={run} state={state} />
      <span>{label}</span>
      <svg className={checking ? 'again spin' : 'again'} viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3" /></svg>
    </button>
  );
}

/** With chain details on: the root, the latest proof's slots, and any replay issue. */
function VerifyDetails({ s }: { s: Snapshot }) {
  const latest = s.batches[s.batches.length - 1];
  const used = latest ? latest.toOp - latest.fromOp : 0;
  return (
    <>
      <div className="tech-only intro-tech">
        {s.matches ? (
          <span className="pair">Root <Hash value={toHex32(s.root)} /></span>
        ) : (
          <dl className="roots">
            <div><dt>Chain</dt><dd><Hash value={toHex32(s.root)} /></dd></div>
            <div><dt>Here</dt><dd><Hash value={toHex32(s.replayRoot)} /></dd></div>
          </dl>
        )}
        {latest && (
          <a className="intro-proof" href={`#batch/${latest.batchNo}`} aria-label={`Proof #${latest.batchNo}`}>
            <span className="lab">Latest proof #{latest.batchNo} · {used}/{K} slots</span>
            <SlotBar slots={batchSlots(latest, s.ops)} />
          </a>
        )}
      </div>
      {s.issues.length > 0 && <ul className="issues">{s.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
    </>
  );
}

/** Members as a leaderboard. `rankOf` keeps each member's place when the list is filtered. */
function MemberTable({ list, max, rankOf }: { list: Member[]; max: bigint; rankOf?: Map<number, number> }) {
  return (
    <Table className="t-members" head={[['Member'], ['Points', 'right'], ['Share', 'hide-m'], ['Last change', 'hide-m']]}>
      {list.map((m, i) => (
        <tr key={m.rowId}>
          <td>
            <a className="who" href={`#member/${m.rowId}`}>
              <Rank n={rankOf?.get(m.rowId) ?? i + 1} />
              <Avatar card={m.card} />
              <span className="card-id">{formatCard(m.card)}</span>
            </a>
          </td>
          <td className="mono right points">{formatAmount(m.balance)}</td>
          <td className="hide-m"><span className="bar"><i style={{ width: `${max > 0n ? Number((m.balance * 1000n) / max) / 10 : 0}%` }} /></span></td>
          <td className="hide-m">
            <span className="last">
              {m.lastChange ? <EventChange e={m.lastChange} /> : '—'}
              {m.waiting > 0 && <span className="status pending"><i aria-hidden="true" />{m.waiting} waiting</span>}
            </span>
          </td>
        </tr>
      ))}
    </Table>
  );
}

const KIND_GLYPH: Record<string, string> = { award: 'up', redeem: 'gift', correct: 'pen', join: 'join', leave: 'leave' };

/** A card's colour and last two digits: the same card looks the same on every page. */
const Avatar = ({ card, small }: { card: bigint; small?: boolean }) => (
  <span className={small ? 'avatar small' : 'avatar'} aria-hidden="true" style={{ ['--h' as string]: `${(Number(card) * 47) % 360}` }}>{card.toString().slice(-2).padStart(2, '0')}</span>
);

const Rank = ({ n }: { n: number }) => <span className={`rank r${n}`} aria-label={`Rank ${n}`}>{n}</span>;

function EventChange({ e }: { e: PointsEvent }) {
  const tone = e.kind === 'correct' ? 'warn' : e.kind === 'redeem' ? 'spend' : e.kind === 'award' ? 'earn' : '';
  return (
    <span className={`delta ${tone}${e.status === 'failed' ? ' struck' : ''}`}>
      <span className={`kind ${e.status === 'failed' ? 'failed' : tone || 'neutral'}`} aria-hidden="true"><Glyph name={KIND_GLYPH[e.kind] ?? 'plus'} /></span>
      <b className="mono">{changeLabel(e)}</b>
      {e.reason && <span className="reason">{e.reason}</span>}
    </span>
  );
}

/** A confirmed correction is never shown as a plain "Confirmed": it reads "Corrected", in the warning colour. */
function EventStatus({ e }: { e: PointsEvent }) {
  if (e.kind === 'correct' && e.status === 'applied') {
    return <span className="status corrected" title="A balance was overwritten. The change is permanent in this history, with both signers."><i aria-hidden="true" />Corrected</span>;
  }
  return <OpStatusLabel status={e.status} />;
}

/** Who asked for a change; for a co-signed correction, both signers. */
function Signers({ s, e }: { s: Snapshot; e: PointsEvent }) {
  return (
    <span className="signers">
      <Actor s={s} address={e.op.by} />
      {e.cosigner && <Actor s={s} address={e.cosigner} verb="+" />}
    </span>
  );
}

export function Members({ s }: PageProps) {
  const { members: list } = usePoints(s);
  const [query, setQuery] = useState('');
  const q = query.replace(/\D/g, '');
  const ranked = [...list].sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : a.rowId - b.rowId));
  const rankOf = new Map(ranked.map((m, i) => [m.rowId, i + 1]));
  const shown = q ? ranked.filter((m) => m.card.toString().includes(q.replace(/^0+/, '') || '0')) : ranked;
  const max = list.reduce((a, m) => (m.balance > a ? m.balance : a), 0n);
  return (
    <Section
      page
      title="Members"
      count={list.length}
      actions={(
        <div className="row-actions">
          <input className="mono find" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find card #" aria-label="Find a card" inputMode="numeric" />
          <a className="link raw-link tech-only" href="#data">Raw rows</a>
        </div>
      )}
    >
      {shown.length === 0 ? <Empty>{list.length ? 'No card matches.' : 'No members yet.'}</Empty> : <MemberTable list={shown} max={max} rankOf={rankOf} />}
    </Section>
  );
}

export function MemberDetail({ s, id }: PageProps & { id: number }) {
  const { events, members: list, proposals: allProposals } = usePoints(s);
  const m = list.find((x) => x.rowId === id);
  const history = events.filter((e) => e.rowId === id).reverse();
  const mine = allProposals.filter((p) => p.rowId === id);
  if (!m && history.length === 0) return <Missing what="This member" back="members" />;
  const card = m?.card ?? cardOf(id, s.ops);
  const proven = history.find((e) => e.status !== 'pending')?.op.batchNo;
  const corrected = history.filter((e) => e.kind === 'correct' && e.status === 'applied').length;
  const done = history.filter((e) => e.status === 'applied');
  const earned = done.filter((e) => e.kind === 'award' || e.kind === 'join').reduce((t, e) => t + (e.amount > 0n ? e.amount : 0n), 0n);
  const spent = done.filter((e) => e.kind === 'redeem').reduce((t, e) => t - e.amount, 0n);
  const rank = m ? [...list].sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : a.rowId - b.rowId)).findIndex((x) => x.rowId === m.rowId) + 1 : 0;
  return (
    <>
      <Back href="#members" label="Members" />
      <section className="member-hero">
        <WalletCard card={card} points={m?.balance} caption={m ? 'Member card' : 'Not proven yet'} />
        <div className="member-stats">
          <div className="member-proof">
            {corrected > 0 && <span className="status corrected"><i aria-hidden="true" />Corrected {corrected === 1 ? 'once' : `${corrected} times`}</span>}
            {proven !== undefined && <a className="status applied" href={`#batch/${proven}`}><i aria-hidden="true" />Proven<span className="tech-only">&nbsp;in #{proven}</span></a>}
            {m && m.waiting > 0 && <span className="status pending"><i aria-hidden="true" />{m.waiting} waiting</span>}
            {!m && <span className="status pending"><i aria-hidden="true" />Not proven yet</span>}
          </div>
          <dl className="mini-stats">
            <div><Glyph name="up" /><dt>Earned</dt><dd>{formatAmount(earned)}</dd></div>
            <div><Glyph name="gift" /><dt>Spent</dt><dd>{formatAmount(spent)}</dd></div>
            <div><Glyph name="people" /><dt>Rank</dt><dd>{rank ? `${rank} of ${list.length}` : '—'}</dd></div>
          </dl>
        </div>
      </section>
      <Section title="History" count={history.length + mine.length}>
        <Table className="t-history" head={[['When', 'hide-m'], ['Change'], ['Signed by'], ['Balance', 'right'], ['Status'], ['Proof', 'right hide-m tech-only']]}>
          {mine.map((p) => <ProposalRow key={`c${p.proposal.id}`} s={s} p={p} balance={m?.balance} />)}
          {history.map((e) => (
            <tr key={e.op.id} className={e.kind === 'correct' ? 'flag' : undefined}>
              <td className="note hide-m">{formatTime(e.op.timestamp)}</td>
              <td><EventChange e={e} /></td>
              <td><Signers s={s} e={e} /></td>
              <td className="mono right">{e.after !== undefined ? formatAmount(e.after) : '—'}</td>
              <td><EventStatus e={e} /></td>
              <td className="mono right hide-m tech-only">{e.op.batchNo === undefined ? '' : <a className="link" href={`#batch/${e.op.batchNo}`}>#{e.op.batchNo}</a>}</td>
            </tr>
          ))}
        </Table>
      </Section>
    </>
  );
}

/** A proposed change that never reached the queue: one signature so far, or refused. The balance did not move. */
function ProposalRow({ s, p, balance }: { s: Snapshot; p: UnqueuedProposal; balance?: bigint }) {
  const open = p.proposal.status === 'open';
  const label = p.kind === 'leave' ? 'Remove member'
    : p.kind === 'redeem' ? `−${formatAmount(p.amount)}`
      : `${balance !== undefined ? formatAmount(balance) : '?'} → ${formatAmount(p.amount)}`;
  return (
    <tr className={open ? 'flag' : 'declined'}>
      <td className="note hide-m">{formatTime(p.proposal.timestamp)}</td>
      <td>
        <span className={`delta ${p.kind === 'redeem' ? 'spend' : 'warn'}${open ? '' : ' struck'}`}>
          <b className="mono">{label}</b>
          <span className="reason">{p.kind === 'redeem' ? p.reason ?? 'Redemption' : 'Correction'}</span>
        </span>
      </td>
      <td>
        <span className="signers">
          <Actor s={s} address={p.proposal.proposer} />
          {!open && <Actor s={s} address={p.proposal.decidedBy} verb="refused by" />}
        </span>
      </td>
      <td className="mono right">{balance !== undefined ? formatAmount(balance) : '—'}</td>
      <td>{open
        ? <span className="status needs"><i aria-hidden="true" />Needs auditor</span>
        : <span className="status failed"><i aria-hidden="true" />Declined</span>}</td>
      <td className="hide-m tech-only" />
    </tr>
  );
}

const Result = ({ b }: { b: BatchView }) => (
  <span className="result">
    <span className="chip-n good" title={`${b.applied} accepted`}>✓ {b.applied}</span>
    {b.failed > 0 && <span className="chip-n bad" title={`${b.failed} rejected`}>✕ {b.failed}</span>}
  </span>
);

/** "0.168 nAVAX" → the number to read, the unit quiet beside it. */
const Qty = ({ text }: { text: string }) => {
  const m = /^([\d.,]+)\s*(.*)$/.exec(text);
  return m ? <span className="qty"><b>{m[1]}</b>{m[2] && <small>{m[2]}</small>}</span> : <span className="qty none">{text}</span>;
};

const TxLink = ({ hash, cfg }: { hash: string; cfg?: ChainConfig }) => (cfg?.explorer
  ? <a className="link ext mono" href={`${cfg.explorer}/tx/${hash}`} target="_blank" rel="noreferrer">{hash.slice(0, 8)}… ↗</a>
  : <Hash value={hash} />);

/**
 * What happened to this proof's root on the other L1. "Received" means Teleporter there has the message; "stored"
 * would need a receiving contract, and none is deployed yet, so Teleporter keeps the message as not executed.
 */
function RelayStatus({ s, b, cfg, deliveries = {}, links }: { s: Snapshot; b: BatchView; cfg: ChainConfig; deliveries?: Record<string, Delivery>; links?: boolean }) {
  const relay = s.relays.find((r) => r.batchNo === b.batchNo);
  if (!relay) {
    const later = s.relays.some((r) => r.batchNo > b.batchNo);
    return <span className="note">{later ? 'Superseded by a later root' : 'Not sent yet'}</span>;
  }
  const d = deliveries[relay.messageId];
  const label = !d?.delivered ? (d ? 'Sent, waiting for the relayer' : 'Sent')
    : d.executed ? 'Stored by the mirror'
      : links ? `Received by Teleporter on ${cfg.icm?.name.replace(/ L1$/, '') ?? 'the other L1'}, not executed (receiver not deployed)` : 'Received, not executed';
  return (
    <span className="onchain">
      <span className={`status ${d?.delivered ? (d.executed ? 'delivered' : 'needs') : 'pending'}`}><i aria-hidden="true" />{label}</span>
      {links && <a className="link ext" href={`${cfg.explorer}/tx/${relay.txHash}`} target="_blank" rel="noreferrer">sent ↗</a>}
      {links && d?.txHash && cfg.icm?.explorer && <a className="link ext" href={`${cfg.icm.explorer}/tx/${d.txHash}`} target="_blank" rel="noreferrer">received ↗</a>}
    </span>
  );
}

/** Where this proof's root stands on the school L1: sent by RootRelay on Fuji, stored by RootMirror there. */
function L1RootStatus({ b, cfg, l1, l1Live, links }: { b: BatchView; cfg: ChainConfig; links?: boolean } & L1Props) {
  const sent = l1?.roots.find((r) => r.batchNo === b.batchNo);
  const stored = l1Live?.mirrored.find((m) => m.batchNo === b.batchNo);
  if (!sent && !stored) {
    if (!l1) return <span className="note">—</span>;
    const first = l1.roots.reduce((min, r) => Math.min(min, r.batchNo), Infinity);
    return <span className="note">{b.batchNo < first ? 'Before the L1 link' : l1.roots.some((r) => r.batchNo > b.batchNo) ? 'Superseded by a later root' : 'Not sent yet'}</span>;
  }
  return (
    <span className="onchain">
      {stored
        ? <span className="status delivered"><i aria-hidden="true" />{links ? 'Stored by RootMirror on the L1' : 'Stored on the L1'}</span>
        : <span className="status pending"><i aria-hidden="true" />{l1Live ? 'Sent, waiting for the relayer' : 'Sent'}</span>}
      {links && sent && <a className="link ext" href={`${cfg.explorer}/tx/${sent.txHash}`} target="_blank" rel="noreferrer">sent ↗</a>}
      {links && stored && <span className="note">L1 tx <L1Tx hash={stored.txHash} /></span>}
    </span>
  );
}

export function Batches({ s, cfg, meta = {}, deliveries, l1, l1Live }: PageProps & L1Props) {
  return (
    <Section page title="Proofs" count={s.batches.length} note="Up to 16 changes per proof">
      {s.batches.length === 0 ? <Empty>No proofs yet.</Empty> : (
        <Table head={[['Proof'], ['Changes'], ['Result'], ['Gas', 'right hide-m tech-only'], ...(cfg?.currency ? [['Fee', 'right'] as [string, string]] : []), ['Proved in', 'right hide-m'], ...(cfg?.l1 ? [[`On ${cfg.l1.name}`, 'hide-m tech-only'] as [string, string]] : []), ...(cfg?.icm ? [[`Sent to ${cfg.icm.name}`, 'hide-m tech-only'] as [string, string]] : []), ['Transaction', 'hide-m tech-only']]}>
          {[...s.batches].reverse().map((b) => (
            <tr key={b.batchNo}>
              <td><a className="proof-id" href={`#batch/${b.batchNo}`}>#{b.batchNo}</a></td>
              <td><SlotBar slots={batchSlots(b, s.ops)} small /></td>
              <td><Result b={b} /></td>
              <td className="mono right hide-m tech-only">{formatGas(b.gasUsed)}</td>
              {cfg?.currency && <td className="right"><Qty text={formatFee(b.fee, cfg.currency)} /></td>}
              <td className="right hide-m"><Qty text={formatMs(meta[rootKey(b.newRoot)]?.provingMs)} /></td>
              {cfg?.l1 && <td className="hide-m tech-only"><L1RootStatus b={b} cfg={cfg} l1={l1} l1Live={l1Live} /></td>}
              {cfg?.icm && <td className="hide-m tech-only"><RelayStatus s={s} b={b} cfg={cfg} deliveries={deliveries} /></td>}
              <td className="hide-m tech-only"><TxLink hash={b.txHash} cfg={cfg} /></td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

export function BatchDetail({ s, batchNo, cfg, meta = {}, deliveries, priceRef, l1, l1Live }: PageProps & L1Props & { batchNo: number }) {
  const b = s.batches.find((x) => x.batchNo === batchNo);
  if (!b) return <Missing what={`Proof #${batchNo}`} back="batches" />;
  const ops = s.ops.filter((o) => o.batchNo === batchNo);
  const slots = batchSlots(b, s.ops);
  const m = meta[rootKey(b.newRoot)];
  return (
    <>
      <Back href="#batches" label="All proofs" />
      <Section page title={`Proof #${b.batchNo}`} note={<>{formatTime(b.timestamp)} · {b.applied} {b.applied === 1 ? 'change' : 'changes'} in{b.failed > 0 ? `, ${b.failed} rejected` : ''}{cfg?.explorer && <> · <a className="link ext" href={`${cfg.explorer}/tx/${b.txHash}`} target="_blank" rel="noreferrer">See it on-chain ↗</a></>}</>}>
        <div className="box padded slot-panel"><SlotBar slots={slots} /><SlotLegend slots={slots} /></div>
      </Section>
      <section className="tiles fit" aria-label="Cost and timing">
        {cfg?.currency && (
          <div className="box tile">
            <div className="lab">Fee paid</div>
            <div className="big fee">{formatFee(b.fee, cfg.currency)}</div>
            {priceRef && <p className="note tech-only">{atRefPrice(b.gasUsed, priceRef, cfg.currency)}</p>}
          </div>
        )}
        <div className="box tile tech-only"><div className="lab">Gas</div><div className="big fee">{formatGas(b.gasUsed)}</div></div>
        {m?.provingMs !== undefined && <div className="box tile"><div className="lab">Proved in</div><div className="big fee">{formatMs(m.provingMs)}</div></div>}
        {m?.confirmMs !== undefined && <div className="box tile"><div className="lab">Confirmed in</div><div className="big fee">{formatMs(m.confirmMs)}</div></div>}
      </section>
      <div className="tech-only">
        <KeyValues items={[
          ['Transaction', <OnChain value={b.txHash} kind="tx" />],
          ['Root after', <Hash value={toHex32(b.newRoot)} />],
          ...(cfg?.l1 ? [[`Root on ${cfg.l1.name} (ICM)`, <L1RootStatus b={b} cfg={cfg} l1={l1} l1Live={l1Live} links />] as [string, ReactNode]] : []),
          ...(cfg?.icm ? [[`Root sent to ${cfg.icm.name} (ICM)`, <RelayStatus s={s} b={b} cfg={cfg} deliveries={deliveries} links />] as [string, ReactNode]] : []),
        ]} />
      </div>
      <Section title="Changes" count={ops.length}><ChangesTable s={s} ops={ops} /></Section>
    </>
  );
}

type Filter = 'all' | OpStatus;
const FILTERS: [Filter, string][] = [['all', 'All'], ['applied', STATUS.applied], ['failed', STATUS.failed], ['pending', STATUS.pending]];

export function Ops({ s }: PageProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const shown = [...s.ops].reverse().filter((o) => filter === 'all' || o.status === filter);
  return (
    <Section
      page
      title="History"
      count={s.ops.length}
      actions={
        <div className="filters" role="group" aria-label="Filter changes by status">
          {FILTERS.map(([k, label]) => (
            <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
              <i aria-hidden="true" />{label}
            </button>
          ))}
        </div>
      }
    >
      {shown.length === 0 ? <Empty>{s.ops.length === 0 ? 'No changes yet.' : `No ${STATUS[filter as OpStatus].toLowerCase()} changes.`}</Empty> : <ChangesTable s={s} ops={shown} />}
    </Section>
  );
}

/** Every change, in points language when it touches the points program and as a raw op otherwise. */
function ChangesTable({ s, ops }: { s: Snapshot; ops: OpView[] }) {
  const all = s.ops;
  const byOp = useMemo(() => new Map(pointsEvents(all, s.proposals).map((e) => [e.op.id, e])), [all, s.proposals]);
  return (
    <Table className="t-changes" head={[['#', 'tech-only'], ['Status'], ['Card'], ['Change'], ['Signed by', 'hide-m'], ['When', 'hide-m'], ['Proof', 'hide-m right tech-only']]}>
      {ops.map((o) => {
        const e = byOp.get(o.id);
        const card = e ? cardOf(e.rowId, all) : undefined;
        // A visitor's trial card: same ledger, its own table. Named here so it does not read as a raw row.
        const trial = e ? null : trialChange(o.op, all);
        return (
          <tr key={o.id} className={e?.kind === 'correct' ? 'flag' : undefined}>
            <td className="mono tech-only"><a className="link" href={`#op/${o.id}`}>#{o.id}</a></td>
            <td>{e ? <EventStatus e={e} /> : <OpStatusLabel status={o.status} />}</td>
            <td>{e && card !== undefined
              ? <a className="who" href={`#member/${e.rowId}`}><Avatar card={card} small /><span className="card-id">{formatCard(card)}</span></a>
              : <a className="who muted" href={`#row/${o.op[1]}`}><span className="card-id">{trial ? 'Trial' : 'Row'} #{o.op[1].toString()}</span></a>}</td>
            <td className="change">{e ? <EventChange e={e} /> : trial ?? describeOp(o.op)}</td>
            <td className="hide-m">{e ? <Signers s={s} e={e} /> : <Actor s={s} address={o.by} />}</td>
            <td className="note hide-m">{ago(o.timestamp)}</td>
            <td className="mono hide-m right tech-only">{o.batchNo === undefined ? '' : <a className="link" href={`#batch/${o.batchNo}`}>#{o.batchNo}</a>}</td>
          </tr>
        );
      })}
    </Table>
  );
}

export function OpDetail({ s, id }: PageProps & { id: number }) {
  const o = s.ops.find((x) => x.id === id);
  const e = useMemo(() => pointsEvents(s.ops, s.proposals).find((x) => x.op.id === id), [s, id]);
  if (!o) return <Missing what={`Change #${id}`} back="ops" />;
  const card = e ? cardOf(e.rowId, s.ops) : undefined;
  return (
    <>
      <Back href="#ops" label="History" />
      <Section page title={`Change #${o.id}`} note={e ? undefined : `${actionName(o.op)} · ${describeOp(o.op)}`}>
        <KeyValues items={[
          ...(e ? [['Change', <EventChange e={e} />] as [string, ReactNode]] : []),
          ['Status', e ? <EventStatus e={e} /> : <OpStatusLabel status={o.status} />],
          ['Signed by', <Actor s={s} address={o.by} />],
          ...(e?.cosigner ? [['Co-signed by', <Actor s={s} address={e.cosigner} />] as [string, ReactNode]] : []),
          [e ? 'Member' : 'Row', e && card !== undefined
            ? <a className="link mono" href={`#member/${e.rowId}`}>{formatCard(card)}</a>
            : <a className="link mono" href={`#row/${o.op[1]}`}>{o.op[1].toString()}</a>],
          ...(e?.after !== undefined ? [['Balance', <span className="mono">{formatAmount(e.before ?? 0n)} → {formatAmount(e.after)}</span>] as [string, ReactNode]] : []),
          ['Proof', o.batchNo === undefined ? '—' : <a className="link mono" href={`#batch/${o.batchNo}`}>#{o.batchNo}</a>],
          ['Queued', formatTime(o.timestamp)],
          ['Transaction', <OnChain value={o.txHash} kind="tx" />],
        ]} />
      </Section>
      <Details label="Encoded op">
        <code className="encoded">[{o.op.map((v) => v.toString()).join(', ')}]</code>
      </Details>
    </>
  );
}

export function Data({ s }: PageProps) {
  const tables = [...new Set(s.rows.map((r) => r.table))].sort((a, b) => (a < b ? -1 : 1));
  const [table, setTable] = useState<bigint | null>(null);
  const shown = table === null ? s.rows : s.rows.filter((r) => r.table === table);
  return (
    <>
      <Back href="#members" label="Members" />
      <Section
        page
        title="Raw rows"
        count={shown.length}
        actions={tables.length > 0 && (
          <div className="filters" role="group" aria-label="Filter rows by table">
            <button type="button" aria-pressed={table === null} onClick={() => setTable(null)}><i aria-hidden="true" />All tables</button>
            {tables.map((t) => (
              <button key={t.toString()} type="button" aria-pressed={table === t} onClick={() => setTable(t)}><i aria-hidden="true" />Table {formatField(t)}</button>
            ))}
          </div>
        )}
      >
        {shown.length === 0 ? <Empty>No rows yet.</Empty> : (
          <Table head={[['Row', 'right'], ['Table', 'right'], ...FIELD_NAMES.map((n) => [n, 'right'] as [string, string])]}>
            {shown.map((r) => (
              <tr key={r.rowId}>
                <td className="mono right"><a className="link" href={`#row/${r.rowId}`}>{r.rowId}</a></td>
                <td className="mono right">{formatField(r.table)}</td>
                {r.fields.map((f, i) => <td key={i} className={f === 0n ? 'mono right zero' : 'mono right'}>{formatField(f)}</td>)}
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </>
  );
}

export function RowDetail({ s, id }: PageProps & { id: number }) {
  if (id >= s.nextRowId) return <Missing what={`Row ${id}`} back="data" />;
  const row = s.rows.find((r) => r.rowId === id);
  const history = s.ops.filter((o) => o.op[1] === BigInt(id)).reverse();
  const queuedOnly = !row && history.every((o) => o.status === 'pending');
  return (
    <>
      <Back href="#data" label="Raw rows" />
      <Section page title={`Row ${id}`} note={row ? `Table ${formatField(row.table)}` : queuedOnly ? 'Waiting for its first proof' : 'Deleted'}>
        {row ? (
          <Table head={FIELD_NAMES.map((n) => [n, 'right'] as [string, string])}>
            <tr>{row.fields.map((f, i) => <td key={i} className={f === 0n ? 'mono right zero' : 'mono right'}>{formatField(f)}</td>)}</tr>
          </Table>
        ) : <Empty>No confirmed value.</Empty>}
      </Section>
      <Section title="History" count={history.length}><ChangesTable s={s} ops={history} /></Section>
    </>
  );
}

/** "just now", "5 min ago", "3 h ago", then the date. */
export function ago(ts?: number, now = Date.now()): string {
  if (ts === undefined) return '';
  const s = Math.max(0, Math.round(now / 1000 - ts));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const Back = ({ href, label }: { href: string; label: string }) => <a className="link back" href={href}>← {label}</a>;

function Missing({ what, back }: { what: string; back: string }) {
  return (
    <>
      <Back href={`#${back}`} label="Back" />
      <Empty>{what} does not exist.</Empty>
    </>
  );
}

