import { describe, expect, it } from 'vitest';
import { P } from '@zkdb/core';
import { parseAddress, parseField, parseFieldIndex, parseRequired, parseRowId, parseU64 } from '../src/forms';
import { resolveSearch, type SearchData } from '../src/search';
import type { BatchView, OpView } from '../src/replay';

const value = <T,>(r: { ok: true; value: T } | { ok: false; error: string }) => (r.ok ? r.value : undefined);

describe('form parsing', () => {
  it('reads decimal and hex field values, and treats blank as 0', () => {
    expect(value(parseField('42'))).toBe(42n);
    expect(value(parseField('0xff'))).toBe(255n);
    expect(value(parseField('  '))).toBe(0n);
  });

  it('rejects values outside the field and non-numbers', () => {
    expect(parseField((P - 1n).toString()).ok).toBe(true);
    expect(parseField(P.toString()).ok).toBe(false);
    expect(parseField('-1').ok).toBe(false);
    expect(parseField('1.5').ok).toBe(false);
    expect(parseField('abc').ok).toBe(false);
  });

  it('requires a value where one is needed', () => {
    expect(parseRequired('', 'Table').ok).toBe(false);
  });

  it('keeps ADD and SUB amounts inside u64', () => {
    expect(parseU64((2n ** 64n - 1n).toString(), 'Amount').ok).toBe(true);
    expect(parseU64((2n ** 64n).toString(), 'Amount').ok).toBe(false);
  });

  it('bounds row IDs and field indexes', () => {
    expect(value(parseRowId('1048575'))).toBe(1048575n);
    expect(parseRowId('1048576').ok).toBe(false);
    expect(parseRowId('').ok).toBe(false);
    expect(value(parseFieldIndex('5'))).toBe(5n);
    expect(parseFieldIndex('6').ok).toBe(false);
  });

  it('accepts only 20-byte addresses', () => {
    expect(parseAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8').ok).toBe(true);
    expect(parseAddress('0x123').ok).toBe(false);
  });
});

describe('search', () => {
  const tx = `0x${'a'.repeat(64)}`;
  const batchTx = `0x${'b'.repeat(64)}`;
  const data: SearchData = {
    ops: [{ id: 3, txHash: tx } as OpView],
    batches: [{ batchNo: 1, txHash: batchTx, oldRoot: 1n, newRoot: 255n } as BatchView],
    rowCount: 2,
    address: `0x${'c'.repeat(40)}`,
    verifier: `0x${'d'.repeat(40)}`,
    owner: `0x${'e'.repeat(40)}`,
    writers: [],
  };

  it('finds named items', () => {
    expect(resolveSearch('op 3', data)).toEqual({ route: 'op/3' });
    expect(resolveSearch('Batch #1', data)).toEqual({ route: 'batch/1' });
    expect(resolveSearch('row 1', data)).toEqual({ route: 'row/1' });
    expect(resolveSearch('change 3', data)).toEqual({ route: 'op/3' });
    expect(resolveSearch('Proof #1', data)).toEqual({ route: 'batch/1' });
  });

  it('reads a bare number as a row', () => {
    expect(resolveSearch('1', data)).toEqual({ route: 'row/1' });
    expect(resolveSearch('2', data)).toHaveProperty('error');
  });

  it('finds tx hashes and roots regardless of case', () => {
    expect(resolveSearch(tx.toUpperCase().replace('0X', '0x'), data)).toEqual({ route: 'op/3' });
    expect(resolveSearch(batchTx, data)).toEqual({ route: 'batch/1' });
    expect(resolveSearch(`0x${'ff'.padStart(64, '0')}`, data)).toEqual({ route: 'batch/1' });
  });

  it('sends known addresses to the admin page', () => {
    expect(resolveSearch(data.owner, data)).toEqual({ route: 'admin' });
    expect(resolveSearch(`0x${'1'.repeat(40)}`, data)).toHaveProperty('error');
  });

  it('explains misses', () => {
    expect(resolveSearch('op 9', data)).toEqual({ error: 'Change #9 does not exist.' });
    expect(resolveSearch('hello', data)).toHaveProperty('error');
    expect(resolveSearch('', data)).toHaveProperty('error');
  });
});

describe('formatFee', () => {
  it('shows coins for normal fees and nano-coins for tiny testnet fees', async () => {
    const { formatFee } = await import('../src/format');
    expect(formatFee(18_300_000_000_000_000n, 'AVAX')).toBe('0.0183 AVAX');
    expect(formatFee(164_213n, 'AVAX')).toBe('0.000164 nAVAX');
    expect(formatFee(164_213_000_000n, 'AVAX')).toBe('164 nAVAX');
    expect(formatFee(0n, 'AVAX')).toBe('0 AVAX');
    expect(formatFee(undefined)).toBe('—');
  });
});
