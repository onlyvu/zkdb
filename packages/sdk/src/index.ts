/**
 * @zkdb/sdk: a proven ledger for any app, on any EVM chain (tested on anvil and used on Avalanche Fuji).
 *
 * Three jobs:
 *   1. createLedger / attachLedger: deploy (or open) ZkDB + its batch verifier, and a threshold gate + its verifier.
 *   2. writeBatch: queue changes (insert, set, add, sub, delete), prove "old root → new root by the rules" with the
 *      batch circuit (UltraHonk), and submit; ZkDB accepts the new root only if the verifier accepts the proof.
 *   3. proveThreshold / checkThreshold / submitThreshold: prove in zero knowledge "a row in this table, whose secret I
 *      hold, has at least N in its balance field", check it on-chain for free, or record it (one claim per row).
 *
 * Row layout the threshold circuit expects: [id, balance, key, x, x, x] where key = Poseidon2(secret). Use rowOf().
 * The library knows nothing about clubs, points or perks; those words live in the dashboard app only.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BaseError, ContractFunctionRevertedError, parseAbiItem, parseEventLogs,
  type Abi, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient,
} from 'viem';
import {
  buildBatch, buildClaim, cardKey, encodeAdd, encodeDelete, encodeSet, encodeSub, initHash, K, OPCODE, P, ZkDbState,
  type Op, type Row,
} from '@zkdb/core';
import { loadCircuit, loadClaimCircuit, proveBatch } from '@zkdb/core/prover';
import { proveClaim } from '@zkdb/core/claim-prover';

export { cardKey, K, ZkDbState, type Row };

type Wallet = WalletClient<Transport, Chain | undefined, Account>;
interface Artifact { abi: Abi; bytecode: Hex }
export interface Artifacts { ZkDB: Artifact; BatchVerifier: Artifact; PointsGate: Artifact; ClaimVerifier: Artifact }

/** Reads compiled contracts from Foundry's out/ directory (run `forge build` in contracts/ first). */
export function loadArtifacts(outDir = fileURLToPath(new URL('../../../contracts/out', import.meta.url))): Artifacts {
  const one = (name: string): Artifact => {
    const a = JSON.parse(readFileSync(`${outDir}/${name}.sol/${name}.json`, 'utf8'));
    return { abi: a.abi, bytecode: a.bytecode.object };
  };
  return { ZkDB: one('ZkDB'), BatchVerifier: one('BatchVerifier'), PointsGate: one('PointsGate'), ClaimVerifier: one('ClaimVerifier') };
}

/** A random secret inside the proof system's field (31 bytes). */
export function newSecret(): bigint {
  const b = crypto.getRandomValues(new Uint8Array(31));
  return BigInt(`0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`);
}

/** A row the threshold circuit can open: [id, balance, Poseidon2(secret), 0, 0, 0]. Call after `await ready()`. */
export const rowOf = (id: bigint, balance: bigint, secret: bigint): Row => [id, balance, cardKey(secret), 0n, 0n, 0n];

/** Loads the Poseidon2 hash (wasm). Call once before rowOf / cardKey. */
export const ready = () => initHash();

export const BALANCE_FIELD = 1;

export type Change =
  | { insert: { table: bigint; fields: Row } }
  | { set: { row: bigint; field: number; value: bigint } }
  | { add: { row: bigint; field: number; amount: bigint } }
  | { sub: { row: bigint; field: number; amount: bigint } }
  | { delete: { row: bigint } };

export interface BatchResult {
  txHash: Hex;
  gasUsed: bigint;
  newRoot: Hex;
  /** Per change: true if applied, false if the rules rejected it (e.g. sub below zero); the batch still lands. */
  ok: boolean[];
  provingMs: number;
}

export interface ThresholdClaim {
  thresholdId: bigint;
  proof: Hex;
  nullifier: Hex;
  pickup: Hex;
  provingMs: number;
}

const hex32 = (x: bigint) => `0x${x.toString(16).padStart(64, '0')}` as Hex;
const opQueued = parseAbiItem('event OpQueued(uint64 indexed opId, address indexed by, uint256[9] op)');

export interface LedgerOptions {
  pub: PublicClient;
  wallet: Wallet;
  address: Address;
  gate: Address;
  /** Block the ledger was deployed in, so the event replay does not scan the whole chain. */
  fromBlock: bigint;
  /** Largest block span per eth_getLogs (public Fuji RPCs cap it; publicnode allows 50,000). */
  logRange?: bigint;
  artifacts?: Artifacts;
}

export class Ledger {
  readonly address: Address;
  readonly gate: Address;
  readonly fromBlock: bigint;
  private readonly a: Artifacts;

  constructor(private readonly o: LedgerOptions) {
    this.address = o.address;
    this.gate = o.gate;
    this.fromBlock = o.fromBlock;
    this.a = o.artifacts ?? loadArtifacts();
  }

