import { useState, type FormEvent, type ReactNode } from 'react';
import { createPublicClient, http, type Abi, type Address } from 'viem';
import { relayAbi, zkdbAbi, type ChainConfig, type ProposedChange, type Snapshot } from './chain';
import { friendlyError } from './errors';
import { parseAddress, parseEnrolCode, parseField, parseFieldIndex, parseRequired, parseRowId, parseU64 } from './forms';
import { FIELD_NAMES, fieldName, formatField, plural } from './format';
import { nextBatchSlots } from './replay';
import { Actor, Details, Empty, Hash, K, OnChain, KeyValues, Section, SlotBar } from './ui';
import { proveNextBatch, recordConfirmation, type Wallet } from './wallet';
import { formatMs, META_EVENT } from './useProofMeta';
import { BALANCE_FIELD, cardOf, EARN_REASONS, formatCard, members, pointsEvents, PROGRAM, reasonLabel, REASON_SLOT, REASONS, SPEND_REASONS, TRIAL_TABLE, type ReasonKey } from './points';
import { formatAmount } from './format';
import { rolesOf } from './roles';
import { ago } from './views';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

interface Sent { hash: `0x${string}`; confirmMs: number }
type TxState = { kind: 'idle' } | { kind: 'busy'; label: string } | { kind: 'done'; label: string; hash?: string } | { kind: 'error'; message: string };

export function useTx(cfg: ChainConfig, wallet: Wallet | null, onDone: () => void) {
  const [state, setState] = useState<TxState>({ kind: 'idle' });

  /** Simulates first, so a call the contract would reject explains itself and costs no gas. */
  async function send(functionName: string, args: readonly unknown[], doneLabel: string | ((r: Sent) => string), target?: { address: Address; abi: Abi }): Promise<Sent> {
    if (!wallet) throw new Error('Reconnect your wallet first.');
    const pub = createPublicClient({ transport: http(cfg.rpcUrl), pollingInterval: 500 });
    const call = { address: target?.address ?? cfg.address, abi: target?.abi ?? zkdbAbi, functionName, args, account: wallet.address } as never;
    setState({ kind: 'busy', label: 'Simulating…' });
    await pub.simulateContract(call);
    setState({ kind: 'busy', label: wallet.kind === 'browser' ? 'Confirm in your wallet…' : 'Sending…' });
    const hash = await wallet.client.writeContract({ ...(call as object), chain: null } as never);
    // Confirmation time: from the moment the transaction is broadcast until its receipt is available.
    const sentAt = performance.now();
    setState({ kind: 'busy', label: 'Confirming…' });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('The transaction reverted.');
    const sent = { hash, confirmMs: Math.round(performance.now() - sentAt) };
    setState({ kind: 'done', label: typeof doneLabel === 'string' ? doneLabel : doneLabel(sent), hash });
    onDone();
    return sent;
  }

  const run = (work: () => Promise<unknown>) => work().catch((e) => setState({ kind: 'error', message: friendlyError(e) }));
  return { state, setState, send, run };
}

export function TxStatus({ state }: { state: TxState }) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'busy') return <p className="tx busy" role="status">{state.label}</p>;
  if (state.kind === 'error') return <p className="tx error" role="alert">{state.message}</p>;
  return <p className="tx done" role="status">{state.label}{state.hash && <> <OnChain value={state.hash} kind="tx" /></>}</p>;
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <p className="note">{hint}</p>}
    </div>
  );
}

