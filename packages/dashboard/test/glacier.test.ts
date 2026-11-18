import { describe, expect, it } from 'vitest';
import { createGlacier } from '../src/glacier';

const ADDRESS = '0x1dd3f88db29ee55e66b8db243c99c5b7fc0ea91c';
const tx = (n: number) => ({
  nativeTransaction: {
    txHash: `0x${n.toString(16).padStart(64, '0')}`, blockTimestamp: 1_795_000_000 + n, gasUsed: String(60_000 + n), gasPrice: '160',
    from: { address: '0x8117DF62D48DA08AB3681967b59D0f10401C48e7' },
  },
});
const hash = (n: number) => tx(n).nativeTransaction.txHash;

/** A stand-in for the Data API: pages of two, newest first. */
function fakeApi(total: () => number) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const token = new URL(url).searchParams.get('pageToken');
    const from = token ? Number(token) : total();
    const page = [from, from - 1].filter((n) => n >= 1).map(tx);
    return { ok: true, json: async () => ({ transactions: page, nextPageToken: from - 2 >= 1 ? String(from - 2) : undefined }) };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('Avalanche Data API reader', () => {
  it('turns a transaction into sender, time and the fee actually paid', async () => {
    const api = fakeApi(() => 3);
    const g = createGlacier('https://data-api.avax.network/v1/chains/43113/', ADDRESS, api.fetchImpl);
    await g.ensure([hash(1)]);
    expect(g.get(hash(1).toUpperCase().replace('0X', '0x'))).toEqual({
      timestamp: 1_795_000_001, gasUsed: 60_001n, fee: 60_001n * 160n, from: '0x8117DF62D48DA08AB3681967b59D0f10401C48e7',
    });
    expect(api.calls[0]).toBe(`https://data-api.avax.network/v1/chains/43113/addresses/${ADDRESS}/transactions?pageSize=100`);
    expect(api.calls).toHaveLength(2); // followed the page token to the end
  });

  it('asks nothing when it already knows every transaction, and stops paging at the first known one', async () => {
    let total = 4;
    const api = fakeApi(() => total);
    const g = createGlacier('https://x/v1/chains/1', ADDRESS, api.fetchImpl);
    await g.ensure([hash(4)]);
    const after = api.calls.length;
    await g.ensure([hash(1), hash(4)]);
    expect(api.calls).toHaveLength(after);

    total = 5;
    await g.ensure([hash(5)]);
    expect(api.calls).toHaveLength(after + 1); // page 1 holds a known transaction, so no second page
    expect(g.get(hash(5))?.gasUsed).toBe(60_005n);
  });

  it('reports nothing when the API fails, so the caller falls back to the RPC', async () => {
    const down = (async () => ({ ok: false, status: 429 })) as unknown as typeof fetch;
    const g = createGlacier('https://x/v1/chains/1', ADDRESS, down);
    await expect(g.ensure([hash(1)])).resolves.toBeUndefined();
    expect(g.get(hash(1))).toBeUndefined();
    const broken = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await expect(createGlacier('https://x', ADDRESS, broken).ensure([hash(1)])).resolves.toBeUndefined();
  });
});
