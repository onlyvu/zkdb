import { BarretenbergSync } from '@aztec/bb.js';
import { fromBuf, toBuf32 } from './field';

export type Row = [bigint, bigint, bigint, bigint, bigint, bigint];

let api: BarretenbergSync | undefined;

export async function initHash(): Promise<void> {
  api ??= await BarretenbergSync.initSingleton();
}

export function poseidon2(inputs: bigint[]): bigint {
  if (!api) throw new Error('call initHash() first');
  return fromBuf(api.poseidon2Hash({ inputs: inputs.map(toBuf32) }).hash);
}

export const hash2 = (a: bigint, b: bigint): bigint => poseidon2([a, b]);
export const hashLeaf = (table: bigint, row: Row): bigint => poseidon2([table, ...row]);
