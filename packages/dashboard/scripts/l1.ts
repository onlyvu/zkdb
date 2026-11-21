/**
 * Shared setup for the school L1 scripts (deploy-l1.ts, flow-l1.ts): the zkdb L1 (chainId 510102) and the Fuji
 * C-Chain, the contracts on each, and the Teleporter events used to tell an executed ICM message from a failed one.
 *
 * Public values live in packages/dashboard/.env.l1 (committed); keys in .env.fuji.local (gitignored).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, toHex, type Abi, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalancheFuji } from 'viem/chains';

export const pathOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
export const L1_ENV = pathOf('../.env.l1');
for (const file of ['../.env.fuji', '../.env.fuji.local', '../.env.l1', '../.env.l1-members.local']) {
  try { process.loadEnvFile(pathOf(file)); } catch { /* optional */ }
}

export const TELEPORTER: Address = '0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf';
/** Fuji C-Chain and the zkdb L1, as TeleporterMessenger names them (bytes32 blockchain IDs). */
export const FUJI_BLOCKCHAIN_ID: Hex = '0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5';
export const L1 = {
  name: 'zkdb L1',
  chainId: 510102,
  token: 'ZKD',
  blockchainId: (process.env.L1_BLOCKCHAIN_ID ?? '0x91640ec25733e7e73efdbe0f31050d5c9d5f7f8749b7a7c35b6d7b9900694dd4') as Hex,
  blockchainIdCb58: '272pDkC2CtfGT5kMktHTCNi7homXticaHaf1bJyfkgk5BLzTiU',
  subnetId: '23UCnnKWGoJTeAf1Uzqjo5RBvoyJ2sYQ7UMqviBcTuYqUJPL97',
  rpcUrl: process.env.L1_RPC_URL ?? 'http://127.0.0.1:9650/ext/bc/272pDkC2CtfGT5kMktHTCNi7homXticaHaf1bJyfkgk5BLzTiU/rpc',
};
export const zkdbL1 = defineChain({
  id: L1.chainId,
  name: L1.name,
  nativeCurrency: { name: L1.token, symbol: L1.token, decimals: 18 },
  rpcUrls: { default: { http: [L1.rpcUrl] } },
});

export const FUJI_RPC = process.env.VITE_RPC_URL ?? 'https://avalanche-fuji-c-chain-rpc.publicnode.com';
export const EXPLORER = process.env.VITE_EXPLORER_URL ?? 'https://testnet.snowtrace.io';

export const fuji = createPublicClient({ chain: avalancheFuji, transport: http(FUJI_RPC, { retryCount: 6, retryDelay: 1500 }), pollingInterval: 500 }) as PublicClient;
export const l1 = createPublicClient({ chain: zkdbL1, transport: http(L1.rpcUrl), pollingInterval: 250 }) as PublicClient;

