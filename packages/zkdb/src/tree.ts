import { hash2 } from './hash';
import { toBuf32 } from './field';

export const DEPTH = 20;

export class ZkTree {
  private readonly zeros: bigint[];
  private readonly levels: Map<number, bigint>[];

  constructor(readonly depth = DEPTH) {
    this.zeros = [0n];
    for (let i = 0; i < depth; i++) this.zeros.push(hash2(this.zeros[i], this.zeros[i]));
    this.levels = Array.from({ length: depth + 1 }, () => new Map<number, bigint>());
  }

  static zeroSiblings(depth = DEPTH): bigint[] {
    const z = [0n];
    for (let i = 0; i < depth - 1; i++) z.push(hash2(z[i], z[i]));
    return z;
  }

  static computeRoot(leaf: bigint, index: number, siblings: bigint[]): bigint {
    let node = leaf;
    let idx = index;
    for (const sib of siblings) {
      node = idx & 1 ? hash2(sib, node) : hash2(node, sib);
      idx >>= 1;
    }
    return node;
  }

  get root(): bigint { return this.node(this.depth, 0); }

  leaf(index: number): bigint { return this.node(0, index); }

  siblings(index: number): bigint[] {
    this.check(index);
    const out: bigint[] = [];
    let idx = index;
    for (let l = 0; l < this.depth; l++) { out.push(this.node(l, idx ^ 1)); idx >>= 1; }
    return out;
  }

  setLeaf(index: number, value: bigint): void {
    this.check(index);
    toBuf32(value); // validate field range before any mutation
    let idx = index;
    let cur = value;
    this.levels[0].set(idx, cur);
    for (let l = 0; l < this.depth; l++) {
      const sib = this.node(l, idx ^ 1);
      cur = idx & 1 ? hash2(sib, cur) : hash2(cur, sib);
      idx >>= 1;
      this.levels[l + 1].set(idx, cur);
    }
  }

  private node(level: number, index: number): bigint {
    return this.levels[level].get(index) ?? this.zeros[level];
  }

  private check(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= 2 ** this.depth) throw new Error(`index out of range: ${index}`);
  }
}
