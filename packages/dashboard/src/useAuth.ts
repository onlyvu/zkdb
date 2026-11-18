import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import type { ChainConfig } from './chain';
import { connectBrowserWallet, currentSession, devWallet, listDevAccounts, signIn, signOut, type Wallet } from './wallet';

export interface Auth {
  /** The signed-in address, from the server session. */
  address: Address | null;
  /** The wallet that can sign now. It may be missing after a reload, until reconnected. */
  wallet: Wallet | null;
  ready: boolean;
  login: (wallet: Wallet) => Promise<void>;
  logout: () => Promise<void>;
}

export function useAuth(cfg: ChainConfig, chainId?: number): Auth {
  const [address, setAddress] = useState<Address | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (chainId === undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const session = await currentSession();
        if (cancelled || !session.address) return;
        setAddress(session.address);
        const dev = (await listDevAccounts(cfg, chainId).catch(() => [])).find((a) => a.address === session.address);
        if (dev) {
          setWallet(devWallet(cfg, dev));
          return;
        }
        const browser = await connectBrowserWallet(chainId, true);
        if (!cancelled && browser?.address === session.address) setWallet(browser);
      } catch {
        // No server or no wallet: the dashboard still works read-only.
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [cfg, chainId]);

  const login = useCallback(async (next: Wallet) => {
    if (chainId === undefined) throw new Error('Still connecting to the chain.');
    setAddress(await signIn(next, chainId));
    setWallet(next);
  }, [chainId]);

  const logout = useCallback(async () => {
    await signOut();
    setAddress(null);
    setWallet(null);
  }, []);

  return { address, wallet, ready, login, logout };
}
