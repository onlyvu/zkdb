import { useEffect, useState } from 'react';
import { createPublicClient, http, parseAbi, type Address, type Hex } from 'viem';

/**
 * The school's own L1 as Fuji sees it. The L1 RPC is on the validator only, so this page reads the two Fuji ends of
 * the ICM link: RootRelay (each proven root sent to the L1) and ClaimRegistry (each claim receipt the L1 sent back,
 * written by Teleporter only after the L1 validator signed the message).
 */
export interface SchoolL1Config {
  name: string;
  chainId: number;
  token: string;
  blockchainId: string;
  subnetId?: string;
  relay: Address;
  registry: Address;
  fromBlock: bigint;
}

const addressOf = (v?: string) => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined);

export function readSchoolL1Config(env: Record<string, string | undefined>): SchoolL1Config | undefined {
  const relay = addressOf(env.VITE_L1_RELAY_ADDRESS);
  const registry = addressOf(env.VITE_L1_REGISTRY_ADDRESS);
  if (!relay || !registry || !env.VITE_L1_BLOCKCHAIN_ID) return undefined;
  return {
    name: env.VITE_L1_NAME || 'school L1',
    chainId: Number(env.VITE_L1_CHAIN_ID || 0),
    token: env.VITE_L1_TOKEN || '',
    blockchainId: env.VITE_L1_BLOCKCHAIN_ID,
    subnetId: env.VITE_L1_SUBNET_ID || undefined,
    relay,
    registry,
    fromBlock: BigInt(env.VITE_L1_FROM_BLOCK || 0),
  };
}

export const schoolRelayAbi = parseAbi(['event RootRelayed(uint64 indexed batchNo, bytes32 root, bytes32 indexed messageID)']);
export const claimRegistryAbi = parseAbi([
  'event ClaimRecorded(uint256 indexed perkId, bytes32 indexed nullifier, bytes32 indexed pickup, uint64 minPoints, bytes32 root, uint64 batchNo)',
  'event PerkRedeemed(uint256 indexed perkId, bytes32 indexed pickup)',
]);

export interface RootSent { batchNo: number; root: Hex; messageId: Hex; txHash: Hex; block: bigint }
export interface ClaimRecorded { perkId: number; nullifier: Hex; pickup: Hex; minPoints: bigint; root: Hex; batchNo: number; txHash: Hex; block: bigint }
export interface Redeemed { perkId: number; pickup: Hex; txHash: Hex }

export interface L1Root extends RootSent { claims: number }
export interface L1Claim extends ClaimRecorded { redeemTx?: Hex; time?: number }
export interface SchoolL1State { roots: L1Root[]; claims: L1Claim[]; redeemed: number; block: bigint }

/** Joins the three event streams: each root with the claims checked against it, each claim with its redemption. Newest first. */
export function summarizeSchoolL1(sent: RootSent[], recorded: ClaimRecorded[], redeemed: Redeemed[], block: bigint, times: Map<bigint, number> = new Map()): SchoolL1State {
  const key = (perkId: number, pickup: string) => `${perkId}:${pickup.toLowerCase()}`;
  const redeemTx = new Map(redeemed.map((r) => [key(r.perkId, r.pickup), r.txHash]));
  const claims = recorded
    .map((c) => ({ ...c, redeemTx: redeemTx.get(key(c.perkId, c.pickup)), time: times.get(c.block) }))
    .sort((a, b) => Number(b.block - a.block));
  const roots = sent
    .map((r) => ({ ...r, claims: recorded.filter((c) => c.batchNo === r.batchNo).length }))
    .sort((a, b) => b.batchNo - a.batchNo);
  return { roots, claims, redeemed: claims.filter((c) => c.redeemTx).length, block };
}

export async function readSchoolL1(rpcUrl: string, cfg: SchoolL1Config, logRange = 50_000n): Promise<SchoolL1State> {
  const client = createPublicClient({ transport: http(rpcUrl), cacheTime: 0 });
  const head = await client.getBlockNumber();
  const sent: RootSent[] = [];
  const recorded: ClaimRecorded[] = [];
  const redeemed: Redeemed[] = [];
  for (let from = cfg.fromBlock; from <= head; from += logRange) {
    const to = from + logRange - 1n < head ? from + logRange - 1n : head;
    const [r, c, x] = await Promise.all([
      client.getContractEvents({ address: cfg.relay, abi: schoolRelayAbi, eventName: 'RootRelayed', fromBlock: from, toBlock: to }),
      client.getContractEvents({ address: cfg.registry, abi: claimRegistryAbi, eventName: 'ClaimRecorded', fromBlock: from, toBlock: to }),
      client.getContractEvents({ address: cfg.registry, abi: claimRegistryAbi, eventName: 'PerkRedeemed', fromBlock: from, toBlock: to }),
    ]);
    for (const l of r) sent.push({ batchNo: Number(l.args.batchNo!), root: l.args.root!, messageId: l.args.messageID!, txHash: l.transactionHash, block: l.blockNumber });
    for (const l of c) recorded.push({ perkId: Number(l.args.perkId!), nullifier: l.args.nullifier!, pickup: l.args.pickup!, minPoints: l.args.minPoints!, root: l.args.root!, batchNo: Number(l.args.batchNo!), txHash: l.transactionHash, block: l.blockNumber });
    for (const l of x) redeemed.push({ perkId: Number(l.args.perkId!), pickup: l.args.pickup!, txHash: l.transactionHash });
  }
  const times = new Map<bigint, number>();
  for (const b of [...new Set(recorded.map((c) => c.block))]) {
    const hit = blockTimes.get(b) ?? Number((await client.getBlock({ blockNumber: b })).timestamp);
    blockTimes.set(b, hit);
    times.set(b, hit);
  }
  return summarizeSchoolL1(sent, recorded, redeemed, head, times);
}
const blockTimes = new Map<bigint, number>();

const POLL_MS = 10_000;

/** Reads the Fuji side of the school L1 link every few seconds; keeps the last good read on an error. */
export function useSchoolL1(rpcUrl: string, cfg: SchoolL1Config | undefined, logRange?: bigint) {
  const [state, setState] = useState<{ data?: SchoolL1State; error?: string }>({});
  useEffect(() => {
    if (!cfg) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const data = await readSchoolL1(rpcUrl, cfg, logRange);
        if (!cancelled) setState({ data });
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, error: (e as Error).message }));
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [rpcUrl, cfg, logRange]);
  return state;
}
