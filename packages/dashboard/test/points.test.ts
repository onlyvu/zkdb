import { describe, expect, it } from 'vitest';
import { formatAmount, formatField } from '../src/format';
import { changeLabel, formatCard, members, pointsEvents, PROGRAM, REASONS, unqueuedProposals } from '../src/points';
import type { OpStatus, OpView, RowView } from '../src/replay';
import { resolveSearch } from '../src/search';

let nextId = 0;
const op = (values: bigint[], status: OpStatus = 'applied', batchNo = 1): OpView => {
  const full = [...values, ...Array(9 - values.length).fill(0n)];
  return { id: nextId++, op: full, txHash: '0x', status, batchNo: status === 'pending' ? undefined : batchNo };
};
const T = PROGRAM.table;
const join = (row: number, card: bigint, points = 0n, status?: OpStatus) => op([1n, BigInt(row), T, card, points], status);
const award = (row: number, n: bigint, reason: bigint = REASONS.volunteer.code, status?: OpStatus) => op([3n, BigInt(row), 1n, n, reason], status);
const redeem = (row: number, n: bigint, status?: OpStatus) => op([4n, BigInt(row), 1n, n, REASONS.shirt.code], status);
const correct = (row: number, n: bigint, status?: OpStatus) => op([2n, BigInt(row), 1n, n, REASONS.correction.code], status);

describe('points events', () => {
  it('tracks balances before and after each confirmed change', () => {
    nextId = 0;
    const evs = pointsEvents([join(0, 42n), award(0, 400n), award(0, 850n), correct(0, 250n)]);
    expect(evs.map((e) => [e.kind, e.before, e.after])).toEqual([
      ['join', 0n, 0n], ['award', 0n, 400n], ['award', 400n, 1250n], ['correct', 1250n, 250n],
    ]);
    expect(changeLabel(evs[3])).toBe('1,250 → 250');
    expect(evs[3].reason).toBe('Correction');
    expect(evs[1].reason).toBe('Volunteer day');
  });

  it('keeps the balance unchanged for a rejected redemption', () => {
    nextId = 0;
    const evs = pointsEvents([join(0, 7n), award(0, 100n), redeem(0, 500n, 'failed')]);
    expect(evs[2]).toMatchObject({ kind: 'redeem', amount: -500n, before: 100n, after: 100n, status: 'failed' });
    expect(changeLabel(evs[2])).toBe('−500');
  });

  it('leaves waiting changes without a balance', () => {
    nextId = 0;
    const evs = pointsEvents([join(0, 7n), award(0, 100n, REASONS.workshop.code, 'pending')]);
    expect(evs[1].after).toBeUndefined();
    expect(evs[1].status).toBe('pending');
  });

  it('ignores rows of other tables and fields other than the balance', () => {
    nextId = 0;
    const other = op([1n, 0n, T + 5n, 1n, 2n]);
    const otherField = op([3n, 1n, 3n, 10n]);
    const evs = pointsEvents([other, join(1, 9n), otherField]);
    expect(evs.map((e) => e.kind)).toEqual(['join']);
  });
});

describe('members', () => {
  it('lists program rows with balance, latest change and waiting count', () => {
    nextId = 0;
    const evs = pointsEvents([join(0, 42n), award(0, 400n), award(0, 50n, REASONS.crew.code, 'pending')]);
    const rows: RowView[] = [
      { rowId: 0, table: T, fields: [42n, 400n, 0n, 0n, 0n, 0n] },
      { rowId: 1, table: T + 1n, fields: [1n, 1n, 0n, 0n, 0n, 0n] },
    ];
    const list = members(rows, evs);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ rowId: 0, card: 42n, balance: 400n, waiting: 1 });
    expect(list[0].lastChange?.status).toBe('pending');
  });
});

describe('formatting', () => {
  it('shows raw fields without separators so a year never reads as 2,026', () => {
    expect(formatField(2026n)).toBe('2026');
    expect(formatField(12648430n)).toBe('12648430');
  });
  it('groups amounts and pads card numbers', () => {
    expect(formatAmount(1250n)).toBe('1,250');
    expect(formatCard(42n)).toBe('#0042');
  });
});

describe('search by card', () => {
  const data = { ops: [], batches: [], rowCount: 3, address: '0x', verifier: '0x', owner: '0x', writers: [], cards: [{ card: 42n, rowId: 2 }] };
  it('finds a member by card number', () => {
    expect(resolveSearch('card 42', data)).toEqual({ route: 'member/2' });
    expect(resolveSearch('#0042', data)).toEqual({ route: 'member/2' });
    expect(resolveSearch('42', data)).toEqual({ route: 'member/2' });
  });
  it('falls back to a row for other bare numbers and reports unknown cards', () => {
    expect(resolveSearch('1', data)).toEqual({ route: 'row/1' });
    expect(resolveSearch('card 7', data)).toEqual({ error: 'No member has card #7.' });
  });
});

describe('proposals and signers', () => {
  const correction = (id: number, row: number, value: bigint, status: 'open' | 'approved' | 'declined', opId?: number, opcode = 2n) => ({
    id, op: [opcode, BigInt(row), 1n, value, opcode === 4n ? REASONS.shirt.code : REASONS.correction.code, 0n, 0n, 0n, 0n], proposer: '0xTreasurer' as `0x${string}`, status,
    decidedBy: status === 'open' ? undefined : ('0xAuditor' as `0x${string}`), opId, txHash: '0x',
  });

  it('names the auditor who co-signed a queued correction', () => {
    nextId = 0;
    const ops = [join(0, 42n), award(0, 1250n), correct(0, 250n)];
    const evs = pointsEvents(ops, [correction(0, 0, 250n, 'approved', 2)]);
    expect(evs[2]).toMatchObject({ kind: 'correct', before: 1250n, after: 250n, cosigner: '0xAuditor' });
    expect(evs[1].cosigner).toBeUndefined();
  });

  it('lists proposals that never reached the queue, newest first, and leaves approved ones to the history', () => {
    nextId = 0;
    const ops = [join(0, 42n), join(1, 7n)];
    const list = unqueuedProposals([correction(0, 0, 250n, 'approved', 2), correction(1, 1, 10n, 'declined'), correction(2, 0, 5n, 'open')], ops);
    expect(list.map((p) => [p.proposal.id, p.rowId, p.amount, p.proposal.status])).toEqual([[2, 0, 5n, 'open'], [1, 1, 10n, 'declined']]);
  });

  it('ignores proposals on rows outside the points program', () => {
    nextId = 0;
    expect(unqueuedProposals([correction(0, 9, 1n, 'open')], [join(0, 42n)])).toEqual([]);
  });

  it('shows a proposed redemption as a redemption with its reason, and a co-signed one with its auditor', () => {
    nextId = 0;
    const ops = [join(0, 42n), award(0, 600n), redeem(0, 500n)];
    const [waiting] = unqueuedProposals([correction(0, 0, 500n, 'open', undefined, 4n)], ops);
    expect(waiting).toMatchObject({ kind: 'redeem', amount: 500n, reason: 'Club T-shirt' });
    const evs = pointsEvents(ops, [correction(0, 0, 500n, 'approved', 2, 4n)]);
    expect(evs[2]).toMatchObject({ kind: 'redeem', amount: -500n, after: 100n, cosigner: '0xAuditor' });
  });
});