export function Admin({ s, cfg, address, wallet, onSignIn, onChanged }: {
  s: Snapshot; cfg: ChainConfig; address: Address | null; wallet: Wallet | null; onSignIn: () => void; onChanged: () => void;
}) {
  const roles = rolesOf(s, address);
  const isOwner = roles.includes('Owner');
  const isWriter = roles.includes('Treasurer') || roles.includes('Writer');
  const isAuditor = roles.includes('Auditor');
  return (
    <>
      <div className="page-title with-switch">
        <h2>{address ? <>Admin, <em>{roles.filter((r) => r !== 'Viewer').join(' + ') || 'read only'}.</em></> : <>Sign in, <em>two keys at a time.</em></>}</h2>
        {!address && <button type="button" className="primary" onClick={onSignIn}>Sign in</button>}
      </div>
      {address && !wallet && (
        <section className="box padded signin-prompt">
          <h2>Wallet not connected</h2>
          <button type="button" className="primary" onClick={onSignIn}>Reconnect</button>
        </section>
      )}
      <div className="admin-grid">
        {isWriter && wallet && <PointsPanel cfg={cfg} wallet={wallet} s={s} onChanged={onChanged} />}
        {(isOwner || isWriter || isAuditor) && wallet && <BatchPanel cfg={cfg} wallet={wallet} s={s} onChanged={onChanged} />}
        {isOwner && wallet && <AccessPanel cfg={cfg} wallet={wallet} s={s} onChanged={onChanged} />}
      </div>
      <ProposalsPanel cfg={cfg} wallet={wallet} s={s} onChanged={onChanged} />
      <AccessOverview s={s} />
      {isWriter && wallet && (
        <Details label="Raw operations">
          <WritePanel cfg={cfg} wallet={wallet} s={s} onChanged={onChanged} />
        </Details>
      )}
    </>
  );
}

/**
 * Changes waiting for their second signature: corrections and redemptions. Everyone can read the list; the table's
 * auditor approves or declines, and the treasurer who proposed one can withdraw it.
 */
function ProposalsPanel({ cfg, wallet, s, onChanged }: { cfg: ChainConfig; wallet: Wallet | null; s: Snapshot; onChanged: () => void }) {
  const open = s.proposals.filter((c) => c.status === 'open').sort((a, b) => b.id - a.id);
  const auditor = s.tableAuditors.find((t) => t.tableId === PROGRAM.table)?.auditor;
  const balances = new Map(members(s.rows, pointsEvents(s.ops)).map((m) => [m.rowId, m.balance]));
  return (
    <Section
      title="Waiting for the auditor"
      count={open.length}
    >
      {open.length === 0 ? <Empty>None waiting.</Empty> : (
        <ul className="corrections box">
          {open.map((c) => <ProposalItem key={c.id} c={c} cfg={cfg} wallet={wallet} s={s} auditor={auditor} before={balances.get(Number(c.op[1]))} onChanged={onChanged} />)}
        </ul>
      )}
    </Section>
  );
}

function ProposalItem({ c, cfg, wallet, s, auditor, before, onChanged }: { c: ProposedChange; cfg: ChainConfig; wallet: Wallet | null; s: Snapshot; auditor?: Address; before?: bigint; onChanged: () => void }) {
  const tx = useTx(cfg, wallet, onChanged);
  const rowId = Number(c.op[1]);
  const card = cardOf(rowId, s.ops);
  const who = card !== undefined ? formatCard(card) : `row ${rowId}`;
  const canDecide = !!wallet && !!auditor && same(auditor, wallet.address);
  const canWithdraw = !!wallet && same(c.proposer, wallet.address);
  const busy = tx.state.kind === 'busy';
  const redeem = c.op[0] === 4n;
  const what = c.op[0] === 5n ? 'Remove member'
    : redeem ? `−${formatAmount(c.op[3])}`
      : `${before !== undefined ? formatAmount(before) : '?'} → ${formatAmount(c.op[3])}`;
  return (
    <li>
      <div className="correction-what">
        <a className="mono link card" href={`#member/${rowId}`}>{who}</a>
        <span className={`delta ${redeem ? 'spend' : 'warn'}`}>
          <b className="mono">{what}</b>
          <span className="reason">{redeem ? reasonLabel(c.op[REASON_SLOT]) ?? 'Redemption' : 'Correction'}</span>
        </span>
        <span className="note">proposed by <Actor s={s} address={c.proposer} /> · {ago(c.timestamp)}</span>
      </div>
      <div className="row-actions">
        {canDecide && <button type="button" className="primary small" disabled={busy} onClick={() => void tx.run(() => tx.send('approveChange', [BigInt(c.id), c.op], `Co-signed. ${who} is queued for the next proof.`))}>Co-sign</button>}
        {canDecide && <button type="button" className="secondary small" disabled={busy} onClick={() => void tx.run(() => tx.send('declineChange', [BigInt(c.id), c.op], `Declined. ${who} keeps its balance.`))}>Decline</button>}
        {canWithdraw && !canDecide && <button type="button" className="secondary small" disabled={busy} onClick={() => void tx.run(() => tx.send('declineChange', [BigInt(c.id), c.op], 'Withdrawn.'))}>Withdraw</button>}
        {!canDecide && !canWithdraw && <span className="status needs"><i aria-hidden="true" />Needs auditor</span>}
      </div>
      <TxStatus state={tx.state} />
    </li>
  );
}

