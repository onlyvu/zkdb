import { useEffect, useState } from 'react';
import { createPublicClient, http, parseAbi, toFunctionSelector, type Address, type Hex } from 'viem';

/**
 * The school L1 read directly, through its public read-only RPC. The Fuji side of the link (schoolL1.ts) shows what
 * was sent and what came back; this shows what the L1 itself holds: its head, the root RootMirror stores, the perks
 * and claim counts of its PointsGate, each L1 transaction that mirrored a root or checked a claim, and who is on its
 * two allow-lists right now.
 */
export interface L1LiveConfig {
  rpcUrl: string;
  mirror: Address;
  gate: Address;
  forwarder: Address;
  verifier?: Address;
}

const addressOf = (v?: string) => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined);

export function readL1LiveConfig(env: Record<string, string | undefined>): L1LiveConfig | undefined {
  const mirror = addressOf(env.VITE_L1_MIRROR);
  const gate = addressOf(env.VITE_L1_GATE);
  const forwarder = addressOf(env.VITE_L1_FORWARDER);
  if (!env.VITE_L1_RPC_URL || !mirror || !gate || !forwarder) return undefined;
  return { rpcUrl: env.VITE_L1_RPC_URL, mirror, gate, forwarder, verifier: addressOf(env.VITE_L1_CLAIM_VERIFIER) };
}

/** Subnet-EVM precompiles: fixed addresses on every L1 that turns them on. */
export const TX_ALLOW_LIST: Address = '0x0200000000000000000000000000000000000002';
export const DEPLOYER_ALLOW_LIST: Address = '0x0200000000000000000000000000000000000000';
export const WARP: Address = '0x0200000000000000000000000000000000000005';
export const TELEPORTER: Address = '0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf';

export const l1Abi = parseAbi([
  'struct Perk { uint256 tableId; uint64 minPoints; uint64 claims; string name; }',
  'function root() view returns (bytes32)',
  'function batchNo() view returns (uint64)',
  'function perkCount() view returns (uint256)',
  'function perk(uint256 perkId) view returns (Perk)',
  'function claimed(uint256 perkId, bytes32 nullifier) view returns (bool)',
  'function readAllowList(address account) view returns (uint256)',
  'event RootMirrored(uint64 indexed batchNo, bytes32 root)',
  'event ClaimForwarded(uint256 indexed perkId, bytes32 indexed nullifier, bytes32 pickup, bytes32 root, uint64 batchNo, bytes32 indexed messageID)',
  'event RoleSet(uint256 indexed role, address indexed account, address indexed sender, uint256 oldRole)',
]);
const EVENTS = l1Abi.filter((x) => x.type === 'event');

/** Allow-list roles as the precompile stores them. */
export const ROLE_NONE = 0;
export const ROLE_ENABLED = 1;
export const ROLE_ADMIN = 2;
export const ROLE_MANAGER = 3;
export const roleName = (role: number) => ['None', 'Enabled', 'Admin', 'Manager'][role] ?? `Role ${role}`;
export const mayUse = (role: number) => role !== ROLE_NONE;

/** What the two roles mean for a wallet, in one sentence that follows its address. */
export function allowVerdict(send: number, deploy: number): string {
  if (!mayUse(send)) return 'is not on the TxAllowList: the node refuses its transactions before they reach a block.';
  const sends = `may send transactions (${roleName(send).toLowerCase()})`;
  return mayUse(deploy) ? `${sends} and deploy contracts (${roleName(deploy).toLowerCase()}).` : `${sends} but may not deploy contracts.`;
}