  private get db() { return { address: this.address, abi: this.a.ZkDB.abi } as const; }
  private get g() { return { address: this.gate, abi: this.a.PointsGate.abi } as const; }

  private async send(target: { address: Address; abi: Abi }, functionName: string, args: unknown[]) {
    const { request } = await this.o.pub.simulateContract({ ...target, functionName, args, account: this.o.wallet.account } as never);
    const hash = await this.o.wallet.writeContract(request as never);
    const receipt = await this.o.pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
    return receipt;
  }

  /** Gives a table to a writer (owner only). createLedger already gives `table` to the deploying wallet. */
  async grantTable(table: bigint, writer: Address) {
    if (!(await this.o.pub.readContract({ ...this.db, functionName: 'isWriter', args: [writer] }))) await this.send(this.db, 'setWriter', [writer, true]);
    await this.send(this.db, 'setTableOwner', [table, writer]);
  }

  /** Queues changes, one transaction each. Returns the op ids and, for inserts, the new row ids. */
  async queue(changes: Change[]): Promise<{ opIds: bigint[]; rowIds: (bigint | undefined)[]; txHashes: Hex[] }> {
    const opIds: bigint[] = [];
    const rowIds: (bigint | undefined)[] = [];
    const txHashes: Hex[] = [];
    for (const c of changes) {
      let r;
      if ('insert' in c) r = await this.send(this.db, 'insert', [c.insert.table, c.insert.fields]);
      else {
        const [op, row] = 'set' in c ? [encodeSet(0, c.set.field, c.set.value), c.set.row]
          : 'add' in c ? [encodeAdd(0, c.add.field, c.add.amount), c.add.row]
            : 'sub' in c ? [encodeSub(0, c.sub.field, c.sub.amount), c.sub.row]
              : [encodeDelete(0), c.delete.row];
        r = await this.send(this.db, 'enqueue', [Number(op[0]), row, op[2], op.slice(3)]);
      }
      const ev = parseEventLogs({ abi: [opQueued], logs: r.logs })[0];
      opIds.push(ev.args.opId);
      rowIds.push('insert' in c ? ev.args.op[1] : undefined);
      txHashes.push(r.transactionHash);
    }
    return { opIds, rowIds, txHashes };
  }

  /** Rebuilds the table from on-chain events. `state` is the proven state; `pending` the queued, unproven ops. */
  async replay(): Promise<{ state: ZkDbState; pending: Op[]; root: Hex }> {
    await initHash();
    const latest = await this.o.pub.getBlockNumber();
    const step = this.o.logRange ?? 50_000n;
    const ops: { id: bigint; op: Op }[] = [];
    for (let from = this.fromBlock; from <= latest; from += step) {
      const to = from + step - 1n > latest ? latest : from + step - 1n;
      const logs = await this.o.pub.getLogs({ address: this.address, event: opQueued, fromBlock: from, toBlock: to });
      for (const l of logs) ops.push({ id: l.args.opId!, op: [...l.args.op!] });
    }
    ops.sort((x, y) => (x.id < y.id ? -1 : 1));
    const [head, root] = await Promise.all([
      this.o.pub.readContract({ ...this.db, functionName: 'head' }) as Promise<bigint>,
      this.o.pub.readContract({ ...this.db, functionName: 'root' }) as Promise<Hex>,
    ]);
    const state = new ZkDbState();
    for (const o of ops.slice(0, Number(head))) state.applyOp(o.op);
    if (hex32(state.root) !== root) throw new Error(`Replay root ${hex32(state.root)} does not match the contract's ${root}.`);
    return { state, pending: ops.slice(Number(head)).map((o) => o.op), root };
  }

  /** Proves the next ≤16 queued ops and submits the proof. Anyone may call it: the proof is the permission. */
  async proveAndSubmit(): Promise<BatchResult> {
    const { state, pending } = await this.replay();
    if (pending.length === 0) throw new Error('Nothing queued.');
    const batch = buildBatch(state, pending.slice(0, K));
    const started = performance.now();
    const { proof } = await proveBatch(batch, loadCircuit());
    const provingMs = Math.round(performance.now() - started);
    const ops = pending.slice(0, batch.consumed);
    const r = await this.send(this.db, 'submitBatch', [`0x${Buffer.from(proof).toString('hex')}`, hex32(batch.newRoot), batch.ok, ops]);
    return { txHash: r.transactionHash, gasUsed: r.gasUsed, newRoot: hex32(batch.newRoot), ok: batch.ok.slice(0, ops.length), provingMs };
  }

