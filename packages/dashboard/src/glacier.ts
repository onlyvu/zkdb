import type { Address } from 'viem';

/** What the dashboard wants to know about a mined transaction besides its logs. */
export interface TxFacts { timestamp: number; gasUsed: bigint; fee: bigint; from: Address }

interface GlacierTx { txHash: string; blockTimestamp: number; gasUsed: string; gasPrice: string; from: { address: Address } }
interface GlacierPage { transactions: { nativeTransaction: GlacierTx }[]; nextPageToken?: string }

const PAGE = 100;
const MAX_PAGES = 20;

/**
 * Avalanche Data API (Glacier): one request returns up to 100 transactions of the contract with sender, block time,
 * gas used and the price actually paid. Without it the dashboard needs one eth_getBlockByNumber per change and one
 * receipt per proof from a rate-limited public RPC. Pages come newest first, so a refresh stops at the first
 * transaction it already knows. Any failure is reported as "not found" and the caller falls back to the RPC.
 */
export function createGlacier(baseUrl: string, address: Address, fetchImpl: typeof fetch = fetch) {
  const facts = new Map<string, TxFacts>();
  const url = `${baseUrl.replace(/\/$/, '')}/addresses/${address}/transactions?pageSize=${PAGE}`;

  async function refresh(): Promise<void> {
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetchImpl(token ? `${url}&pageToken=${encodeURIComponent(token)}` : url);
      if (!res.ok) throw new Error(`Data API answered ${res.status}`);
      const body = (await res.json()) as GlacierPage;
      let known = 0;
      for (const { nativeTransaction: t } of body.transactions ?? []) {
        const hash = t.txHash.toLowerCase();
        if (facts.has(hash)) { known++; continue; }
        const gasUsed = BigInt(t.gasUsed);
        facts.set(hash, { timestamp: t.blockTimestamp, gasUsed, fee: gasUsed * BigInt(t.gasPrice), from: t.from.address });
      }
      token = body.nextPageToken;
      if (!token || known > 0) return;
    }
  }

  return {
    get: (txHash: string) => facts.get(txHash.toLowerCase()),
    /** Makes sure these transactions are loaded if the API has them. Never throws. */
    async ensure(txHashes: string[]): Promise<void> {
      if (txHashes.every((h) => facts.has(h.toLowerCase()))) return;
      await refresh().catch(() => {});
    },
  };
}

export type Glacier = ReturnType<typeof createGlacier>;