/** Who holds which role, read from the contract. Public: a member can see whose signatures a change needs. */
function AccessOverview({ s }: { s: Snapshot }) {
  const treasurer = s.tableOwners.find((t) => t.tableId === PROGRAM.table)?.writer;
  const auditor = s.tableAuditors.find((t) => t.tableId === PROGRAM.table)?.auditor;
  const others = s.writers.filter((w) => !treasurer || !same(w, treasurer));
  const g = s.governor;
  const held = (address: string | undefined): ReactNode => (address ? <OnChain value={address} kind="address" always /> : 'Nobody');
  return (
    <Section title="Roles">
      <KeyValues items={[
        ['Treasurer', held(treasurer)],
        ['Auditor', held(auditor)],
        [g ? `Owner · ${g.threshold} of ${g.signers.length}` : 'Owner', held(s.owner)],
        ...(others.length ? [['Other writers', <span className="chips">{others.map((w) => <Hash key={w} value={w} />)}</span>] as [string, ReactNode]] : []),
        ...s.tableOwners.filter((t) => t.tableId !== PROGRAM.table).map((t): [string, ReactNode] => [t.tableId === TRIAL_TABLE ? `Trial table (${formatField(t.tableId)})` : `Table ${formatField(t.tableId)}`, <Hash value={t.writer} />]),
        ...s.tableAuditors.filter((t) => t.tableId !== PROGRAM.table).map((t): [string, ReactNode] => [`Table ${formatField(t.tableId)} auditor`, <Hash value={t.auditor} />]),
      ]} />
      <Details label="Contracts" always>
        <KeyValues items={[
          ['Database contract', <OnChain value={s.address} kind="address" always />],
          ['Verifier', <OnChain value={s.verifier} kind="address" always />],
        ]} />
      </Details>
    </Section>
  );
}

interface PanelProps { cfg: ChainConfig; wallet: Wallet; s: Snapshot; onChanged: () => void }

