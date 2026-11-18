import type { Op } from '@zkdb/core';
import { OPCODE } from '@zkdb/core';

const U64_MAX = (1n << 64n) - 1n;

export const toHex32 = (x: bigint) => '0x' + x.toString(16).padStart(64, '0');
export const shortHex = (h: string, head = 6, tail = 4) => (h.length <= head + tail + 3 ? h : `${h.slice(0, head + 2)}…${h.slice(-tail)}`);

/**
 * Raw field values are shown exactly as stored, without thousands separators: a field can hold a year, an ID or a
 * code, and "2,026" misreads all of them. Anything above u64 is almost always a hash or commitment.
 */
export const formatField = (x: bigint) => (x <= U64_MAX ? x.toString() : shortHex(toHex32(x)));

/** Amounts people count, such as points, get separators: 1,250. */
export const formatAmount = (x: bigint) => x.toLocaleString('en-US');

/** Users see fields numbered from 1; the contract numbers them from 0. */
export const fieldName = (i: number | bigint) => `Field ${Number(i) + 1}`;
export const FIELD_NAMES = [0, 1, 2, 3, 4, 5].map(fieldName);

const ACTIONS = new Map<bigint, string>([
  [OPCODE.INSERT, 'Add row'], [OPCODE.SET, 'Set value'], [OPCODE.ADD, 'Increase'], [OPCODE.SUB, 'Decrease'], [OPCODE.DELETE, 'Delete row'],
]);
export const actionName = (op: Op) => ACTIONS.get(op[0]) ?? `Code ${op[0]}`;

export function describeOp(op: Op): string {
  const [code, , a, v0] = op;
  switch (code) {
    case OPCODE.INSERT: return `New row in table ${a}: ${op.slice(3).map(formatField).join(' · ')}`;
    case OPCODE.SET: return `${fieldName(a)} set to ${formatField(v0)}`;
    case OPCODE.ADD: return `${fieldName(a)} increased by ${formatField(v0)}`;
    case OPCODE.SUB: return `${fieldName(a)} decreased by ${formatField(v0)}`;
    case OPCODE.DELETE: return 'Row deleted';
    default: return '';
  }
}

export const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** A fee in wei as a short coin amount: "0.0183 AVAX", or "0.164 nAVAX" (10⁻⁹) for the tiny fees of a testnet. */
export function formatFee(wei?: bigint, symbol = 'ETH') {
  if (wei === undefined) return '—';
  const short = (n: number) => String(Number(n.toPrecision(3)));
  const coins = Number(wei) / 1e18;
  if (coins === 0) return `0 ${symbol}`;
  return coins >= 1e-4 ? `${short(coins)} ${symbol}` : `${short(Number(wei) / 1e9)} n${symbol}`;
}

/** Gas as people say it: "1.09 M". */
export const formatGasShort = (g?: bigint) => (g === undefined ? '—' : g >= 1_000_000n ? `${(Number(g) / 1e6).toFixed(2)} M` : g.toLocaleString('en-US'));

export const formatGas = (g?: bigint) => (g === undefined ? '—' : g.toLocaleString('en-US'));
export const formatTime = (s?: number) => (s === undefined ? '—' : new Date(s * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
