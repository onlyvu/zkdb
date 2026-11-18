import { beforeAll, describe, expect, it } from 'vitest';
import { initHash, hashLeaf, Row } from '../src/hash';
import { ZkTree } from '../src/tree';
import { ZkDbState, buildBatch, K } from '../src/vm';
import { encodeInsert, encodeSet, encodeAdd, encodeSub, encodeDelete, NOOP_OP } from '../src/ops';

const TWO_POW_64 = 1n << 64n;
const r = (...xs: number[]): Row => xs.map(BigInt) as Row;

beforeAll(async () => { await initHash(); });

describe('ZkDbState.applyOp', () => {
  it('insert then add/sub/set/delete', () => {
    const s = new ZkDbState();
    const empty = s.root;
    expect(s.applyOp(encodeInsert(0, 2n, r(10, 0, 0, 0, 0, 0))).ok).toBe(true);
    expect(s.applyOp(encodeAdd(0, 0, 5n)).ok).toBe(true);
    expect(s.applyOp(encodeSub(0, 0, 15n)).ok).toBe(true);
    expect(s.applyOp(encodeSet(0, 5, 99n)).ok).toBe(true);
    expect(s.root).toBe(ZkTree.computeRoot(hashLeaf(2n, r(0, 0, 0, 0, 0, 99)), 0, ZkTree.zeroSiblings()));
    expect(s.applyOp(encodeDelete(0)).ok).toBe(true);
    expect(s.root).toBe(empty);
  });

  it('failed ops leave the root unchanged', () => {
    const s = new ZkDbState();
    s.applyOp(encodeInsert(0, 2n, r(3, 0, 0, 0, 0, 0)));
    const before = s.root;
    for (const op of [
      encodeInsert(0, 2n, r(1, 1, 1, 1, 1, 1)), // occupied
      encodeSub(0, 0, 4n),                      // underflow
      encodeSet(0, 6, 1n),                      // bad index
      encodeSet(1, 0, 1n),                      // empty row
      encodeDelete(1),                          // empty row
    ]) {
      expect(s.applyOp(op).ok).toBe(false);
      expect(s.root).toBe(before);
    }
  });

  it('add_overflow_fails', () => {
    const s = new ZkDbState();
    s.applyOp(encodeInsert(0, 2n, [TWO_POW_64 - 1n, 0n, 0n, 0n, 0n, 0n]));
    expect(s.applyOp(encodeAdd(0, 0, 1n)).ok).toBe(false);
  });

  it('add_on_non_u64_field_fails', () => {
    const s = new ZkDbState();
    s.applyOp(encodeInsert(0, 2n, [TWO_POW_64, 0n, 0n, 0n, 0n, 0n]));
    expect(s.applyOp(encodeAdd(0, 0, 1n)).ok).toBe(false);
  });

  it('witness recomputes the pre-op root', () => {
    const s = new ZkDbState();
    s.applyOp(encodeInsert(7, 1n, r(1, 2, 3, 4, 5, 6)));
    const before = s.root;
    const { witness } = s.applyOp(encodeAdd(7, 2, 1n));
    const leaf = witness.is_empty ? 0n : hashLeaf(witness.table_id, witness.row);
    expect(ZkTree.computeRoot(leaf, 7, witness.siblings)).toBe(before);
  });

  it('noop is ok and changes nothing', () => {
    const s = new ZkDbState();
    const before = s.root;
    expect(s.applyOp(NOOP_OP).ok).toBe(true);
    expect(s.root).toBe(before);
  });

  it('replaying the op log reproduces the root', () => {
    const log = [encodeInsert(0, 2n, r(1, 0, 0, 0, 0, 0)), encodeInsert(1, 1n, r(5, 5, 5, 5, 5, 5)), encodeAdd(0, 0, 9n), encodeSub(1, 1, 99n), encodeDelete(0)];
    const a = new ZkDbState(); log.forEach((op) => a.applyOp(op));
    const b = new ZkDbState(); log.forEach((op) => b.applyOp(op));
    expect(a.root).toBe(b.root);
  });
});

describe('buildBatch', () => {
  it('pads with NOOPs to K', () => {
    const s = new ZkDbState();
    const b = buildBatch(s, [encodeInsert(0, 2n, r(1, 0, 0, 0, 0, 0))]);
    expect(b.ops).toHaveLength(K);
    expect(b.witnesses).toHaveLength(K);
    expect(b.ok).toEqual([true, ...Array(K - 1).fill(true)]);
    expect(b.consumed).toBe(1);
    expect(b.newRoot).toBe(s.root);
  });

  it('buildBatch takes at most K ops', () => {
    const s = new ZkDbState();
    const pending = Array.from({ length: K + 3 }, (_, i) => encodeInsert(i, 2n, r(i, 0, 0, 0, 0, 0)));
    const b1 = buildBatch(s, pending);
    expect(b1.consumed).toBe(K);
    const b2 = buildBatch(s, pending.slice(b1.consumed));
    expect(b2.consumed).toBe(3);
    expect(b2.oldRoot).toBe(b1.newRoot);
  });

  it('rejects an empty pending list', () => {
    expect(() => buildBatch(new ZkDbState(), [])).toThrow(/empty/);
  });
});
