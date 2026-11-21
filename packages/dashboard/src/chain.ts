import { createPublicClient, http, parseAbi, type Address, type Hex } from 'viem';
import type { Op } from '@zkdb/core';
import { createGlacier } from './glacier';
import { replay, type BatchEvent, type QueuedOp, type ReplayResult } from './replay';
import { readSchoolL1Config, type SchoolL1Config } from './schoolL1';

export const zkdbAbi = parseAbi([
  'function root() view returns (bytes32)',
  'function owner() view returns (address)',
  'function batchVerifier() view returns (address)',
  'function batchCount() view returns (uint64)',
  'function head() view returns (uint64)',
  'function nextRowId() view returns (uint64)',
  'function pendingOps() view returns (uint64)',
  'function isWriter(address) view returns (bool)',
  'function tableAuditor(uint256) view returns (address)',
  'function setWriter(address writer, bool allowed)',
  'function setTableOwner(uint256 tableId, address writer)',
  'function setTableAuditor(uint256 tableId, address auditor)',
  'function insert(uint256 tableId, uint256[6] fields) returns (uint64 rowId, uint64 opId)',
  'function enqueue(uint8 opcode, uint64 rowId, uint256 a, uint256[6] v) returns (uint64 opId)',
  'function proposeChange(uint8 opcode, uint64 rowId, uint256 a, uint256[6] v) returns (uint64 id)',
  'function approveChange(uint64 id, uint256[9] op) returns (uint64 opId)',
  'function declineChange(uint64 id, uint256[9] op)',
  'function submitBatch(bytes proof, bytes32 newRoot, bool[16] ok, uint256[9][] ops)',
  'error NotOwner()',
  'error NotWriter()',
  'error NotTableOwner()',
  'error NotAuditor()',
  'error NeedsAuditor()',
  'error AuditorIsWriter()',
  'error ProposalClosed()',
  'error ProposalMismatch()',
  'error BadOpcode()',
  'error RowOutOfRange()',
  'error RowLimit()',
  'error FieldOverflow()',
  'error EmptyBatch()',
  'error TooManyOps()',
  'error OpMismatch(uint256 index)',
  'error InvalidProof()',
  'event WriterSet(address indexed writer, bool allowed)',
  'event TableOwnerSet(uint256 indexed tableId, address indexed writer)',
  'event TableAuditorSet(uint256 indexed tableId, address indexed auditor)',
  'event OpQueued(uint64 indexed opId, address indexed by, uint256[9] op)',
  'event ChangeProposed(uint64 indexed id, address indexed by, uint256[9] op)',
  'event ChangeApproved(uint64 indexed id, address indexed by, uint64 opId)',
  'event ChangeDeclined(uint64 indexed id, address indexed by)',
  'event BatchSubmitted(uint64 indexed batchNo, bytes32 oldRoot, bytes32 newRoot, uint64 fromOp, uint64 toOp, bool[16] ok)',
]);

export const gateAbi = parseAbi([
  'struct Perk { uint256 tableId; uint64 minPoints; uint64 claims; string name; }',
  'function perkCount() view returns (uint256)',
  'function perk(uint256 perkId) view returns (Perk)',
  'function claimed(uint256 perkId, bytes32 nullifier) view returns (bool)',
  'function pickupState(uint256 perkId, bytes32 pickup) view returns (uint8)',
  'function pickupHash(bytes32 code) pure returns (bytes32)',
  'function claim(bytes proof, uint256 perkId, bytes32 nullifier, bytes32 pickup)',
  'function collect(uint256 perkId, bytes32 code)',
  'error UnknownPerk()',
  'error AlreadyClaimed()',
  'error PickupTaken()',
  'error NothingToCollect()',
  'error InvalidProof()',
  'event PerkClaimed(uint256 indexed perkId, bytes32 indexed nullifier, bytes32 indexed pickup, bytes32 root)',
  'event PerkCollected(uint256 indexed perkId, bytes32 indexed pickup)',
]);

