import { useEffect, useState } from 'react';
import type { ChainConfig } from './chain';

/**
 * Testnet fees say little: the Fuji base fee is a few wei. To give a fee a meaning, the dashboard reads the base fee
 * of a reference network right now (C-Chain mainnet for the Fuji deployment) and prices the same gas with it.
 * That figure is a calculation (gas used × someone else's base fee), and the UI labels it as one.
 */
export interface PriceRef { name: string; baseFee: bigint }

export function usePriceRef(cfg: ChainConfig): PriceRef | undefined {
  const [ref, setRef] = useState<PriceRef>();
  useEffect(() => {
    const p = cfg.priceRef;
    if (!p) return;
    let cancelled = false;
    const read = () => fetch(p.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_baseFee', params: [] }),
    })
      .then((r) => r.json())
      .then((r) => { if (!cancelled && typeof r.result === 'string') setRef({ name: p.name, baseFee: BigInt(r.result) }); })
      .catch(() => {});
    void read();
    const timer = setInterval(read, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [cfg]);
  return ref;
}

/** "≈ 0.0079 AVAX at C-Chain mainnet's base fee now": the same gas at the reference network's price. */
export function atRefPrice(gas: bigint | undefined, ref: PriceRef | undefined, symbol = 'AVAX'): string | undefined {
  if (gas === undefined || !ref) return undefined;
  const coins = Number(gas * ref.baseFee) / 1e18;
  return `≈ ${Number(coins.toPrecision(2))} ${symbol} at ${ref.name}'s base fee now`;
}
