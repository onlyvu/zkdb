import { beforeAll, describe, expect, it } from 'vitest';
import { initHash, poseidon2, hash2, hashLeaf } from '../src/hash';
import { P, toBuf32, fromBuf, toHex } from '../src/field';

beforeAll(async () => { await initHash(); });

describe('field', () => {
  it('round-trips bigint through 32-byte big-endian', () => {
    const x = P - 1n;
    expect(fromBuf(toBuf32(x))).toBe(x);
    expect(toHex(1n)).toBe('0x' + '0'.repeat(63) + '1');
  });
  it('rejects values >= P', () => {
    expect(() => toBuf32(P)).toThrow(/field/);
  });
});

describe('poseidon2', () => {
  it('is deterministic and order-sensitive', () => {
    expect(hash2(1n, 2n)).toBe(hash2(1n, 2n));
    expect(hash2(1n, 2n)).not.toBe(hash2(2n, 1n));
  });
  it('hashLeaf binds table id', () => {
    const row = [1n, 2n, 3n, 4n, 5n, 6n] as const;
    expect(hashLeaf(1n, [...row] as any)).not.toBe(hashLeaf(2n, [...row] as any));
  });
  it('result is a field element', () => {
    expect(poseidon2([7n, 8n, 9n]) < P).toBe(true);
  });
});