  /** Job 2: queue the changes and prove them, in batches of up to 16. */
  async writeBatch(changes: Change[]): Promise<{ queued: Awaited<ReturnType<Ledger['queue']>>; batches: BatchResult[] }> {
    const queued = await this.queue(changes);
    const batches: BatchResult[] = [];
    while (((await this.o.pub.readContract({ ...this.db, functionName: 'pendingOps' })) as bigint) > 0n) batches.push(await this.proveAndSubmit());
    return { queued, batches };
  }

  /** Defines "at least `min` in the balance field of a row of `table`" as a claim people can prove. Gate admin only. */
  async addThreshold(table: bigint, min: bigint, name: string): Promise<bigint> {
    const r = await this.send(this.g, 'addPerk', [table, min, name]);
    const ev = parseEventLogs({ abi: this.a.PointsGate.abi, eventName: 'PerkAdded', logs: r.logs })[0] as unknown as { args: { perkId: bigint } };
    return ev.args.perkId;
  }

  /**
   * Job 3a: prove locally, in zero knowledge, that a row of the threshold's table whose key is Poseidon2(secret) has
   * at least the threshold. The proof is bound to the current proven root, to this threshold and to `pickup`
   * (any 248-bit value the claimer chooses, e.g. the hash of a one-time code). The secret never leaves this process.
   */
  async proveThreshold(thresholdId: bigint, secret: bigint, pickup = newSecret() >> 8n): Promise<ThresholdClaim> {
    const t = await this.o.pub.readContract({ ...this.g, functionName: 'perk', args: [thresholdId] }) as { tableId: bigint; minPoints: bigint };
    const { state } = await this.replay();
    const built = buildClaim(state, t.tableId, { id: thresholdId, minPoints: t.minPoints }, secret, pickup);
    if (!built.ok) throw new Error(built.reason === 'unknown_card' ? 'No proven row has this secret.' : `Balance ${built.balance} is below ${t.minPoints}.`);
    const started = performance.now();
    const { proof } = await proveClaim(built.input, loadClaimCircuit());
    return {
      thresholdId,
      proof: `0x${Buffer.from(proof).toString('hex')}`,
      nullifier: hex32(built.input.nullifier),
      pickup: hex32(built.input.pickup),
      provingMs: Math.round(performance.now() - started),
    };
  }

  /** Job 3b: does the on-chain verifier accept this claim against the current root? A free eth_call, no transaction. */
  async checkThreshold(c: ThresholdClaim): Promise<{ valid: boolean; reason?: string }> {
    try {
      await this.o.pub.simulateContract({ ...this.g, functionName: 'claim', args: [c.proof, c.thresholdId, c.nullifier, c.pickup], account: this.o.wallet.account });
      return { valid: true };
    } catch (e) {
      const rev = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
      return { valid: false, reason: rev instanceof ContractFunctionRevertedError ? rev.data?.errorName : (e as Error).message };
    }
  }

  /** Job 3c: record the claim on-chain (one per row and threshold: the nullifier is stored). Anyone may send it. */
  async submitThreshold(c: ThresholdClaim): Promise<{ txHash: Hex; gasUsed: bigint }> {
    const r = await this.send(this.g, 'claim', [c.proof, c.thresholdId, c.nullifier, c.pickup]);
    return { txHash: r.transactionHash, gasUsed: r.gasUsed };
  }
}

/** Opens a ledger that is already deployed. */
export const attachLedger = (o: LedgerOptions) => new Ledger(o);

/**
 * Job 1: deploys a new ledger (ZkDB + batch verifier, threshold gate + claim verifier, 4 contracts) and makes the
 * wallet the writer of `table`. The wallet becomes ZkDB's owner; hand that to an AdminGovernor for production.
 */
export async function createLedger(o: { pub: PublicClient; wallet: Wallet; table?: bigint; artifacts?: Artifacts }): Promise<Ledger> {
  const a = o.artifacts ?? loadArtifacts();
  await initHash();
  const deploy = async (art: Artifact, args: unknown[]) => {
    const hash = await o.wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args, account: o.wallet.account, chain: o.wallet.chain });
    const r = await o.pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`deploy reverted: ${hash}`);
    return r;
  };
  const v = await deploy(a.BatchVerifier, []);
  const db = await deploy(a.ZkDB, [v.contractAddress, hex32(new ZkDbState().root)]);
  const cv = await deploy(a.ClaimVerifier, []);
  const gate = await deploy(a.PointsGate, [db.contractAddress, cv.contractAddress]);
  const ledger = new Ledger({ pub: o.pub, wallet: o.wallet, address: db.contractAddress!, gate: gate.contractAddress!, fromBlock: v.blockNumber, artifacts: a });
  await ledger.grantTable(o.table ?? 1n, o.wallet.account.address);
  return ledger;
}

/** Guards for callers that take values from users. */
export const inField = (x: bigint) => x >= 0n && x < P;
export { OPCODE };
