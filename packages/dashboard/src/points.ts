import { OPCODE, type Op } from '@zkdb/core';
import type { ProposedChange } from './chain';
import { formatAmount } from './format';
import type { OpStatus, OpView, RowView } from './replay';

/**
 * The points program this dashboard presents: one zkDB table where each row is a member account.
 * Row fields: [card number, points balance, card key, 0, 0, 0]. Names stay off-chain; the card number is a
 * pseudonymous id. The card key is Poseidon2(secret): the member's own device makes the secret and hands the club only
 * this hash. Whoever holds the secret can prove things about the row (see circuits/claim) without a wallet.
 * Award, redeem and correct are ADD, SUB and SET on the balance field; the op's second value slot (unused by the
 * circuit for these opcodes, but still hashed on-chain and published as a public input) carries a reason code.
 */
export const PROGRAM = {
  table: BigInt(import.meta.env?.VITE_PROGRAM_TABLE ?? 1),
  club: 'CLB Tình nguyện',
  name: 'Mùa hè xanh 2026',
  unit: 'points',
} as const;

export const CARD_FIELD = 0;
export const BALANCE_FIELD = 1;
export const KEY_FIELD = 2;

export const REASON_SLOT = 4; // op[4] = v[1]

export const REASONS = {
  volunteer: { code: 1n, label: 'Volunteer day' },
  blood: { code: 2n, label: 'Blood drive' },
  workshop: { code: 3n, label: 'Workshop' },
  crew: { code: 4n, label: 'Event crew' },
  shirt: { code: 10n, label: 'Club T-shirt' },
  ticket: { code: 11n, label: 'Event ticket' },
  reward: { code: 12n, label: 'Other reward' },
  correction: { code: 20n, label: 'Correction' },
} as const;
export type ReasonKey = keyof typeof REASONS;
export const EARN_REASONS: ReasonKey[] = ['volunteer', 'blood', 'workshop', 'crew'];
export const SPEND_REASONS: ReasonKey[] = ['shirt', 'ticket', 'reward'];

const REASON_BY_CODE = new Map<bigint, string>(Object.values(REASONS).map((r) => [r.code, r.label]));
export const reasonLabel = (code: bigint) => REASON_BY_CODE.get(code);

export const formatCard = (card: bigint) => `#${card.toString().padStart(4, '0')}`;

export type PointsKind = 'join' | 'award' | 'redeem' | 'correct' | 'leave';

export interface PointsEvent {
  op: OpView;
  rowId: number;
  kind: PointsKind;
  /** Signed change for award/redeem, the new balance for a correction. */
  amount: bigint;
  reason?: string;
  /** Balance before and after; equal when the change was rejected, undefined while it waits. */
  before?: bigint;
  after?: bigint;
  status: OpStatus;
  /** The auditor who co-signed, when the change went through the two-signature path. */
  cosigner?: string;
}

/** A proposed change that is not in the queue: still waiting for the auditor, or declined. */
export interface UnqueuedProposal {
  proposal: ProposedChange;
  rowId: number;
  kind: 'correct' | 'redeem' | 'leave';
  /** The balance a correction would set, or the points a redemption would take. */
  amount: bigint;
  reason?: string;
}

export interface Member {
  rowId: number;
  card: bigint;
  balance: bigint;
  /** Changes to this member still waiting for a proof. */
  waiting: number;
  lastChange?: PointsEvent;
}

/** Whether an op touches a row of the points program, given which rows belong to it. */
function kindOf(op: Op, rows: Set<number>): PointsKind | null {
  const [code, rowId, a] = op;
  if (code === OPCODE.INSERT) return a === PROGRAM.table ? 'join' : null;
  if (!rows.has(Number(rowId))) return null;
  if (code === OPCODE.DELETE) return 'leave';
  if (a !== BigInt(BALANCE_FIELD)) return null;
  if (code === OPCODE.ADD) return 'award';
  if (code === OPCODE.SUB) return 'redeem';
  if (code === OPCODE.SET) return 'correct';
  return null;
}

/**
 * Walks the op log in order and turns every op on a program row into a points event with the balance before and
 * after. Balances move only for confirmed changes, exactly like the proven state.
 */