export interface L1Block { number: number; time: number; txs: number; gasUsed: bigint }
export interface L1Mirrored { batchNo: number; root: Hex; txHash: Hex; block: number; time?: number; sender?: Address }
export interface L1Forwarded { perkId: number; nullifier: Hex; pickup: Hex; root: Hex; batchNo: number; messageId: Hex; txHash: Hex; block: number; time?: number; sender?: Address }
export interface RoleChange { list: 'send' | 'deploy'; account: Address; role: number; oldRole: number; by: Address; txHash: Hex; block: number }
export interface AllowEntry {
  account: Address;
  /** Role on the TxAllowList and on the ContractDeployerAllowList, as read just now. */
  send: number;
  deploy: number;
  balance: bigint;
  /** Changes an admin made after the upgrade; an account with none got its role from the upgrade itself. */
  changes: RoleChange[];
  rootsDelivered: number;
  claimsSent: number;
}
export interface L1Perk { id: number; tableId: bigint; name: string; minPoints: bigint; claims: number }

export interface L1Live {
  chainId: number;
  head: number;
  headTime: number;
  gasLimit: bigint;
  mirror: { batchNo: number; root: Hex };
  perks: L1Perk[];
  mirrored: L1Mirrored[];
  forwarded: L1Forwarded[];
  allow: AllowEntry[];
  blocks: L1Block[];
}

/** [from, to] block spans no wider than the RPC accepts for eth_getLogs. */
export function logSpans(from: number, to: number, max: number): [number, number][] {
  const spans: [number, number][] = [];
  for (let a = from; a <= to; a += max) spans.push([a, Math.min(a + max - 1, to)]);
  return spans;
}

export type Sync = 'synced' | 'behind' | 'ahead' | 'mismatch';
/**
 * Compares what RootMirror holds with what ZkDB holds on Fuji. The same batch number must carry the same root; a
 * lower number on the L1 only means the newest root has not been sent yet.
 */
export function syncOf(mirror: { batchNo: number; root: string }, fuji: { batchCount: number; root: bigint }): Sync {
  if (mirror.batchNo < fuji.batchCount) return 'behind';
  if (mirror.batchNo > fuji.batchCount) return 'ahead';
  return BigInt(mirror.root) === fuji.root ? 'synced' : 'mismatch';
}

const lower = (a: string) => a.toLowerCase();

/**
 * One row per account that holds a role now or was given one since the upgrade. Roles and balances come from live
 * reads; the change list from RoleSet events; what the account did from the senders of the L1 transactions.
 * Admins first, then by address.
 */
export function buildAllowList(
  roles: { account: Address; send: number; deploy: number; balance: bigint }[],
  changes: RoleChange[],
  mirrored: { sender?: Address }[],
  forwarded: { sender?: Address }[],
): AllowEntry[] {
  const count = (list: { sender?: Address }[], a: Address) => list.filter((x) => x.sender && lower(x.sender) === lower(a)).length;
  const rank = (e: { send: number; deploy: number }) => (e.send === ROLE_ADMIN || e.deploy === ROLE_ADMIN ? 0 : mayUse(e.deploy) ? 1 : mayUse(e.send) ? 2 : 3);
  return roles
    .map((r) => ({
      ...r,
      changes: changes.filter((c) => lower(c.account) === lower(r.account)),
      rootsDelivered: count(mirrored, r.account),
      claimsSent: count(forwarded, r.account),
    }))
    .filter((e) => mayUse(e.send) || mayUse(e.deploy) || e.changes.length > 0)
    .sort((a, b) => rank(a) - rank(b) || (lower(a.account) < lower(b.account) ? -1 : 1));
}

/** Names for the contracts and precompiles a transaction on this L1 can touch. */
export function l1ContractNames(cfg: L1LiveConfig): Record<string, string> {
  return {
    [lower(cfg.mirror)]: 'RootMirror',
    [lower(cfg.gate)]: 'PointsGate',
    [lower(cfg.forwarder)]: 'ClaimForwarder',
    ...(cfg.verifier ? { [lower(cfg.verifier)]: 'ClaimVerifier' } : {}),
    [lower(TELEPORTER)]: 'TeleporterMessenger',
    [lower(TX_ALLOW_LIST)]: 'TxAllowList',
    [lower(DEPLOYER_ALLOW_LIST)]: 'ContractDeployerAllowList',
    [lower(WARP)]: 'Warp',
  };
}