export const key = (name: string): Hex => {
  const k = process.env[name];
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${name} missing from packages/dashboard/.env.fuji.local`);
  return k as Hex;
};
export const fujiWallet = (name: string) => createWalletClient({ chain: avalancheFuji, transport: http(FUJI_RPC, { retryCount: 6, retryDelay: 1500 }), account: privateKeyToAccount(key(name)) });
export const l1Wallet = (name: string) => createWalletClient({ chain: zkdbL1, transport: http(L1.rpcUrl), account: privateKeyToAccount(key(name)) });

export const artifact = (name: string): { abi: Abi; bytecode: Hex } => {
  const a = JSON.parse(readFileSync(pathOf(`../../../contracts/out/${name}.sol/${name}.json`), 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object };
};

/** The L1 deployment: Fuji side (relay, registry) and L1 side (mirror, verifier, gate, forwarder). */
export interface L1Deployment {
  relay: Address; registry: Address; fujiFromBlock: bigint;
  mirror: Address; claimVerifier: Address; gate: Address; forwarder: Address;
}
export const ENV_KEYS = {
  relay: 'L1_FUJI_RELAY', registry: 'L1_FUJI_REGISTRY', fujiFromBlock: 'L1_FUJI_FROM_BLOCK',
  mirror: 'L1_MIRROR', claimVerifier: 'L1_CLAIM_VERIFIER', gate: 'L1_GATE', forwarder: 'L1_FORWARDER',
} as const;
export function readDeployment(): Partial<L1Deployment> {
  const out: Record<string, unknown> = {};
  for (const [k, env] of Object.entries(ENV_KEYS)) {
    const v = process.env[env];
    if (v) out[k] = k === 'fujiFromBlock' ? BigInt(v) : v;
  }
  return out as Partial<L1Deployment>;
}
export function writeDeployment(d: Partial<L1Deployment>) {
  const lines = [
    '# The school L1 (zkdb, chainId 510102) and its ICM links to the Fuji C-Chain. Written by scripts/deploy-l1.ts.',
    '# Public values only. The L1 RPC is served by the team validator on localhost.',
    `L1_RPC_URL=${L1.rpcUrl}`,
    `L1_BLOCKCHAIN_ID=${L1.blockchainId}`,
  ];
  for (const [k, env] of Object.entries(ENV_KEYS)) {
    const v = d[k as keyof L1Deployment];
    if (v !== undefined) lines.push(`${env}=${String(v)}`);
  }
  writeFileSync(L1_ENV, lines.join('\n') + '\n');
}

export const relayAbi = parseAbi([
  'function relay() returns (bytes32 messageID)',
  'function lastRelayedBatch() view returns (uint64)',
  'function mirror() view returns (address)',
  'event RootRelayed(uint64 indexed batchNo, bytes32 root, bytes32 indexed messageID)',
]);
export const zkdbReadAbi = parseAbi(['function root() view returns (bytes32)', 'function batchCount() view returns (uint64)']);
export const mirrorAbi = parseAbi([
  'function root() view returns (bytes32)',
  'function batchNo() view returns (uint64)',
  'event RootMirrored(uint64 indexed batchNo, bytes32 root)',
]);
export const forwarderAbi = parseAbi([
  'function claimAndForward(bytes proof, uint256 perkId, bytes32 nullifier, bytes32 pickup) returns (bytes32 messageID)',
  'event ClaimForwarded(uint256 indexed perkId, bytes32 indexed nullifier, bytes32 pickup, bytes32 root, uint64 batchNo, bytes32 indexed messageID)',
]);
export const registryAbi = parseAbi([
  'struct Receipt { bytes32 pickup; bytes32 root; uint64 minPoints; uint64 batchNo; uint64 receivedAt; }',
  'function count() view returns (uint256)',
  'function recorded(uint256 perkId, bytes32 nullifier) view returns (bool)',
  'function receipt(uint256 perkId, bytes32 nullifier) view returns (Receipt)',
  'function redeem(uint256 perkId, bytes32 code)',
  'event ClaimRecorded(uint256 indexed perkId, bytes32 indexed nullifier, bytes32 indexed pickup, uint64 minPoints, bytes32 root, uint64 batchNo)',
  'event PerkRedeemed(uint256 indexed perkId, bytes32 indexed pickup)',
]);
export const teleporterAbi = parseAbi([
  'function messageReceived(bytes32 messageID) view returns (bool)',
  'function receivedFailedMessageHashes(bytes32 messageID) view returns (bytes32)',
]);

const MESSAGE_TUPLE = '(uint256,address,bytes32,address,uint256,address[],(uint256,address)[],bytes)';
/** topic0 of TeleporterMessenger's events (ava-labs/icm-contracts ITeleporterMessenger). */
export const TOPIC = {
  send: keccak256(toHex(`SendCrossChainMessage(bytes32,bytes32,${MESSAGE_TUPLE},(address,uint256))`)),
  receive: keccak256(toHex(`ReceiveCrossChainMessage(bytes32,bytes32,address,address,${MESSAGE_TUPLE})`)),
  executed: keccak256(toHex('MessageExecuted(bytes32,bytes32)')),
  failed: keccak256(toHex(`MessageExecutionFailed(bytes32,bytes32,${MESSAGE_TUPLE})`)),
};

export interface Delivery { received: boolean; ms: number; tx?: Hex; block?: bigint; status: 'executed' | 'failed' | 'not received' | 'received (receive tx not found)' }

/**
 * Waits until TeleporterMessenger on `chain` has received `messageId`, then finds the relayer's transaction and reads
 * from its receipt whether the destination ran the message (MessageExecuted) or not (MessageExecutionFailed).
 */
export async function waitForDelivery(chain: PublicClient, messageId: Hex, fromBlock: bigint, timeoutMs = 180_000): Promise<Delivery> {
  const t0 = performance.now();
  let received = false;
  while (!received && performance.now() - t0 < timeoutMs) {
    received = await chain.readContract({ address: TELEPORTER, abi: teleporterAbi, functionName: 'messageReceived', args: [messageId] });
    if (!received) await new Promise((r) => setTimeout(r, 1500));
  }
  const ms = Math.round(performance.now() - t0);
  if (!received) return { received, ms, status: 'not received' };
  const head = await chain.getBlockNumber();
  const span = 2000n;
  for (let to = head; to >= fromBlock; to -= span) {
    const from = to - span + 1n > fromBlock ? to - span + 1n : fromBlock;
    const logs = await chain.request({
      method: 'eth_getLogs',
      params: [{ address: TELEPORTER, fromBlock: toHex(from), toBlock: toHex(to), topics: [TOPIC.receive, messageId] }],
    }) as { transactionHash: Hex }[];
    if (logs.length) {
      const tx = logs[0].transactionHash;
      const r: TransactionReceipt = await chain.getTransactionReceipt({ hash: tx });
      const mine = (t: Hex) => r.logs.some((l) => l.topics[0] === t && l.topics[1]?.toLowerCase() === messageId.toLowerCase());
      return { received, ms, tx, block: r.blockNumber, status: mine(TOPIC.executed) ? 'executed' : mine(TOPIC.failed) ? 'failed' : 'received (receive tx not found)' };
    }
  }
  return { received, ms, status: 'received (receive tx not found)' };
}