function AccessPanel({ cfg, wallet, onChanged }: PanelProps) {
  const writerTx = useTx(cfg, wallet, onChanged);
  const tableTx = useTx(cfg, wallet, onChanged);
  const [writer, setWriter] = useState('');
  const [table, setTable] = useState('');
  const [tableWriter, setTableWriter] = useState('');
  const auditorTx = useTx(cfg, wallet, onChanged);

  /** The same two fields name a table and an account; this gives the table that account as its auditor. */
  const assignAuditor = () => {
    const t = parseRequired(table, 'Table number');
    if (!t.ok) return auditorTx.setState({ kind: 'error', message: t.error });
    const a = parseAddress(tableWriter);
    if (!a.ok) return auditorTx.setState({ kind: 'error', message: a.error });
    void auditorTx.run(() => auditorTx.send('setTableAuditor', [t.value, a.value], `Table ${t.value} has a new auditor.`));
  };

  const changeWriter = (allowed: boolean) => {
    const a = parseAddress(writer);
    if (!a.ok) return writerTx.setState({ kind: 'error', message: a.error });
    void writerTx.run(() => writerTx.send('setWriter', [a.value, allowed], allowed ? 'Writer added.' : 'Writer removed.'));
  };

  const assignTable = (e: FormEvent) => {
    e.preventDefault();
    const t = parseRequired(table, 'Table number');
    if (!t.ok) return tableTx.setState({ kind: 'error', message: t.error });
    const a = parseAddress(tableWriter);
    if (!a.ok) return tableTx.setState({ kind: 'error', message: a.error });
    void tableTx.run(() => tableTx.send('setTableOwner', [t.value, a.value], `Table ${t.value} assigned.`));
  };

  return (
    <Section title="Access">
      <div className="box padded stack-form">
        <h3>Add writer</h3>
        <Field id="writer-address" label="Address">
          <input id="writer-address" className="mono" value={writer} onChange={(e) => setWriter(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} />
        </Field>
        <div className="row-actions">
          <button type="button" className="primary" onClick={() => changeWriter(true)}>Make writer</button>
          <button type="button" className="secondary" onClick={() => changeWriter(false)}>Remove writer</button>
        </div>
        <TxStatus state={writerTx.state} />
        <hr />
        <form className="stack-form" onSubmit={assignTable}>
          <h3>Assign table</h3>
          <Field id="table-id" label="Table">
            <input id="table-id" className="mono" value={table} onChange={(e) => setTable(e.target.value)} inputMode="numeric" autoComplete="off" />
          </Field>
          <Field id="table-writer" label="Account">
            <input id="table-writer" className="mono" value={tableWriter} onChange={(e) => setTableWriter(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} />
          </Field>
          <div className="row-actions">
            <button type="submit" className="primary">Give table</button>
            <button type="button" className="secondary" onClick={assignAuditor}>Make auditor</button>
          </div>
        </form>
        <TxStatus state={tableTx.state} />
        <TxStatus state={auditorTx.state} />
      </div>
    </Section>
  );
}

type WriteOp = 'insert' | 'set' | 'add' | 'sub' | 'delete';
const WRITE_OPS: [WriteOp, string][] = [['insert', 'Add a row'], ['set', 'Set a value'], ['add', 'Increase a value'], ['sub', 'Decrease a value'], ['delete', 'Delete a row']];
const OPCODES = { set: 2, add: 3, sub: 4, delete: 5 } as const;
const zeros = () => [0n, 0n, 0n, 0n, 0n, 0n];

function WritePanel({ cfg, wallet, s, onChanged }: PanelProps) {
  const tx = useTx(cfg, wallet, onChanged);
  const ownTables = s.tableOwners.filter((t) => same(t.writer, wallet.address)).map((t) => t.tableId);
  const [op, setOp] = useState<WriteOp>('insert');
  const [table, setTable] = useState('');
  const [fields, setFields] = useState(['', '', '', '', '', '']);
  const [row, setRow] = useState('');
  const [fieldIndex, setFieldIndex] = useState('0');
  const [amount, setAmount] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    const bad = (message: string) => tx.setState({ kind: 'error', message });
    if (op === 'insert') {
      const chosen = table || ownTables[0]?.toString() || '';
      if (!chosen) return bad('This account owns no tables yet. Ask the owner to assign one.');
      const values: bigint[] = [];
      for (let i = 0; i < 6; i++) {
        const v = parseField(fields[i], fieldName(i));
        if (!v.ok) return bad(v.error);
        values.push(v.value);
      }
      void tx.run(async () => {
        await tx.send('insert', [BigInt(chosen), values], 'Queued for the next proof.');
        setFields(['', '', '', '', '', '']);
      });
      return;
    }
    const r = parseRowId(row);
    if (!r.ok) return bad(r.error);
    const opcode = OPCODES[op];
    if (op === 'delete') {
      void tx.run(() => tx.send('enqueue', [opcode, r.value, 0n, zeros()], 'Queued for the next proof.'));
      return;
    }
    const idx = parseFieldIndex(fieldIndex);
    if (!idx.ok) return bad(idx.error);
    const v = op === 'set' ? parseRequired(amount, 'Value') : parseU64(amount, 'Amount');
    if (!v.ok) return bad(v.error);
    const values = zeros();
    values[0] = v.value;
    void tx.run(() => tx.send('enqueue', [opcode, r.value, idx.value, values], 'Queued for the next proof.'));
  }

  return (
    <Section title="Write">
      <form className="box padded stack-form" onSubmit={submit}>
        <Field id="write-op" label="Action">
          <select id="write-op" value={op} onChange={(e) => { setOp(e.target.value as WriteOp); tx.setState({ kind: 'idle' }); }}>
            {WRITE_OPS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </Field>
        {op === 'insert' ? (
          <>
            <Field id="write-table" label="Table" hint={ownTables.length ? undefined : 'No table assigned.'}>
              <select id="write-table" value={table} onChange={(e) => setTable(e.target.value)} disabled={!ownTables.length}>
                {ownTables.map((t) => <option key={t.toString()} value={t.toString()}>Table {formatField(t)}</option>)}
              </select>
            </Field>
            <div className="field-grid">
              {fields.map((v, i) => (
                <Field key={i} id={`write-f${i}`} label={FIELD_NAMES[i]}>
                  <input id={`write-f${i}`} className="mono" value={v} placeholder="0" autoComplete="off" onChange={(e) => setFields(fields.map((x, j) => (j === i ? e.target.value : x)))} />
                </Field>
              ))}
            </div>
          </>
        ) : (
          <div className="field-grid">
            <Field id="write-row" label="Row number">
              <input id="write-row" className="mono" value={row} onChange={(e) => setRow(e.target.value)} inputMode="numeric" autoComplete="off" />
            </Field>
            {op !== 'delete' && (
              <>
                <Field id="write-index" label="Field">
                  <select id="write-index" value={fieldIndex} onChange={(e) => setFieldIndex(e.target.value)}>
                    {FIELD_NAMES.map((n, i) => <option key={i} value={i}>{n}</option>)}
                  </select>
                </Field>
                <Field id="write-amount" label={op === 'set' ? 'New value' : 'By how much'}>
                  <input id="write-amount" className="mono" value={amount} onChange={(e) => setAmount(e.target.value)} autoComplete="off" />
                </Field>
              </>
            )}
          </div>
        )}
        <div className="row-actions"><button type="submit" className="primary">Submit</button></div>
        <TxStatus state={tx.state} />
      </form>
    </Section>
  );
}

type PointsAction = 'award' | 'redeem' | 'correct' | 'join';
const POINTS_ACTIONS: [PointsAction, string][] = [['award', 'Award'], ['redeem', 'Redeem'], ['correct', 'Correct'], ['join', 'New member']];

/** The treasurer's desk: every action here is one queued op on the points table, proven in the next batch. */
function PointsPanel({ cfg, wallet, s, onChanged }: PanelProps) {
  const tx = useTx(cfg, wallet, onChanged);
  const list = members(s.rows, pointsEvents(s.ops));
  const [action, setAction] = useState<PointsAction>('award');
  const [row, setRow] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<ReasonKey>('volunteer');
  const [card, setCard] = useState('');
  const ownsTable = s.tableOwners.some((t) => t.tableId === PROGRAM.table && same(t.writer, wallet.address));
  const audited = s.tableAuditors.some((t) => t.tableId === PROGRAM.table);
  const [enrol, setEnrol] = useState('');
  const chosen = list.find((m) => String(m.rowId) === row) ?? list[0];

  const pick = (a: PointsAction) => {
    setAction(a);
    tx.setState({ kind: 'idle' });
    if (a === 'award') setReason('volunteer');
    if (a === 'redeem') setReason('shirt');
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    const bad = (message: string) => tx.setState({ kind: 'error', message });
    if (action === 'join') {
      const c = parseU64(card, 'Card number');
      if (!c.ok) return bad(c.error);
      // The member's own device made the card secret. The treasurer only ever sees this hash of it.
      const key = parseEnrolCode(enrol);
      if (!key.ok) return bad(key.error);
      if (list.some((m) => m.card === c.value)) return bad(`Card ${formatCard(c.value)} already has an account.`);
      void tx.run(async () => {
        await tx.send('insert', [PROGRAM.table, [c.value, 0n, key.value, 0n, 0n, 0n]], `Queued: card ${formatCard(c.value)} joins with 0 points.`);
        setCard(''); setEnrol('');
      });
      return;
    }
    if (!chosen) return bad('No member yet. Add one first.');
    const n = parseU64(amount, action === 'correct' ? 'New balance' : 'Points');
    if (!n.ok) return bad(n.error);
    if (action !== 'correct' && n.value === 0n) return bad('Enter more than 0 points.');
    const code = action === 'correct' ? REASONS.correction.code : REASONS[reason].code;
    const opcode = { award: 3, redeem: 4, correct: 2 }[action];
    const label = action === 'award' ? `+${formatAmount(n.value)}` : action === 'redeem' ? `−${formatAmount(n.value)}` : `balance → ${formatAmount(n.value)}`;
    const args = [opcode, BigInt(chosen.rowId), BigInt(BALANCE_FIELD), [n.value, code, 0n, 0n, 0n, 0n]];
    void tx.run(async () => {
      if (action !== 'award' && audited) {
        const what = action === 'correct' ? `${formatAmount(chosen.balance)} → ${formatAmount(n.value)}` : `−${formatAmount(n.value)}`;
        await tx.send('proposeChange', args, `Proposed: ${formatCard(chosen.card)} ${what}. Nothing changes until the auditor co-signs.`);
      } else {
        await tx.send('enqueue', args, `Queued: ${label} for ${formatCard(chosen.card)}.`);
      }
      setAmount('');
    });
  }

  const reasons = action === 'award' ? EARN_REASONS : SPEND_REASONS;
  return (
    <Section title="Points">
      <form className="box padded stack-form" onSubmit={submit}>
        <div className="segmented" role="group" aria-label="Action">
          {POINTS_ACTIONS.map(([k, label]) => (
            <button key={k} type="button" aria-pressed={action === k} onClick={() => pick(k)}>{label}</button>
          ))}
        </div>
        {action === 'join' ? (
          <div className="field-grid two">
            <Field id="points-card" label="Card number">
              <input id="points-card" className="mono" value={card} onChange={(e) => setCard(e.target.value)} inputMode="numeric" autoComplete="off" placeholder="0042" />
            </Field>
            <Field id="points-enrol" label="Enrol code from the member" hint="The member makes it on the Perks page. It is a hash; the secret stays on their device.">
              <input id="points-enrol" className="mono" value={enrol} onChange={(e) => setEnrol(e.target.value)} autoComplete="off" spellCheck={false} placeholder="0x…" />
            </Field>
          </div>
        ) : (
          <div className="field-grid">
            <Field id="points-member" label="Member">
              <select id="points-member" value={chosen ? String(chosen.rowId) : ''} onChange={(e) => setRow(e.target.value)} disabled={!list.length}>
                {list.map((m) => <option key={m.rowId} value={m.rowId}>{formatCard(m.card)} · {formatAmount(m.balance)}</option>)}
              </select>
            </Field>
            <Field id="points-amount" label={action === 'correct' ? 'New balance' : 'Points'}>
              <input id="points-amount" className="mono" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" autoComplete="off" placeholder="0" />
            </Field>
            {action !== 'correct' && (
              <Field id="points-reason" label="Reason">
                <select id="points-reason" value={reason} onChange={(e) => setReason(e.target.value as ReasonKey)}>
                  {reasons.map((r) => <option key={r} value={r}>{REASONS[r].label}</option>)}
                </select>
              </Field>
            )}
          </div>
        )}
        {action === 'join' && !ownsTable && <p className="note">Table {PROGRAM.table.toString()} is not assigned to this account.</p>}
        <div className="row-actions">
          <button type="submit" className="primary">{{ award: 'Award', redeem: audited ? 'Propose redemption' : 'Redeem', correct: audited ? 'Propose correction' : 'Set balance', join: 'Add member' }[action]}</button>
        </div>
        {(action === 'correct' || action === 'redeem') && audited && <p className="note">Taking points away needs a second signature from the auditor.</p>}
        <TxStatus state={tx.state} />
      </form>
    </Section>
  );
}

function BatchPanel({ cfg, wallet, s, onChanged }: PanelProps) {
  const tx = useTx(cfg, wallet, onChanged);
  const busy = tx.state.kind === 'busy';

  const run = () => tx.run(async () => {
    tx.setState({ kind: 'busy', label: 'Proving…' });
    const proven = await proveNextBatch();
    const ops = proven.ops.map((op) => op.map(BigInt));
    const sent = await tx.send('submitBatch', [proven.proof, proven.newRoot, proven.ok, ops],
      (r) => `Proof accepted · ${plural(proven.consumed, 'change')} · proved in ${formatMs(proven.provingMs)} · confirmed in ${formatMs(r.confirmMs)}`);
    // Display-only timing; the server checks the transaction really published this root before storing it.
    await recordConfirmation({ newRoot: proven.newRoot, txHash: sent.hash, confirmMs: sent.confirmMs }).catch(() => {});
    dispatchEvent(new Event(META_EVENT));
    // The new root goes out over ICM: to the school L1 first, where claims are checked against it, then to the
    // other L1. Each relay contract reads the root from ZkDB, not from this page.
    const relays = [cfg.l1 && { name: cfg.l1.name, address: cfg.l1.relay }, cfg.icm && { name: cfg.icm.name, address: cfg.icm.relay }].filter((r): r is { name: string; address: Address } => !!r);
    if (relays.length) {
      const accepted = `Proof accepted · ${plural(proven.consumed, 'change')} · proved in ${formatMs(proven.provingMs)} · confirmed in ${formatMs(sent.confirmMs)}`;
      const reached: string[] = [];
      for (const r of relays) {
        tx.setState({ kind: 'busy', label: `${accepted}. Sending the root to ${r.name}…` });
        try {
          await tx.send('relay', [], accepted, { address: r.address, abi: relayAbi as Abi });
          reached.push(r.name);
        } catch {
          // The proof is already accepted. Anyone can call relay() later; the next proof's root supersedes this one.
        }
      }
      const missed = relays.filter((r) => !reached.includes(r.name)).map((r) => r.name);
      tx.setState({
        kind: 'done',
        hash: sent.hash,
        label: `${accepted} · ${[reached.length ? `root sent to ${reached.join(' and ')} over ICM` : '', missed.length ? `not sent to ${missed.join(' or ')} this time` : ''].filter(Boolean).join(', ')}`,
      });
    }
  });

  return (
    <Section title="Prove">
      <div className="box padded stack-form">
        <div>
          <div className="lab">{Math.min(s.pending, K)}/{K}</div>
          <SlotBar slots={nextBatchSlots(s.ops)} />
        </div>
        <div className="row-actions">
          <button type="button" className="primary" onClick={run} disabled={busy || s.pending === 0}>
            {s.pending === 0 ? 'Nothing waiting' : `Prove ${plural(Math.min(s.pending, K), 'change')}`}
          </button>
        </div>
        {tx.state.kind === 'done' && tx.state.label.startsWith('Proof accepted') ? (
          <div className="verdict-card accepted" role="status">
            <h3>Proof accepted</h3>
            <p>{tx.state.label.split(' · ').slice(1, 4).join(' · ')}</p>
            <p className="note">{tx.state.label.split(' · ').slice(4).join(' · ')} {tx.state.hash && <OnChain value={tx.state.hash} kind="tx" />}</p>
          </div>
        ) : <TxStatus state={tx.state} />}
      </div>
    </Section>
  );
}