/** topic0 of the events these contracts emit, checked against the L1's own logs. */
const EVENT_NAMES: Record<string, string> = {
  '0x43fc9ea9c132009dbbdd15fda744b455d9dc275f246ce7905dc1138569283a82': 'RootMirrored',
  '0x0f5a99f380e949f30484f439c49321c2d9b319db09783ff8e81ddd22bed785ea': 'ClaimForwarded',
  '0x9549e2f4c662f9d29e21ef5836af226c16d28a415d0917e6098dc1170664c920': 'PerkClaimed',
  '0x5f16758466a7e4f5dc177594d290eacc2f117b225261b9303e7eb7ee8d8fb986': 'PerkAdded',
  '0xcdb7ea01f00a414d78757bdb0f6391664ba3fedf987eed280927c1e7d695be3e': 'RoleSet',
  '0x292ee90bbaf70b5d4936025e09d56ba08f3e421156b6a568cf3c2840d9343e34': 'ReceiveCrossChainMessage',
  '0x34795cc6b122b9a0ae684946319f1e14a577b4e8f9b3dda9ac94c21a54d3188c': 'MessageExecuted',
  '0x4619adc1017b82e02eaefac01a43d50d6d8de4460774bc370c3ff0210d40c985': 'MessageExecutionFailed',
  '0x2a211ad4a59ab9d003852404f9c57c690704ee755f3c79d2c2812ad32da99df8': 'SendCrossChainMessage',
  '0xd13a7935f29af029349bed0a2097455b91fd06190a30478c575db3f31e00bf57': 'ReceiptReceived',
  '0x56600c567728a800c0aa927500f831cb451df66a7af570eb4df4dfbf4674887d': 'SendWarpMessage',
};
export const eventName = (topic0?: string) => (topic0 && EVENT_NAMES[lower(topic0)]) || undefined;

const CALLS = [
  'claimAndForward(bytes,uint256,bytes32,bytes32)',
  'claim(bytes,uint256,bytes32,bytes32)',
  'addPerk(uint256,uint64,string)',
  'setEnabled(address)',
  'setNone(address)',
  'setAdmin(address)',
  'setManager(address)',
];
const CALL_NAMES: Record<string, string> = {
  ...Object.fromEntries(CALLS.map((sig) => [toFunctionSelector(`function ${sig}`), sig.slice(0, sig.indexOf('('))])),
  // receiveCrossChainMessage(uint32 messageIndex, address relayerRewardAddress), as sent by the ICM relayer.
  '0xccb5f809': 'receiveCrossChainMessage',
};
/** What a transaction called, from its first four bytes; a deploy has no `to`. */
export function callName(input: string, to: string | null): string {
  if (!to) return 'Contract deployment';
  if (input.length < 10) return 'Transfer';
  return CALL_NAMES[lower(input.slice(0, 10))] ?? input.slice(0, 10);
}

export interface L1TxView {
  hash: Hex;
  status: 'success' | 'reverted';
  block: number;
  time: number;
  from: Address;
  to: Address | null;
  created?: Address | null;
  call: string;
  gasUsed: bigint;
  fee: bigint;
  logs: { address: Address; name?: string }[];
}

const MAX_LOG_RANGE = 2000; // the public RPC answers eth_getLogs for at most 2,048 blocks
const RECENT_BLOCKS = 6;

const clientFor = (cfg: L1LiveConfig) =>
  // One HTTP request per read: the proxy takes JSON-RPC batches of up to 20 calls.
  createPublicClient({ transport: http(cfg.rpcUrl, { batch: { batchSize: 20, wait: 16 } }), cacheTime: 0 });

