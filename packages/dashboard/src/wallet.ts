import { createPublicClient, createWalletClient, custom, getAddress, http, numberToHex, type Address, type EIP1193Provider, type WalletClient } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import type { ChainConfig } from './chain';

export const LOCAL_CHAIN_ID = 31337;

export interface Wallet { address: Address; client: WalletClient; kind: 'browser' | 'dev' }

declare global {
  interface Window { ethereum?: EIP1193Provider }
}

export const hasBrowserWallet = () => typeof window !== 'undefined' && !!window.ethereum;

export interface DevAccount { address: Address; label?: string; kind: 'anvil' | 'demo' }

/**
 * Accounts that can sign without a browser wallet. On the local chain: the ones anvil keeps unlocked. Elsewhere:
 * demo accounts, if the dashboard server was started with ZKDB_DEMO=1 and has test keys in its local env file.
 */
export async function listDevAccounts(cfg: ChainConfig, chainId: number): Promise<DevAccount[]> {
  if (chainId === LOCAL_CHAIN_ID) {
    const accounts = await createWalletClient({ transport: http(cfg.rpcUrl) }).getAddresses();
    return accounts.slice(0, 5).map((a) => ({ address: getAddress(a), kind: 'anvil' as const }));
  }
  // Demo accounts exist only on a dev server started with ZKDB_DEMO=1. This branch is compiled out of a production
  // build, so a built dashboard never asks for them.
  if (import.meta.env.DEV) {
    const { accounts } = await api<{ accounts: { address: Address; label: string }[] }>('/api/demo/accounts');
    return accounts.map((a) => ({ address: getAddress(a.address), label: a.label, kind: 'demo' as const }));
  }
  return [];
}

export function devWallet(cfg: ChainConfig, account: DevAccount): Wallet {
  if (import.meta.env.DEV && account.kind === 'demo') return demoWallet(cfg, account);
  return { address: account.address, kind: 'dev', client: createWalletClient({ account: account.address, transport: http(cfg.rpcUrl) }) };
}

/** Signing happens on the dashboard server, which holds the test key; every other request goes to the RPC. */
function demoWallet(cfg: ChainConfig, account: DevAccount): Wallet {
  const rpc = createPublicClient({ transport: http(cfg.rpcUrl) });
  const transport = custom({
    request: async ({ method, params }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account.address];
      if (method === 'personal_sign' || method === 'eth_sendTransaction') {
        return (await api<{ result: string }>('/api/demo/wallet', { address: account.address, method, params })).result;
      }
      return rpc.request({ method, params } as never);
    },
  });
  return { address: account.address, kind: 'dev', client: createWalletClient({ account: account.address, transport }) };
}

/** Switches the wallet to the dashboard's chain, adding it first if the wallet has never seen it (error 4902). */
async function switchChain(provider: EIP1193Provider, chainId: number, cfg?: ChainConfig) {
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(chainId) }] });
  } catch (e) {
    const code = (e as { code?: number }).code ?? (e as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
    if (code !== 4902 || !cfg?.network) throw e;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: numberToHex(chainId),
        chainName: cfg.network,
        nativeCurrency: { name: cfg.currency ?? 'ETH', symbol: cfg.currency ?? 'ETH', decimals: 18 },
        rpcUrls: [cfg.rpcUrl],
        blockExplorerUrls: cfg.explorer ? [cfg.explorer] : undefined,
      }],
    });
  }
}

export async function connectBrowserWallet(chainId: number, silent = false, cfg?: ChainConfig): Promise<Wallet | null> {
  const provider = window.ethereum;
  if (!provider) return null;
  const accounts = (await provider.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' })) as string[];
  if (!accounts[0]) return null;
  if (!silent) await switchChain(provider, chainId, cfg);
  const address = getAddress(accounts[0]);
  return { address, kind: 'browser', client: createWalletClient({ account: address, transport: custom(provider) }) };
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  // The server's error code travels with the message, so a page can say something specific about it.
  if (!res.ok) throw Object.assign(new Error(data.error ?? 'The dashboard server is not responding.'), { code: data.code as string | undefined });
  return data as T;
}

export async function signIn(wallet: Wallet, chainId: number): Promise<Address> {
  const { nonce } = await api<{ nonce: string }>('/api/auth/nonce');
  const message = createSiweMessage({
    address: wallet.address,
    chainId,
    domain: location.host,
    nonce,
    uri: location.origin,
    version: '1',
    statement: 'Sign in to the zkDB dashboard. This does not send a transaction or cost gas.',
  });
  const signature = await wallet.client.signMessage({ account: wallet.address, message });
  return (await api<{ address: Address }>('/api/auth/verify', { message, signature })).address;
}

export const signOut = () => api('/api/auth/logout', {});
export const currentSession = () => api<{ address: Address | null }>('/api/auth/me');

export interface ProvenBatch { proof: `0x${string}`; newRoot: `0x${string}`; ok: boolean[]; ops: string[][]; consumed: number; provingMs: number }
export const proveNextBatch = () => api<ProvenBatch>('/api/batches/prove', {});
export const recordConfirmation = (body: { newRoot: string; txHash: string; confirmMs: number }) => api('/api/proofs/meta', body);

/**
 * Seeded demo cards with their secrets, where this machine has them: the local demo, or a dev server started with
 * ZKDB_DEMO=1. Compiled out of production builds. Listing the accounts first is what gives the page its token.
 */
export async function listDemoCards(): Promise<{ card: string; secret: `0x${string}` }[]> {
  if (!import.meta.env.DEV) return [];
  await api('/api/demo/accounts');
  return (await api<{ cards: { card: string; secret: `0x${string}` }[] }>('/api/demo/cards', {})).cards;
}

/** Hands a zero-knowledge claim to the server's relayer, which pays the gas. The card secret is not part of it. */
export const relayClaim = (body: { proof: `0x${string}`; perkId: number; nullifier: `0x${string}`; pickup: `0x${string}` }) =>
  api<{ txHash: `0x${string}`; gasUsed: string }>('/api/claims/relay', body);

/** The same claim, sent to the school L1 by the server's claim relayer. The hash it returns is an L1 transaction. */
export const relayClaimL1 = (body: { proof: `0x${string}`; perkId: number; nullifier: `0x${string}`; pickup: `0x${string}` }) =>
  api<{ txHash: `0x${string}`; gasUsed: string; messageId?: `0x${string}` }>('/api/claims/relay-l1', body);

/** Where the server can send a claim. A server that predates the L1 route answers 404, which means Fuji only. */
export const claimTargets = () => api<{ fuji: boolean; l1: boolean }>('/api/claims/targets').catch(() => ({ fuji: true, l1: false }));

/** Try-it mode: the server's trial key pays for the card, the award and the batch proof. */
export interface TrialInfo { enabled: boolean; table?: string; perkId?: number; points?: string; writer?: string; cardsLeftThisHour?: number; relayer?: boolean }
export interface TrialTx { step: 'insert' | 'award'; hash: `0x${string}`; gasUsed: string }
export const trialInfo = () => api<TrialInfo>('/api/trial');
export const trialCard = (cardKey: `0x${string}`) => api<{ rowId: string; card: string; points: string; txs: TrialTx[] }>('/api/trial/card', { cardKey });
export const trialBatch = () => api<{ txHash?: `0x${string}`; gasUsed?: string; newRoot?: string; provingMs?: number; consumed?: number; alreadyProven?: boolean; relayed?: { to: string; txHash: `0x${string}`; gasUsed: string }[] }>('/api/trial/batch', {});
