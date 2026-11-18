import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { encodeAdd, encodeInsert, initHash, ZkDbState, type Op, type Row } from '@zkdb/core';
import { batchSlots, nextBatchSlots, replay, type BatchEvent, type QueuedOp } from '../src/replay';

const fixture = JSON.parse(readFileSync(new URL('../../../contracts/test/fixtures/batch_1.json', import.meta.url), 'utf8'));
const flat: bigint[] = fixture.realOpsFlat.map(BigInt);
const fixtureOps: QueuedOp[] = Array.from({ length: fixture.nRealOps }, (_, i) => ({
  id: i, op: flat.slice(i * 9, i * 9 + 9) as Op, txHash: `0x${i}`,
}));
const fixtureBatch = (over: Partial<BatchEvent> = {}): BatchEvent => ({
  batchNo: 1,
  oldRoot: BigInt(fixture.oldRoot),
  newRoot: BigInt(fixture.newRoot),
  fromOp: 0,
  toOp: fixture.nRealOps,
  ok: fixture.ok.map((x: number) => x === 1),
  txHash: '0xb',
  ...over,
});
const newRoot = () => BigInt(fixture.newRoot);

beforeAll(async () => { await initHash(); });

describe('replay', () => {
  it('reproduces the root and ok flags of the batch that was proven on-chain', () => {
    const r = replay(fixtureOps, [fixtureBatch()], newRoot());
    expect(r.issues).toEqual([]);
    expect(r.matches).toBe(true);
    expect(r.replayRoot).toBe(newRoot());
    expect(r.ops.map((o) => o.status)).toEqual(['applied', 'applied', 'applied', 'failed', 'applied', 'applied', 'failed']);
    expect(r.batches[0]).toMatchObject({ applied: 5, failed: 2 });
  });

  it('rebuilds live rows, leaving out deleted ones', () => {
    const r = replay(fixtureOps, [fixtureBatch()], newRoot());
    expect(r.rows).toEqual([{ rowId: 0, table: 2n, fields: [7n, 0xc0ffeen, 0n, 0n, 1n, 0n] }]);
  });

  it('keeps queued ops pending and out of the state', () => {
    const extra: QueuedOp = { id: 7, op: encodeAdd(0, 4, 41n), txHash: '0xe' };
    const r = replay([...fixtureOps, extra], [fixtureBatch()], newRoot());
    expect(r.matches).toBe(true);
    expect(r.ops[7].status).toBe('pending');
    expect(r.ops[7].batchNo).toBeUndefined();
    expect(r.rows[0].fields[4]).toBe(1n);
  });

  it('matches an empty chain only at the empty root', () => {
    const empty = new ZkDbState().root;
    expect(replay([], [], empty).matches).toBe(true);
    expect(replay([], [], empty + 1n).matches).toBe(false);
  });

  it('flags a contract root that replay does not reach', () => {
    const r = replay(fixtureOps, [fixtureBatch()], newRoot() + 1n);
    expect(r.matches).toBe(false);
    expect(r.replayRoot).toBe(newRoot());
  });

  it('flags a batch whose newRoot differs from replay', () => {
    const r = replay(fixtureOps, [fixtureBatch({ newRoot: 123n })], 123n);
    expect(r.matches).toBe(false);
    expect(r.issues.join()).toContain('newRoot');
  });

  it('flags ok flags that disagree with replay but still shows the on-chain status', () => {
    const ok = [...fixtureBatch().ok];
    ok[3] = true;
    const r = replay(fixtureOps, [fixtureBatch({ ok })], newRoot());
    expect(r.matches).toBe(false);
    expect(r.issues.join()).toContain('op #3');
    expect(r.ops[3].status).toBe('applied');
  });

  it('stops replaying when the log is missing an op a batch consumed', () => {
    const r = replay(fixtureOps.slice(1), [fixtureBatch()], newRoot());
    expect(r.matches).toBe(false);
    expect(r.issues.join()).toContain('op #0');
  });

  it('reports a malformed op instead of throwing', () => {
    const fields = [1n, 0n, 0n, 0n, 0n, 0n] as Row;
    const bad = encodeInsert(2 ** 20, 1n, fields);
    const r = replay([{ id: 0, op: bad, txHash: '0x0' }], [fixtureBatch({ toOp: 1 })], newRoot());
    expect(r.matches).toBe(false);
    expect(r.issues.join()).toContain('could not be replayed');
  });
});

describe('slots', () => {
  it('maps a batch onto K slots: real ops in order, then NOOP padding', () => {
    const r = replay(fixtureOps, [fixtureBatch()], newRoot());
    const slots = batchSlots(r.batches[0], r.ops);
    expect(slots.map((x) => x.kind).join()).toBe(
      ['ok', 'ok', 'ok', 'fail', 'ok', 'ok', 'fail', ...Array(9).fill('noop')].join(),
    );
    expect(slots[3].op?.id).toBe(3);
    expect(slots[7].op).toBeUndefined();
  });

  it('fills the next batch from the front of the queue and caps it at K', () => {
    const queued: QueuedOp[] = Array.from({ length: 20 }, (_, i) => ({ id: 7 + i, op: encodeAdd(0, 4, 1n), txHash: '0x' }));
    const r = replay([...fixtureOps, ...queued], [fixtureBatch()], newRoot());
    const slots = nextBatchSlots(r.ops);
    expect(slots).toHaveLength(16);
    expect(slots.every((x) => x.kind === 'pending')).toBe(true);
    expect(slots[0].op?.id).toBe(7);
  });

  it('leaves unused next-batch slots empty', () => {
    const r = replay(fixtureOps, [fixtureBatch()], newRoot());
    expect(nextBatchSlots(r.ops).every((x) => x.kind === 'empty')).toBe(true);
  });
});