export const relayAbi = parseAbi([
  'function relay() returns (bytes32 messageID)',
  'function lastRelayedBatch() view returns (uint64)',
  'function mirror() view returns (address)',
  'error NothingNew()',
  'event RootRelayed(uint64 indexed batchNo, bytes32 root, bytes32 indexed messageID)',
]);

export const teleporterAbi = parseAbi([
  'function messageReceived(bytes32 messageID) view returns (bool)',
  // Non-zero while a received message is stored because calling its destination failed (it can be retried).
  'function receivedFailedMessageHashes(bytes32 messageID) view returns (bytes32)',
]);

/** Where each proven root is sent over Avalanche ICM, and how to check that it arrived. */
export interface IcmConfig {
  relay: Address;
  /** Name of the destination L1, e.g. "Dispatch L1". */
  name: string;
  rpcUrl: string;
  teleporter: Address;
  explorer?: string;
}

export interface ChainConfig {
  rpcUrl: string;
  address: Address;
  fromBlock: bigint;
  /** Largest block span one eth_getLogs call may cover. Public RPCs cap it (publicnode Fuji: 50,000). */
  logRange?: bigint;
  /** Display name of the network, e.g. "Avalanche Fuji". */
  network?: string;
  /** Native coin symbol used for fees, e.g. "AVAX". */
  currency?: string;
  /** Block explorer base URL, e.g. https://testnet.snowtrace.io */
  explorer?: string;
  /** PointsGate: perks claimed with a zero-knowledge proof against the root. */
  gate?: Address;
  icm?: IcmConfig;
  /** The school's own L1: the Fuji contracts that send it roots and receive its claim receipts. */
  l1?: SchoolL1Config;
  /** Avalanche Data API base for this chain, e.g. https://data-api.avax.network/v1/chains/43113 */
  dataApi?: string;
  /** A network whose live base fee is used to say what a testnet fee would cost there. */
  priceRef?: { name: string; rpcUrl: string };
}

const addressOf = (v?: string) => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined);

export function readConfig(env: Record<string, string | undefined> = import.meta.env): ChainConfig | null {
  const address = env.VITE_ZKDB_ADDRESS;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return {
    address: address as Address,
    rpcUrl: env.VITE_RPC_URL || 'http://127.0.0.1:8545',
    fromBlock: BigInt(env.VITE_ZKDB_FROM_BLOCK || 0),
    logRange: env.VITE_LOG_RANGE ? BigInt(env.VITE_LOG_RANGE) : undefined,
    network: env.VITE_NETWORK_NAME || undefined,
    currency: env.VITE_CURRENCY || undefined,
    explorer: env.VITE_EXPLORER_URL?.replace(/\/$/, '') || undefined,
    gate: addressOf(env.VITE_GATE_ADDRESS),
    icm: addressOf(env.VITE_RELAY_ADDRESS) && addressOf(env.VITE_ICM_TELEPORTER) && env.VITE_ICM_RPC_URL ? {
      relay: addressOf(env.VITE_RELAY_ADDRESS)!,
      teleporter: addressOf(env.VITE_ICM_TELEPORTER)!,
      rpcUrl: env.VITE_ICM_RPC_URL,
      name: env.VITE_ICM_NAME || 'another L1',
      explorer: env.VITE_ICM_EXPLORER_URL?.replace(/\/$/, '') || undefined,
    } : undefined,
    l1: readSchoolL1Config(env),
    dataApi: env.VITE_DATA_API_URL || undefined,
    priceRef: env.VITE_PRICE_REF_RPC_URL ? { name: env.VITE_PRICE_REF_NAME || 'mainnet', rpcUrl: env.VITE_PRICE_REF_RPC_URL } : undefined,
  };
}

