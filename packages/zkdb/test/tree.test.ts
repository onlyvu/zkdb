import { beforeAll, describe, expect, it } from 'vitest';
import { initHash, hash2 } from '../src/hash';
import { ZkTree, DEPTH } from '../src/tree';
import { P } from '../src/field';

beforeAll(async () => { await initHash(); });

describe('ZkTree', () => {
  it('empty root is hash chain of zeros', () => {
    let z = 0n;
    for (let i = 0; i < DEPTH; i++) z = hash2(z, z);
    expect(new ZkTree().root).toBe(z);
  });
  it('siblings + leaf recompute the root', () => {
    const t = new ZkTree();
    t.setLeaf(3, 111n);
    t.setLeaf(5, 222n);
    t.setLeaf(1_048_575, 333n);
    for (const i of [3, 5, 1_048_575, 0]) {
      expect(ZkTree.computeRoot(t.leaf(i), i, t.siblings(i))).toBe(t.root);
    }
  });
  it('setting a leaf back to 0 restores the empty root', () => {
    const t = new ZkTree();
    const empty = t.root;
    t.setLeaf(9, 5n);
    expect(t.root).not.toBe(empty);
    t.setLeaf(9, 0n);
    expect(t.root).toBe(empty);
  });
  it('rejects out-of-range index', () => {
    expect(() => new ZkTree().setLeaf(1 << DEPTH, 1n)).toThrow(/index/);
  });
  it('setLeaf with an out-of-field value throws and leaves the root unchanged', () => {
    const t = new ZkTree();
    t.setLeaf(7, 42n);
    const root = t.root;
    const leaf = t.leaf(7);
    expect(() => t.setLeaf(7, P)).toThrow(/field/);
    expect(t.root).toBe(root);
    expect(t.leaf(7)).toBe(leaf);
  });
});