export function pointsEvents(ops: OpView[], proposed: ProposedChange[] = []): PointsEvent[] {
  const cosigners = new Map(proposed.filter((c) => c.opId !== undefined).map((c) => [c.opId!, c.decidedBy]));
  const rows = new Set<number>();
  const balance = new Map<number, bigint>();
  const out: PointsEvent[] = [];
  for (const op of [...ops].sort((x, y) => x.id - y.id)) {
    const kind = kindOf(op.op, rows);
    if (!kind) continue;
    const rowId = Number(op.op[1]);
    if (kind === 'join') rows.add(rowId);
    const v0 = op.op[3];
    const cur = balance.get(rowId) ?? 0n;
    const ev: PointsEvent = { op, rowId, kind, amount: 0n, status: op.status, cosigner: cosigners.get(op.id) };
    const reason = reasonLabel(op.op[REASON_SLOT]);
    if (kind === 'join') ev.amount = op.op[3 + BALANCE_FIELD];
    else if (kind === 'award') ev.amount = v0;
    else if (kind === 'redeem') ev.amount = -v0;
    else if (kind === 'correct') ev.amount = v0;
    if (kind !== 'join' && kind !== 'leave' && reason) ev.reason = reason;

    if (op.status !== 'pending') {
      ev.before = kind === 'join' ? 0n : cur;
      let next = cur;
      if (op.status === 'applied') {
        if (kind === 'join') next = ev.amount;
        else if (kind === 'award') next = cur + v0;
        else if (kind === 'redeem') next = cur - v0;
        else if (kind === 'correct') next = v0;
        else if (kind === 'leave') next = 0n;
      }
      ev.after = op.status === 'applied' ? next : ev.before;
      balance.set(rowId, next);
    }
    out.push(ev);
  }
  return out;
}

/** Proposals on program rows that never reached the queue (waiting for the auditor, or declined), newest first. */
export function unqueuedProposals(proposed: ProposedChange[], ops: OpView[]): UnqueuedProposal[] {
  const rows = new Set(ops.filter((o) => o.op[0] === OPCODE.INSERT && o.op[2] === PROGRAM.table).map((o) => Number(o.op[1])));
  const kindOfProposal = (op: Op) => (op[0] === OPCODE.DELETE ? 'leave' as const : op[0] === OPCODE.SUB ? 'redeem' as const : 'correct' as const);
  return proposed
    .filter((c) => c.status !== 'approved' && rows.has(Number(c.op[1])))
    .filter((c) => c.op[0] === OPCODE.DELETE || c.op[2] === BigInt(BALANCE_FIELD))
    .map((c) => ({ proposal: c, rowId: Number(c.op[1]), kind: kindOfProposal(c.op), amount: c.op[3], reason: c.op[0] === OPCODE.SUB ? reasonLabel(c.op[REASON_SLOT]) : undefined }))
    .sort((a, b) => b.proposal.id - a.proposal.id);
}

/** Current members of the program, from the proven rows, with their latest change. */
export function members(rows: RowView[], events: PointsEvent[]): Member[] {
  return rows
    .filter((r) => r.table === PROGRAM.table)
    .map((r) => {
      const mine = events.filter((e) => e.rowId === r.rowId);
      return {
        rowId: r.rowId,
        card: r.fields[CARD_FIELD],
        balance: r.fields[BALANCE_FIELD],
        waiting: mine.filter((e) => e.status === 'pending').length,
        lastChange: mine[mine.length - 1],
      };
    });
}

/** Short label of what a points event did: "+400", "−150", "1,250 → 250", "Joined". */
export function changeLabel(e: PointsEvent): string {
  switch (e.kind) {
    case 'join': return e.amount > 0n ? `Joined · ${formatAmount(e.amount)}` : 'Joined';
    case 'award': return `+${formatAmount(e.amount)}`;
    case 'redeem': return `−${formatAmount(-e.amount)}`;
    case 'correct': return e.before !== undefined ? `${formatAmount(e.before)} → ${formatAmount(e.amount)}` : `Set to ${formatAmount(e.amount)}`;
    case 'leave': return 'Left';
  }
}

/** Card number of a program row, for labelling events. */
export const cardOf = (rowId: number, ops: OpView[]) => {
  const insert = ops.find((o) => o.op[0] === OPCODE.INSERT && Number(o.op[1]) === rowId);
  return insert ? insert.op[3 + CARD_FIELD] : undefined;
};
