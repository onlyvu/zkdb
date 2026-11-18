import type { Row } from './hash';

export const OPCODE = { NOOP: 0n, INSERT: 1n, SET: 2n, ADD: 3n, SUB: 4n, DELETE: 5n } as const;
export const OP_WIDTH = 9;
export const ROW_WIDTH = 6;
export type Op = bigint[];

const pad = (head: bigint[]): Op => [...head, ...Array(OP_WIDTH - head.length).fill(0n)];

export const NOOP_OP: Op = pad([]);
export const encodeInsert = (rowId: number, table: bigint, fields: Row): Op => [OPCODE.INSERT, BigInt(rowId), table, ...fields];
export const encodeSet = (rowId: number, idx: number, value: bigint): Op => pad([OPCODE.SET, BigInt(rowId), BigInt(idx), value]);
export const encodeAdd = (rowId: number, idx: number, delta: bigint): Op => pad([OPCODE.ADD, BigInt(rowId), BigInt(idx), delta]);
export const encodeSub = (rowId: number, idx: number, delta: bigint): Op => pad([OPCODE.SUB, BigInt(rowId), BigInt(idx), delta]);
export const encodeDelete = (rowId: number): Op => pad([OPCODE.DELETE, BigInt(rowId)]);