export function createL1Reader(cfg: L1LiveConfig, seed: Address[] = []) {
  const client = clientFor(cfg);
  const mirrored: L1Mirrored[] = [];
  const forwarded: L1Forwarded[] = [];
  const changes: RoleChange[] = [];
  // Mined blocks and transactions never change, so each is read once.
  const blocks = new Map<number, L1Block>();
  const senders = new Map<string, Address>();
  let scanned = -1;
  let chainId: number | undefined;

  const block = async (n: number): Promise<L1Block> => {
    const hit = blocks.get(n);
    if (hit) return hit;
    const b = await client.getBlock({ blockNumber: BigInt(n) });
    const view = { number: n, time: Number(b.timestamp), txs: b.transactions.length, gasUsed: b.gasUsed };
    blocks.set(n, view);
    return view;
  };
  const sender = async (hash: Hex): Promise<Address> => {
    const hit = senders.get(hash);
    if (hit) return hit;
    const from = (await client.getTransaction({ hash })).from;
    senders.set(hash, from);
    return from;
  };

  async function scan(head: number) {
    for (const [from, to] of logSpans(scanned + 1, head, MAX_LOG_RANGE)) {
      const logs = await client.getLogs({
        address: [cfg.mirror, cfg.forwarder, TX_ALLOW_LIST, DEPLOYER_ALLOW_LIST],
        events: EVENTS,
        fromBlock: BigInt(from),
        toBlock: BigInt(to),
      });
      for (const l of logs) {
        const at = { txHash: l.transactionHash, block: Number(l.blockNumber) };
        if (l.eventName === 'RootMirrored') {
          mirrored.push({ batchNo: Number(l.args.batchNo), root: l.args.root!, ...at });
        } else if (l.eventName === 'ClaimForwarded') {
          forwarded.push({ perkId: Number(l.args.perkId), nullifier: l.args.nullifier!, pickup: l.args.pickup!, root: l.args.root!, batchNo: Number(l.args.batchNo), messageId: l.args.messageID!, ...at });
        } else if (l.eventName === 'RoleSet') {
          changes.push({ list: lower(l.address) === lower(TX_ALLOW_LIST) ? 'send' : 'deploy', account: l.args.account!, role: Number(l.args.role), oldRole: Number(l.args.oldRole), by: l.args.sender!, ...at });
        }
      }
      scanned = to;
    }
  }

  return {
    head: async () => Number(await client.getBlockNumber()),

    async read(at?: number): Promise<L1Live> {
      const head = at ?? Number(await client.getBlockNumber());
      const tag = { blockNumber: BigInt(head) } as const;
      const [id, top, root, batchNo, perkCount] = await Promise.all([
        chainId ?? client.getChainId(),
        client.getBlock(tag),
        client.readContract({ address: cfg.mirror, abi: l1Abi, functionName: 'root', ...tag }),
        client.readContract({ address: cfg.mirror, abi: l1Abi, functionName: 'batchNo', ...tag }),
        client.readContract({ address: cfg.gate, abi: l1Abi, functionName: 'perkCount', ...tag }),
        scan(head),
      ]);
      chainId = id;
      blocks.set(head, { number: head, time: Number(top.timestamp), txs: top.transactions.length, gasUsed: top.gasUsed });

      const recent = Array.from({ length: Math.min(RECENT_BLOCKS, head + 1) }, (_, i) => head - i);
      const [perks, recentBlocks] = await Promise.all([
        Promise.all(Array.from({ length: Number(perkCount) }, async (_, i) => {
          const p = await client.readContract({ address: cfg.gate, abi: l1Abi, functionName: 'perk', args: [BigInt(i)], ...tag });
          return { id: i, tableId: p.tableId, name: p.name, minPoints: p.minPoints, claims: Number(p.claims) };
        })),
        Promise.all(recent.map(block)),
        ...[...mirrored, ...forwarded].map(async (x) => {
          x.time = (await block(x.block)).time;
          x.sender = await sender(x.txHash);
        }),
      ]);

      const accounts = [...new Map([...seed, ...changes.map((c) => c.account), ...[...mirrored, ...forwarded].map((x) => x.sender!)].map((a) => [lower(a), a])).values()];
      const roles = await Promise.all(accounts.map(async (account) => {
        const [send, deploy, balance] = await Promise.all([
          client.readContract({ address: TX_ALLOW_LIST, abi: l1Abi, functionName: 'readAllowList', args: [account], ...tag }),
          client.readContract({ address: DEPLOYER_ALLOW_LIST, abi: l1Abi, functionName: 'readAllowList', args: [account], ...tag }),
          client.getBalance({ address: account, ...tag }),
        ]);
        return { account, send: Number(send), deploy: Number(deploy), balance };
      }));

      return {
        chainId: id,
        head,
        headTime: Number(top.timestamp),
        gasLimit: top.gasLimit,
        mirror: { batchNo: Number(batchNo), root },
        perks,
        mirrored: [...mirrored].sort((a, b) => b.batchNo - a.batchNo),
        forwarded: [...forwarded].sort((a, b) => b.block - a.block),
        allow: buildAllowList(roles, changes, mirrored, forwarded),
        blocks: recentBlocks,
      };
    },
  };
}

