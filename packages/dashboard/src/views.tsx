import { useMemo, useState, type ReactNode } from 'react';
import type { ChainConfig, Snapshot } from './chain';
import { actionName, describeOp, FIELD_NAMES, formatAmount, formatFee, formatField, formatGas, formatGasShort, formatTime, plural, toHex32 } from './format';
import { cardOf, changeLabel, formatCard, members, pointsEvents, PROGRAM, trialChange, unqueuedProposals, type Member, type PointsEvent, type UnqueuedProposal } from './points';
import { batchSlots, nextBatchSlots, type BatchView, type OpStatus, type OpView } from './replay';
import { Actor, Details, Empty, Hash, K, KeyValues, OnChain, OpStatusLabel, Section, SlotBar, SlotLegend, STATUS, Table } from './ui';
import type { Delivery } from './useIcm';
import { atRefPrice, type PriceRef } from './usePriceRef';
import { formatMs, rootKey, type ProofMetaMap } from './useProofMeta';
import { HeroArt } from './art';
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
  const { events, members: list } = usePoints(s);
  const latest = s.batches[s.batches.length - 1];
  const confirmMs = latest ? meta[rootKey(latest.newRoot)]?.confirmMs : undefined;
  const total = list.reduce((sum, m) => sum + m.balance, 0n);
  const fees = s.batches.map((b) => b.fee).filter((f): f is bigint => f !== undefined);
  const gas = s.batches.map((b) => b.gasUsed).filter((g): g is bigint => g !== undefined);
  const top = [...list].sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : a.rowId - b.rowId)).slice(0, 6);
  return (
    <>
      <section className="box hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <span className="eyebrow"><i className={stale ? 'dot off' : 'dot on'} aria-hidden="true" />{PROGRAM.club} · {cfg?.network ?? 'local chain'}</span>
          <h1 id="hero-title">Every point,<br /><em>proven.</em></h1>
          <Intro s={s} stale={stale} onCheck={onCheck} />
        </div>
        <div className="hero-art"><HeroArt /></div>
      </section>
      {cfg?.l1 && l1Live && <L1Band s={s} cfg={cfg} data={l1} live={l1Live} />}
      <section className="tiles four" aria-label="Summary">
        <a className="box tile" href="#members">
          <div className="lab">Members</div>
          <div className="big">{list.length}</div>
          <p className="note">{plural(s.batchCount, 'proof')} so far</p>
        </a>
        <a className="box tile" href="#members">
          <div className="lab">Points held</div>
          <div className="big">{formatAmount(total)}</div>
          <p className="note">avg {formatAmount(list.length ? total / BigInt(list.length) : 0n)} per member</p>
        </a>
        <a className="box tile" href="#admin">
          <div className="lab">Waiting</div>
          <div className="big">{s.pending}<span className="of mono">/{K}</span></div>
          <SlotBar slots={nextBatchSlots(s.ops)} small />
        </a>
        <a className="box tile" href="#batches">
          <div className="lab">Gas per proof</div>
          <div className="big fee">{formatGasShort(average(gas))}</div>
          <p className="note">
            {[
              confirmMs !== undefined ? `confirmed in ${formatMs(confirmMs)}` : '',
              atRefPrice(average(gas), priceRef, cfg?.currency) ?? (cfg?.currency && fees.length ? `fee ${formatFee(average(fees), cfg.currency)}` : ''),
            ].filter(Boolean).join(' · ')}
          </p>
        </a>
      </section>
      <div className="columns">
        <Section title="Top members" actions={<a className="link" href="#members">All {list.length}</a>}>
          {top.length === 0 ? <Empty>No members yet.</Empty> : <MemberTable list={top} max={top[0]?.balance ?? 0n} />}
        </Section>
        <Section title="Activity" actions={<a className="link" href="#ops">All {s.ops.length}</a>}>
          {events.length === 0 ? <Empty>No activity yet.</Empty> : <EventList events={[...events].reverse().slice(0, 6)} ops={s.ops} />}
        </Section>
      </div>
    </>
  );
}