export interface Snapshot extends ReplayResult {
  chainId: number;
  block: bigint;
  address: Address;
  root: bigint;
  owner: Address;
  verifier: Address;
  batchCount: number;
  head: number;
  nextRowId: number;
  pending: number;
  writers: Address[];
  tableOwners: { tableId: bigint; writer: Address }[];
  tableAuditors: { tableId: bigint; auditor: Address }[];
  proposals: ProposedChange[];
  perks: Perk[];
  claims: PerkClaim[];
  relays: RootRelayed[];
}

/** A change that overwrites or takes away (SET, SUB, DELETE) on a table with an auditor. Queued only when the auditor approves. */
export interface ProposedChange {
  id: number;
  op: Op;
  proposer: Address;
  status: 'open' | 'approved' | 'declined';
  /** The auditor who approved or declined, or the proposer who withdrew. */
  decidedBy?: Address;
  /** The queued op an approval produced. */
  opId?: number;
  txHash: string;
  timestamp?: number;
}

export interface Perk { id: number; tableId: bigint; minPoints: bigint; claims: number; name: string }
export interface PerkClaim {
  perkId: number;
  nullifier: string;
  /** Hash of the member's one-time pickup code: who the claim is for. */
  pickup: string;
  /** The code was shown at the desk and the perk handed out. */
  collected: boolean;
  root: bigint;
  txHash: string;
  block: bigint;
}
export interface RootRelayed { batchNo: number; root: bigint; messageId: Hex; txHash: string }

/** Receipts and timestamps of mined txs never change, so each is fetched once. */
const receiptCache = new Map<string, { gasUsed: bigint; fee: bigint; timestamp: number }>();
const blockTimeCache = new Map<bigint, number>();