/** The roles one address holds on both lists, read on demand. */
export async function readAllowRoles(cfg: L1LiveConfig, account: Address): Promise<{ send: number; deploy: number; balance: bigint }> {
  const client = clientFor(cfg);
  const [send, deploy, balance] = await Promise.all([
    client.readContract({ address: TX_ALLOW_LIST, abi: l1Abi, functionName: 'readAllowList', args: [account] }),
    client.readContract({ address: DEPLOYER_ALLOW_LIST, abi: l1Abi, functionName: 'readAllowList', args: [account] }),
    client.getBalance({ address: account }),
  ]);
  return { send: Number(send), deploy: Number(deploy), balance };
}

/** Whether a card already spent its nullifier for this perk on the L1 gate. */
export const claimedOnL1 = (cfg: L1LiveConfig, perkId: number, nullifier: Hex) =>
  clientFor(cfg).readContract({ address: cfg.gate, abi: l1Abi, functionName: 'claimed', args: [BigInt(perkId), nullifier] });

/** One L1 transaction with its receipt, for the in-app view: the L1 has no block explorer. */
export async function readL1Tx(cfg: L1LiveConfig, hash: Hex): Promise<L1TxView | null> {
  const client = clientFor(cfg);
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash }).catch(() => null),
    client.getTransactionReceipt({ hash }).catch(() => null),
  ]);
  if (!tx || !receipt) return null;
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  return {
    hash,
    status: receipt.status,
    block: Number(receipt.blockNumber),
    time: Number(block.timestamp),
    from: tx.from,
    to: tx.to,
    created: receipt.contractAddress,
    call: callName(tx.input, tx.to),
    gasUsed: receipt.gasUsed,
    fee: receipt.gasUsed * receipt.effectiveGasPrice,
    logs: receipt.logs.map((l) => ({ address: l.address, name: eventName(l.topics[0]) })),
  };
}

const POLL_MS = 8_000;

export interface L1LiveState { data?: L1Live; error?: string; checkedAt?: Date }

/**
 * Asks the L1 for its head every few seconds and re-reads everything only when a block was added: the L1 makes a
 * block when there is a transaction, so an idle chain costs one small request per poll. Keeps the last good read.
 */
export function useL1Live(cfg: L1LiveConfig | undefined, seed: Address[]): L1LiveState {
  const [state, setState] = useState<L1LiveState>({});
  useEffect(() => {
    if (!cfg) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let last: number | undefined;
    const reader = createL1Reader(cfg, seed);
    const tick = async () => {
      try {
        const head = await reader.head();
        if (head === last) {
          if (!cancelled) setState((s) => ({ ...s, error: undefined, checkedAt: new Date() }));
        } else {
          const data = await reader.read(head);
          last = head;
          if (!cancelled) setState({ data, checkedAt: new Date() });
        }
      } catch (e) {
        const err = e as { shortMessage?: string; message?: string };
        if (!cancelled) setState((s) => ({ ...s, error: err.shortMessage ?? err.message ?? String(e) }));
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [cfg, seed]);
  return state;
}