/**
 * Verification status: this browser re-ran every confirmed change and compares the root it got with the root the
 * contract holds. Below it, the slots of the latest proof.
 */
function Intro({ s, stale, onCheck }: { s: Snapshot; stale: boolean; onCheck?: () => Promise<number> }) {
  const state = stale ? 'unknown' : s.matches ? 'match' : 'mismatch';
  const verdict = { match: 'Data verified', mismatch: 'Data does not match', unknown: 'Offline' }[state];
  const latest = s.batches[s.batches.length - 1];
  const used = latest ? latest.toOp - latest.fromOp : 0;
  const [checked, setChecked] = useState<string | null>(null);
  const check = () => {
    setChecked('Checking…');
    // Reads the log from the chain again and re-runs every change; the verdict above is then that fresh result.
    onCheck?.().then((ms) => setChecked(`Checked again in ${formatMs(ms)}`), () => setChecked('Could not reach the chain'));
  };
  return (
    <div className={`intro ${state}`}>
      <div className="intro-head">
        <div className="verdict">
          <svg className="mark" viewBox="0 0 16 16" aria-hidden="true">
            {state === 'match' && <path d="M3 8.5 6.5 12 13 4.5" />}
            {state === 'mismatch' && <path d="M4 4l8 8M12 4l-8 8" />}
            {state === 'unknown' && <path d="M3 8h10" />}
          </svg>
          <div>
            <h1>{verdict}</h1>
            {state !== 'unknown' && (
              <p className="note how">
                {plural(s.head, 'change')} replayed in this browser{state === 'match' ? ', root matches' : ', root differs'}.
                {onCheck && <> <button type="button" className="textlink" onClick={check}>{checked ?? 'Check again'}</button></>}
              </p>
            )}
          </div>
        </div>
        {state === 'mismatch' ? (
          <dl className="roots">
            <div><dt>Chain</dt><dd><Hash value={toHex32(s.root)} /></dd></div>
            <div><dt>Here</dt><dd><Hash value={toHex32(s.replayRoot)} /></dd></div>
          </dl>
        ) : (
          <span className="pair">Root <Hash value={toHex32(s.root)} /></span>
        )}
      </div>
      {latest && (
        <a className="intro-proof" href={`#batch/${latest.batchNo}`} aria-label={`Proof #${latest.batchNo}`}>
          <span className="lab">Latest proof #{latest.batchNo} · {used}/{K} slots</span>
          <SlotBar slots={batchSlots(latest, s.ops)} />
          <SlotLegend slots={batchSlots(latest, s.ops)} />
        </a>
      )}
      {s.issues.length > 0 && <ul className="issues">{s.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
    </div>
  );
}

function MemberTable({ list, max }: { list: Member[]; max: bigint }) {
  return (
    <Table className="t-members" head={[['Card'], ['Points', 'right'], ['Share', 'hide-m'], ['Last change', 'hide-m']]}>
      {list.map((m) => (
        <tr key={m.rowId}>
          <td className="mono"><a className="link" href={`#member/${m.rowId}`}>{formatCard(m.card)}</a></td>
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

function EventChange({ e }: { e: PointsEvent }) {
  const tone = e.kind === 'correct' ? 'warn' : e.kind === 'redeem' ? 'spend' : e.kind === 'award' ? 'earn' : '';
  return (
    <span className={`delta ${tone}${e.status === 'failed' ? ' struck' : ''}`}>
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

function EventList({ events, ops }: { events: PointsEvent[]; ops: OpView[] }) {
  return (
    <ul className="events box">
      {events.map((e) => {
        const card = cardOf(e.rowId, ops);
        return (
          <li key={e.op.id}>
            <a className="mono link card" href={`#member/${e.rowId}`}>{card !== undefined ? formatCard(card) : `Row ${e.rowId}`}</a>
            <EventChange e={e} />
            <span className="when note">{ago(e.op.timestamp)}</span>
            <EventStatus e={e} />
          </li>
        );
      })}
    </ul>
  );
}

export function Members({ s }: PageProps) {
  const { members: list } = usePoints(s);
  const [query, setQuery] = useState('');
  const q = query.replace(/\D/g, '');
  const shown = q ? list.filter((m) => m.card.toString().includes(q.replace(/^0+/, '') || '0')) : list;
  const max = list.reduce((a, m) => (m.balance > a ? m.balance : a), 0n);
  return (
    <Section
      page
      title="Members"
      count={list.length}
      actions={(
        <div className="row-actions">
          <input className="mono find" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Card #" aria-label="Find a card" inputMode="numeric" />
          <a className="link raw-link" href="#data">Raw rows</a>
        </div>
      )}
    >
      {shown.length === 0 ? <Empty>{list.length ? 'No card matches.' : 'No members yet.'}</Empty> : <MemberTable list={shown} max={max} />}
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
  return (
    <>
      <Back href="#members" label="Members" />
      <section className="box member-head">
        <div>
          <div className="lab">Card</div>
          <h1 className="mono">{card !== undefined ? formatCard(card) : `Row ${id}`}</h1>
        </div>
        <div className="balance">
          <div className="lab">Points</div>
          <div className="big">{m ? formatAmount(m.balance) : '—'}</div>
        </div>
        <div className="member-proof">
          {corrected > 0 && <span className="status corrected"><i aria-hidden="true" />Corrected {corrected === 1 ? 'once' : `${corrected} times`}</span>}
          {proven !== undefined && <a className="status applied" href={`#batch/${proven}`}><i aria-hidden="true" />Proven in #{proven}</a>}
          {m && m.waiting > 0 && <span className="status pending"><i aria-hidden="true" />{m.waiting} waiting</span>}
          {!m && <span className="status pending"><i aria-hidden="true" />Not proven yet</span>}
        </div>
      </section>
      <Section title="History" count={history.length + mine.length}>
        <Table className="t-history" head={[['When', 'hide-m'], ['Change'], ['Signed by'], ['Balance', 'right'], ['Status'], ['Proof', 'right hide-m']]}>
          {mine.map((p) => <ProposalRow key={`c${p.proposal.id}`} s={s} p={p} balance={m?.balance} />)}
          {history.map((e) => (
            <tr key={e.op.id} className={e.kind === 'correct' ? 'flag' : undefined}>
              <td className="note hide-m">{formatTime(e.op.timestamp)}</td>
              <td><EventChange e={e} /></td>
              <td><Signers s={s} e={e} /></td>
              <td className="mono right">{e.after !== undefined ? formatAmount(e.after) : '—'}</td>
              <td><EventStatus e={e} /></td>
              <td className="mono right hide-m">{e.op.batchNo === undefined ? '' : <a className="link" href={`#batch/${e.op.batchNo}`}>#{e.op.batchNo}</a>}</td>
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
      <td className="hide-m" />
    </tr>
  );
}

const Result = ({ b }: { b: BatchView }) => (
  <span className="result mono"><span className="good">{b.applied}</span>{b.failed > 0 && <> · <span className="bad">{b.failed}</span></>}</span>
);

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
    <Section page title="Proofs" count={s.batches.length}>
      {s.batches.length === 0 ? <Empty>No proofs yet.</Empty> : (
        <Table head={[['Proof'], ['Slots'], ['Result'], ['Gas', 'right hide-m'], ...(cfg?.currency ? [['Fee', 'right'] as [string, string]] : []), ['Proved in', 'right hide-m'], ...(cfg?.l1 ? [[`Root on ${cfg.l1.name}`, 'hide-m'] as [string, string]] : []), ...(cfg?.icm ? [[`Root sent to ${cfg.icm.name}`, 'hide-m'] as [string, string]] : []), ['Transaction', 'hide-m']]}>
          {[...s.batches].reverse().map((b) => (
            <tr key={b.batchNo}>
              <td className="mono"><a className="link" href={`#batch/${b.batchNo}`}>#{b.batchNo}</a></td>
              <td><SlotBar slots={batchSlots(b, s.ops)} small /></td>
              <td><Result b={b} /></td>
              <td className="mono right hide-m">{formatGas(b.gasUsed)}</td>
              {cfg?.currency && <td className="mono right">{formatFee(b.fee, cfg.currency)}</td>}
              <td className="mono right hide-m">{formatMs(meta[rootKey(b.newRoot)]?.provingMs)}</td>
              {cfg?.l1 && <td className="hide-m"><L1RootStatus b={b} cfg={cfg} l1={l1} l1Live={l1Live} /></td>}
              {cfg?.icm && <td className="hide-m"><RelayStatus s={s} b={b} cfg={cfg} deliveries={deliveries} /></td>}
              <td className="hide-m"><TxLink hash={b.txHash} cfg={cfg} /></td>
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
      <Section page title={`Proof #${b.batchNo}`} note={formatTime(b.timestamp)}>
        <div className="box padded slot-panel"><SlotBar slots={slots} /><SlotLegend slots={slots} /></div>
      </Section>
      <section className="tiles fit" aria-label="Cost and timing">
        {cfg?.currency && (
          <div className="box tile">
            <div className="lab">Fee paid</div>
            <div className="big fee">{formatFee(b.fee, cfg.currency)}</div>
            {priceRef && <p className="note mono">{atRefPrice(b.gasUsed, priceRef, cfg.currency)}</p>}
          </div>
        )}
        <div className="box tile"><div className="lab">Gas</div><div className="big fee">{formatGas(b.gasUsed)}</div></div>
        <div className="box tile"><div className="lab">Proved in</div><div className="big fee">{formatMs(m?.provingMs)}</div></div>
        <div className="box tile"><div className="lab">Confirmed in</div><div className="big fee">{formatMs(m?.confirmMs)}</div></div>
      </section>
      <KeyValues items={[
        ['Transaction', <OnChain value={b.txHash} kind="tx" />],
        ['Root after', <Hash value={toHex32(b.newRoot)} />],
        ...(cfg?.l1 ? [[`Root on ${cfg.l1.name} (ICM)`, <L1RootStatus b={b} cfg={cfg} l1={l1} l1Live={l1Live} links />] as [string, ReactNode]] : []),
        ...(cfg?.icm ? [[`Root sent to ${cfg.icm.name} (ICM)`, <RelayStatus s={s} b={b} cfg={cfg} deliveries={deliveries} links />] as [string, ReactNode]] : []),
      ]} />
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
      title="Activity"
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
    <Table className="t-changes" head={[['#'], ['Status'], ['Member'], ['Change'], ['Signed by', 'hide-m'], ['When', 'hide-m'], ['Proof', 'hide-m right']]}>
      {ops.map((o) => {
        const e = byOp.get(o.id);
        const card = e ? cardOf(e.rowId, all) : undefined;
        // A visitor's trial card: same ledger, its own table. Named here so it does not read as a raw row.
        const trial = e ? null : trialChange(o.op, all);
        return (
          <tr key={o.id} className={e?.kind === 'correct' ? 'flag' : undefined}>
            <td className="mono"><a className="link" href={`#op/${o.id}`}>#{o.id}</a></td>
            <td>{e ? <EventStatus e={e} /> : <OpStatusLabel status={o.status} />}</td>
            <td className="mono">{e && card !== undefined ? <a className="link" href={`#member/${e.rowId}`}>{formatCard(card)}</a> : <a className="link note" href={`#row/${o.op[1]}`}>{trial ? 'trial' : 'row'} {o.op[1].toString()}</a>}</td>
            <td className="change">{e ? <EventChange e={e} /> : trial ?? describeOp(o.op)}</td>
            <td className="hide-m">{e ? <Signers s={s} e={e} /> : <Actor s={s} address={o.by} />}</td>
            <td className="note hide-m">{ago(o.timestamp)}</td>
            <td className="mono hide-m right">{o.batchNo === undefined ? '' : <a className="link" href={`#batch/${o.batchNo}`}>#{o.batchNo}</a>}</td>
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
      <Back href="#ops" label="Activity" />
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