export function createReader(cfg: ChainConfig) {
  // viem caches the block number for seconds by default, which would make every snapshot here stale.
  const client = createPublicClient({ transport: http(cfg.rpcUrl), cacheTime: 0 });
  const contract = { address: cfg.address, abi: zkdbAbi } as const;
  const glacier = cfg.dataApi ? createGlacier(cfg.dataApi, cfg.address) : undefined;

  const batchDetails = async (txHash: Hex) => {
    const hit = receiptCache.get(txHash) ?? glacier?.get(txHash);
    if (hit) return hit;
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const details = { gasUsed: receipt.gasUsed, fee: receipt.gasUsed * receipt.effectiveGasPrice, timestamp: Number(block.timestamp) };
    receiptCache.set(txHash, details);
    return details;
  };

  /**
   * Logs are scanned once and kept: each snapshot only asks for blocks it has not seen yet, in spans the RPC accepts.
   * The newest TAIL blocks are always fetched fresh, so a load-balanced RPC node that lags a few blocks cannot
   * make the cache miss a log for good. Older blocks are final on both targets (anvil, Avalanche).
   */
  type Logs = Awaited<ReturnType<typeof fetchLogs>>;
  const fetchLogs = (fromBlock: bigint, toBlock: bigint) => {
    const range = { ...contract, fromBlock, toBlock };
    return Promise.all([
      client.getContractEvents({ ...range, eventName: 'OpQueued' }),
      client.getContractEvents({ ...range, eventName: 'BatchSubmitted' }),
      client.getContractEvents({ ...range, eventName: 'WriterSet' }),
      client.getContractEvents({ ...range, eventName: 'TableOwnerSet' }),
      client.getContractEvents({ ...range, eventName: 'TableAuditorSet' }),
      client.getContractEvents({ ...range, eventName: 'ChangeProposed' }),
      client.getContractEvents({ ...range, eventName: 'ChangeApproved' }),
      client.getContractEvents({ ...range, eventName: 'ChangeDeclined' }),
      cfg.gate ? client.getContractEvents({ address: cfg.gate, abi: gateAbi, eventName: 'PerkClaimed', fromBlock, toBlock }) : Promise.resolve([]),
      cfg.gate ? client.getContractEvents({ address: cfg.gate, abi: gateAbi, eventName: 'PerkCollected', fromBlock, toBlock }) : Promise.resolve([]),
      cfg.icm ? client.getContractEvents({ address: cfg.icm.relay, abi: relayAbi, eventName: 'RootRelayed', fromBlock, toBlock }) : Promise.resolve([]),
    ]);
  };
  const NO_LOGS = [[], [], [], [], [], [], [], [], [], [], []] as unknown as Logs;
  const join = (a: Logs, b: Logs) => a.map((k, i) => [...k, ...b[i]]) as Logs;
  const span = cfg.logRange ?? 1n << 62n;
  const TAIL = span < 64n ? span : 64n;
  /** fetchLogs over any range, split into spans the RPC accepts. */
  const fetchRange = async (from: bigint, to: bigint) => {
    let out: Logs = NO_LOGS;
    for (let a = from; a <= to; a += span) out = join(out, await fetchLogs(a, a + span - 1n < to ? a + span - 1n : to));
    return out;
  };
  let kept: Logs = NO_LOGS;
  let scanned = cfg.fromBlock - 1n;
  let scanning: Promise<void> = Promise.resolve();
  const logsUpTo = async (block: bigint): Promise<Logs> => {
    const stable = block - TAIL;
    const step = scanning.then(async () => {
      if (scanned < stable) {
        kept = join(kept, await fetchRange(scanned + 1n, stable));
        scanned = stable;
      }
    });
    // A failed scan must not poison the queue for every later snapshot.
    scanning = step.catch(() => {});
    await step;
    const base = kept.map((k) => k.filter((l) => l.blockNumber! <= block)) as Logs;
    return scanned < block ? join(base, await fetchRange(scanned + 1n, block)) : base;
  };

  return {
    blockNumber: () => client.getBlockNumber(),

    /** Every read uses one block. Otherwise a tx landing mid-read pairs an old root with new logs and looks like a mismatch. */
    async snapshot(at?: bigint): Promise<Snapshot> {
      const block = at ?? (await client.getBlockNumber());
      const state = { ...contract, blockNumber: block };
      const [chainId, root, owner, verifier, batchCount, head, nextRowId, pending] = await Promise.all([
        client.getChainId(),
        client.readContract({ ...state, functionName: 'root' }),
        client.readContract({ ...state, functionName: 'owner' }),
        client.readContract({ ...state, functionName: 'batchVerifier' }),
        client.readContract({ ...state, functionName: 'batchCount' }),
        client.readContract({ ...state, functionName: 'head' }),
        client.readContract({ ...state, functionName: 'nextRowId' }),
        client.readContract({ ...state, functionName: 'pendingOps' }),
      ]);
      const [opLogs, batchLogs, writerLogs, tableLogs, auditorLogs, proposedLogs, approvedLogs, declinedLogs, claimLogs, collectedLogs, relayLogs] = await logsUpTo(block);
      // One Data API request covers the sender, block time and fee of up to 100 transactions.
      await glacier?.ensure([...opLogs, ...batchLogs, ...proposedLogs].map((l) => l.transactionHash));

      const blockTime = async (n: bigint) => {
        const hit = blockTimeCache.get(n);
        if (hit !== undefined) return hit;
        const t = Number((await client.getBlock({ blockNumber: n })).timestamp);
        blockTimeCache.set(n, t);
        return t;
      };
      // Each block is read once, four at a time: a larger burst of parallel reads trips public RPC rate limits.
      const timed = [...opLogs, ...proposedLogs].filter((l) => !glacier?.get(l.transactionHash));
      const blocks = [...new Set(timed.map((l) => l.blockNumber!))].filter((n) => !blockTimeCache.has(n));
      for (let i = 0; i < blocks.length; i += 4) await Promise.all(blocks.slice(i, i + 4).map(blockTime));
      const timeOf = async (l: { transactionHash: string; blockNumber: bigint | null }) =>
        glacier?.get(l.transactionHash)?.timestamp ?? (await blockTime(l.blockNumber!));
      const ops: QueuedOp[] = [];
      for (const l of opLogs) {
        ops.push({ id: Number(l.args.opId!), op: [...l.args.op!], by: l.args.by!, txHash: l.transactionHash, timestamp: await timeOf(l) });
      }

      const proposed = new Map<number, ProposedChange>();
      for (const l of proposedLogs) {
        const id = Number(l.args.id!);
        proposed.set(id, { id, op: [...l.args.op!], proposer: l.args.by!, status: 'open', txHash: l.transactionHash, timestamp: await timeOf(l) });
      }
      for (const l of approvedLogs) {
        const c = proposed.get(Number(l.args.id!));
        if (c) Object.assign(c, { status: 'approved', decidedBy: l.args.by!, opId: Number(l.args.opId!) });
      }
      for (const l of declinedLogs) {
        const c = proposed.get(Number(l.args.id!));
        if (c) Object.assign(c, { status: 'declined', decidedBy: l.args.by! });
      }

      let perks: Perk[] = [];
      if (cfg.gate) {
        const gate = { address: cfg.gate, abi: gateAbi, blockNumber: block } as const;
        const count = Number(await client.readContract({ ...gate, functionName: 'perkCount' }));
        perks = await Promise.all(Array.from({ length: count }, async (_, id) => {
          const p = await client.readContract({ ...gate, functionName: 'perk', args: [BigInt(id)] });
          return { id, tableId: p.tableId, minPoints: p.minPoints, claims: Number(p.claims), name: p.name };
        }));
      }
      const batches: BatchEvent[] = await Promise.all(batchLogs.map(async (l) => ({
        batchNo: Number(l.args.batchNo!),
        oldRoot: BigInt(l.args.oldRoot!),
        newRoot: BigInt(l.args.newRoot!),
        fromOp: Number(l.args.fromOp!),
        toOp: Number(l.args.toOp!),
        ok: [...l.args.ok!],
        txHash: l.transactionHash,
        ...(await batchDetails(l.transactionHash)),
      })));

      // Logs arrive in chain order, so the last event per key wins.
      const writers = new Map<Address, boolean>();
      for (const l of writerLogs) writers.set(l.args.writer!, l.args.allowed!);
      const tables = new Map<bigint, Address>();
      for (const l of tableLogs) tables.set(l.args.tableId!, l.args.writer!);
      const auditors = new Map<bigint, Address>();
      for (const l of auditorLogs) auditors.set(l.args.tableId!, l.args.auditor!);

      return {
        ...replay(ops, batches, BigInt(root)),
        chainId,
        block,
        address: cfg.address,
        root: BigInt(root),
        owner,
        verifier,
        batchCount: Number(batchCount),
        head: Number(head),
        nextRowId: Number(nextRowId),
        pending: Number(pending),
        writers: [...writers].filter(([, allowed]) => allowed).map(([w]) => w),
        tableOwners: [...tables].map(([tableId, writer]) => ({ tableId, writer })).sort((a, b) => (a.tableId < b.tableId ? -1 : 1)),
        tableAuditors: [...auditors].filter(([, a]) => BigInt(a) !== 0n).map(([tableId, auditor]) => ({ tableId, auditor })),
        proposals: [...proposed.values()],
        perks,
        claims: claimLogs.map((l) => ({
          perkId: Number(l.args.perkId!), nullifier: l.args.nullifier!, pickup: l.args.pickup!, root: BigInt(l.args.root!), txHash: l.transactionHash, block: l.blockNumber!,
          collected: collectedLogs.some((c) => c.args.perkId === l.args.perkId && c.args.pickup === l.args.pickup),
        })),
        relays: relayLogs.map((l) => ({ batchNo: Number(l.args.batchNo!), root: BigInt(l.args.root!), messageId: l.args.messageID!, txHash: l.transactionHash })),
      };
    },
  };
}
