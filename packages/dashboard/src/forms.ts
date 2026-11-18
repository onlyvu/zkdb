import { P } from '@zkdb/core';
import { isAddress, type Address } from 'viem';

const U64_MAX = (1n << 64n) - 1n;
const MAX_ROWS = 1n << 20n;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string) => ({ ok: false as const, error });
const pass = <T,>(value: T) => ({ ok: true as const, value });

function toBigInt(raw: string): bigint | null {
  const s = raw.trim();
  if (!/^(\d+|0x[0-9a-fA-F]+)$/.test(s)) return null;
  return BigInt(s);
}

/** A field element: any value the circuit can hold. Empty means 0, because rows have six optional fields. */
export function parseField(raw: string, label = 'Value'): Parsed<bigint> {
  if (raw.trim() === '') return pass(0n);
  const v = toBigInt(raw);
  if (v === null) return fail(`${label} must be a whole number or 0x hex.`);
  if (v >= P) return fail(`${label} is too large for the BN254 field.`);
  return pass(v);
}

export function parseRequired(raw: string, label: string): Parsed<bigint> {
  if (raw.trim() === '') return fail(`${label} is required.`);
  return parseField(raw, label);
}

export function parseU64(raw: string, label: string): Parsed<bigint> {
  const v = parseRequired(raw, label);
  if (!v.ok) return v;
  return v.value > U64_MAX ? fail(`${label} must fit in 64 bits, because ADD and SUB fail otherwise.`) : v;
}

export function parseRowId(raw: string): Parsed<bigint> {
  const v = toBigInt(raw);
  if (v === null) return fail('Row ID must be a whole number.');
  return v >= MAX_ROWS ? fail('Row ID is out of range.') : pass(v);
}

export function parseFieldIndex(raw: string): Parsed<bigint> {
  return /^[0-5]$/.test(raw.trim()) ? pass(BigInt(raw.trim())) : fail('Field must be between 0 and 5.');
}

export function parseAddress(raw: string): Parsed<Address> {
  const s = raw.trim();
  return isAddress(s, { strict: false }) ? pass(s as Address) : fail('Enter a valid 0x address.');
}

/** The enrol code a member's device shows: Poseidon2 of their card secret, a non-zero field element. */
export function parseEnrolCode(raw: string): Parsed<bigint> {
  const v = toBigInt(raw);
  if (v === null || v === 0n) return fail('Paste the enrol code the member\'s device shows.');
  return v >= P ? fail('That is not an enrol code.') : pass(v);
}
