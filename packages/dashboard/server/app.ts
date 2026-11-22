import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { BaseError, ContractFunctionRevertedError, createPublicClient, encodeFunctionData, getAddress, hexToString, http, isAddress, parseAbi, parseEventLogs, toFunctionSelector, type Address, type Hex } from 'viem';
import { generateSiweNonce, parseSiweMessage } from 'viem/siwe';
import { buildBatch, initHash, K, OPCODE, P, ZkDbState, type BatchInput } from '@zkdb/core';
import { createReader, gateAbi, relayAbi, zkdbAbi, type ChainConfig } from '../src/chain';
import { memoryStore, type MetaStore } from './meta';

const SESSION_MS = 8 * 60 * 60 * 1000;
const NONCE_MS = 5 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const MAX_NONCES = 5000;
const COOKIE = 'zkdb_session';

/** Sends a transaction from an account whose key this server holds, and returns its hash. */
export type SendTx = (tx: { to: Address; data: Hex; gas?: bigint }) => Promise<Hex>;

/**
 * Demo accounts are a recording aid, off unless the server is started with ZKDB_DEMO=1 (never in production).
 * With the flag, test keys from the server's local env file are offered in the sign-in dialog and the server signs
 * for them. It also hands the page the secrets of the seeded cards, so a claim can be shown. Because that makes
 * the server a signer, every demo request is checked five ways (see demoGuard) and the keys only sign sign-in
 * messages this server issued a nonce for, and calls on a short per-role list.
 */
export type DemoRole = 'owner' | 'treasurer' | 'auditor';
export interface DemoAccount {
  address: Address;
  label: string;
  role: DemoRole;
  signMessage: (raw: Hex) => Promise<Hex>;
  send: SendTx;
}
/** A seeded card whose secret the deploying machine kept, so a claim can be shown on camera. */
export interface DemoCard { card: string; secret: Hex }
export interface DemoOptions {
  accounts: DemoAccount[];
  /** Secrets of the seeded cards, from a local file that is never committed. */
  cards?: DemoCard[];
  /** Host headers the demo routes answer to: the dashboard's own (localhost:5173) and the API's (127.0.0.1:8788). */
  hosts: string[];
}

/**
 * The school L1 end of a claim: ClaimForwarder runs PointsGate there and sends the receipt to Fuji over ICM. The
 * relayer must be on the L1's TxAllowList; it pays the claim in the L1's own token.
 */
export interface L1RelayOptions {
  rpcUrl: string;
  forwarder: Address;
  relayer: SendTx;
  relayerAddress: Address;
}

/** ClaimForwarder, with the errors PointsGate raises through it. */
export const forwarderAbi = parseAbi([
  'function claimAndForward(bytes proof, uint256 perkId, bytes32 nullifier, bytes32 pickup) returns (bytes32 messageID)',
  'function gate() view returns (address)',
  'function mirror() view returns (address)',
  'error UnknownPerk()',
  'error AlreadyClaimed()',
  'error PickupTaken()',
  'error InvalidProof()',
  'event ClaimForwarded(uint256 indexed perkId, bytes32 indexed nullifier, bytes32 pickup, bytes32 root, uint64 batchNo, bytes32 indexed messageID)',
]);

/** What the server reads on the L1 before it relays there: the mirrored root and the gate's spent nullifiers. */
const l1ReadAbi = parseAbi([
  'function root() view returns (bytes32)',
  'function batchNo() view returns (uint64)',
  'function claimed(uint256 perkId, bytes32 nullifier) view returns (bool)',
]);
const registryReadAbi = parseAbi(['function recorded(uint256 perkId, bytes32 nullifier) view returns (bool)']);

const DEMO_COOKIE = 'zkdb_demo';
const selectors = (...signatures: string[]) => signatures.map((sig) => toFunctionSelector(`function ${sig}`));
const SUBMIT = 'submitBatch(bytes,bytes32,bool[16],uint256[9][])';
const PROPOSE = 'proposeChange(uint8,uint64,uint256,uint256[6])';
const DECLINE = 'declineChange(uint64,uint256[9])';
/** What each demo role may call: `db` is ZkDB, `relay` is RootRelay, `gate` is PointsGate (handing a perk out). */
const DEMO_CALLS: Record<DemoRole, { db: Hex[]; relay: Hex[]; gate: Hex[]; registry: Hex[] }> = {
  owner: { db: selectors('setWriter(address,bool)', 'setTableOwner(uint256,address)', 'setTableAuditor(uint256,address)', SUBMIT), relay: selectors('relay()'), gate: [], registry: [] },
  treasurer: {
    db: selectors('insert(uint256,uint256[6])', 'enqueue(uint8,uint64,uint256,uint256[6])', PROPOSE, DECLINE, SUBMIT),
    relay: selectors('relay()'),
    gate: selectors('collect(uint256,bytes32)'),
    // Handing out a perk that was claimed on the school L1: ClaimRegistry on this chain holds its receipt.
    registry: selectors('redeem(uint256,bytes32)'),
  },
  auditor: { db: selectors('approveChange(uint64,uint256[9])', DECLINE, SUBMIT), relay: selectors('relay()'), gate: [], registry: [] },
};

/**
 * Try-it mode for visitors with no wallet and no AVAX. A separate table, owned by a separate trial key, so a visitor
 * never touches the club's table. The visitor's browser makes the card secret and sends only its hash; the server
 * inserts the card, awards it points, proves the batch and sends it, all paid by the trial key. The claim is then
 * proved in the browser and sent by the claim relayer as usual. Every step is capped per hour and per visitor.
 */
export interface TrialOptions {
  /** Table the trial key owns. It must not be the club's table. */
  table: bigint;
  /** Perk on PointsGate for this table; its threshold must be at most `points`. */
  perkId: number;
  /** Points a new trial card is awarded. */
  points: bigint;
  /** The trial key: a writer that owns `table`, and pays for inserts, awards and batch proofs. */
  writer: { address: Address; send: SendTx };
  /** Trial cards per hour for everyone together. Default 20. */
  cardsPerHour?: number;
  /** Trial cards per visitor (IP) per day. Default 3. */
  cardsPerVisitor?: number;
  /** Trial batch proofs per hour. Default 20. */
  batchesPerHour?: number;
  /** Take the visitor's IP from the proxy in front (only behind a proxy you run): the last X-Forwarded-For entry. */
  trustProxy?: boolean;
  /** With trustProxy: a header only that proxy sets with the client's address, e.g. cf-connecting-ip behind Cloudflare. */
  clientIpHeader?: string;
}

/** Fields of a trial row, as on the club's table: [card number, balance, card key, 0, 0, 0]. */
export const TRIAL_BALANCE_FIELD = 1;
/** Reason code put on the trial award (op[4]), like the club's reason codes. */
export const TRIAL_REASON = 30n;

export interface Proof { proof: Uint8Array; }
export type Prover = (batch: BatchInput) => Promise<Proof>;

export interface AppOptions {
  chain: ChainConfig;
  /** Hosts a SIWE message and a browser Origin may name, such as localhost:5173. */
  domains: string[];
  secret: string;
  secureCookie?: boolean;
  prove: Prover;
  /** Where proving and confirmation times are kept. Defaults to memory. */
  meta?: MetaStore;
  /** Pays the gas of members' perk claims, so a member needs no wallet. Without it, claims cannot be relayed. */
  relayer?: SendTx;
  /** Relays claims to the school L1 as well. Without it, claims go to the gate on this chain only. */
  l1?: L1RelayOptions;
  /** Present only when the server was started with ZKDB_DEMO=1. Without it the demo routes do not exist. */
  demo?: DemoOptions;
  /** Most claims the relayer sends per hour, so a script cannot spend its gas. Default 60. */
  relayPerHour?: number;
  /** The points table: its auditor may run the prover too. Default 1. */
  programTable?: bigint;
  /** Try-it mode. Without it the /api/trial routes answer 404. */
  trial?: TrialOptions;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const toHex = (x: bigint) => `0x${x.toString(16).padStart(64, '0')}` as const;

export function createApp(opts: AppOptions): RequestListener {
  const client = createPublicClient({ transport: http(opts.chain.rpcUrl) });
  const reader = createReader(opts.chain);
  const contract = { address: opts.chain.address, abi: zkdbAbi } as const;
  const nonces = new Map<string, number>();
  const meta = opts.meta ?? memoryStore();
  let proving = false;
  let relaying = false;
  const demo = new Map((opts.demo?.accounts ?? []).map((a) => [a.address.toLowerCase(), a]));
  /** New on every launch. It reaches the dashboard page as an HttpOnly, SameSite=Strict cookie and nowhere else. */
  const demoToken = randomBytes(32).toString('base64url');

  const sign = (payload: string) => createHmac('sha256', opts.secret).update(payload).digest('base64url');

  function issueSession(address: Address): string {
    const payload = Buffer.from(JSON.stringify({ address, exp: Date.now() + SESSION_MS })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }

  function readSession(req: IncomingMessage): Address | null {
    const raw = req.headers.cookie?.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!raw) return null;
    const [payload, mac] = raw.split('.');
    if (!payload || !mac) return null;
    const given = Buffer.from(mac);
    const expected = Buffer.from(sign(payload));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const { address, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return typeof exp === 'number' && exp > Date.now() && isAddress(address) ? address : null;
    } catch {
      return null;
    }
  }

  const cookie = (value: string, maxAge: number) =>
    `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${opts.secureCookie ? '; Secure' : ''}`;

  function takeNonce(nonce: string): boolean {
    const now = Date.now();
    for (const [n, exp] of nonces) if (exp < now) nonces.delete(n);
    return nonces.delete(nonce);
  }

  async function verifySignIn(req: IncomingMessage): Promise<Address> {
    const body = await readJson(req);
    const { message, signature } = body as { message?: unknown; signature?: unknown };
    if (typeof message !== 'string' || typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      throw new HttpError(400, 'bad_request', 'A message and a signature are required.');
    }
    const parsed = parseSiweMessage(message);
    if (!parsed.nonce || !parsed.address || !parsed.domain) throw new HttpError(400, 'bad_request', 'This is not a valid sign-in message.');
    // Spend the nonce before anything else, so a rejected attempt cannot be retried with it.
    if (!takeNonce(parsed.nonce)) throw new HttpError(401, 'bad_nonce', 'This sign-in request expired. Try again.');
    if (!opts.domains.includes(parsed.domain)) throw new HttpError(401, 'bad_domain', `Sign-in is not allowed from ${parsed.domain}.`);
    if (parsed.chainId !== (await client.getChainId())) throw new HttpError(401, 'bad_chain', 'The wallet is on the wrong network.');
    const valid = await client.verifySiweMessage({ message, signature: signature as `0x${string}`, domain: parsed.domain, nonce: parsed.nonce });
    if (!valid) throw new HttpError(401, 'bad_signature', 'The signature is not valid.');
    return getAddress(parsed.address);
  }

  async function assertCanOperate(address: Address) {
    const [owner, writer, auditor] = await Promise.all([
      client.readContract({ ...contract, functionName: 'owner' }),
      client.readContract({ ...contract, functionName: 'isWriter', args: [address] }),
      client.readContract({ ...contract, functionName: 'tableAuditor', args: [opts.programTable ?? 1n] }),
    ]);
    if (address !== getAddress(owner) && !writer && address !== getAddress(auditor)) {
      throw new HttpError(403, 'forbidden', 'Only the owner, a writer or the auditor can run the prover.');
    }
  }

  /** Builds the next batch from the chain itself. Nothing from the browser reaches the prover. */
  async function proveNext() {
    await initHash();
    const snapshot = await reader.snapshot();
    if (!snapshot.matches) throw new HttpError(409, 'state_mismatch', 'The chain and the replay disagree, so no batch can be built.');
    if (snapshot.pending === 0) throw new HttpError(409, 'empty_queue', 'There are no queued ops to prove.');
    const ops = [...snapshot.ops].sort((a, b) => a.id - b.id);
    const state = new ZkDbState();
    for (const o of ops.slice(0, snapshot.head)) state.applyOp(o.op);
    const pending = ops.slice(snapshot.head, snapshot.head + K).map((o) => o.op);
    const batch = buildBatch(state, pending);
    const started = performance.now();
    const { proof } = await opts.prove(batch);
    const provingMs = Math.round(performance.now() - started);
    meta.update(toHex(batch.newRoot), { provingMs, provedAt: Date.now() });
    return {
      provingMs,
      proof: `0x${Buffer.from(proof).toString('hex')}`,
      newRoot: toHex(batch.newRoot),
      ok: batch.ok,
      ops: pending.map((op) => op.map(toHex)),
      consumed: batch.consumed,
    };
  }

  /**
   * Stores how long a batch transaction took to be mined, as measured by the wallet that sent it. The transaction
   * must be a successful call to this contract whose BatchSubmitted event carries the given root.
   */
  async function recordConfirmation(body: unknown) {
    const { newRoot, txHash, confirmMs } = (body ?? {}) as { newRoot?: unknown; txHash?: unknown; confirmMs?: unknown };
    const hex32 = /^0x[0-9a-fA-F]{64}$/;
    if (typeof newRoot !== 'string' || !hex32.test(newRoot) || typeof txHash !== 'string' || !hex32.test(txHash)
      || typeof confirmMs !== 'number' || !Number.isFinite(confirmMs) || confirmMs < 0 || confirmMs > 600_000) {
      throw new HttpError(400, 'bad_request', 'newRoot, txHash and confirmMs are required.');
    }
    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` }).catch(() => null);
    const event = receipt?.status === 'success' && receipt.to?.toLowerCase() === opts.chain.address.toLowerCase()
      ? parseEventLogs({ abi: zkdbAbi, eventName: 'BatchSubmitted', logs: receipt.logs })[0]
      : undefined;
    if (!event || event.args.newRoot.toLowerCase() !== newRoot.toLowerCase()) {
      throw new HttpError(400, 'bad_tx', 'That transaction did not publish this proof.');
    }
    meta.update(newRoot, { txHash: txHash.toLowerCase(), confirmMs: Math.round(confirmMs) });
    return { ok: true };
  }

  const hex = (v: unknown, bytes?: number): v is Hex =>
    typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v) && (bytes === undefined || v.length === 2 + bytes * 2);

  /**
   * Relays a member's zero-knowledge claim to PointsGate. The proof is the permission: the server learns the perk
   * and the nullifier, never the card. The call is simulated first, so a claim the gate would refuse costs no gas.
   */
  const relayed: number[] = [];
  function claimArgs(body: unknown) {
    const { proof, perkId, nullifier, pickup } = (body ?? {}) as { proof?: unknown; perkId?: unknown; nullifier?: unknown; pickup?: unknown };
    if (!hex(proof) || proof.length > 2 + 2 * 16_384 || !hex(nullifier, 32) || !hex(pickup, 32) || typeof perkId !== 'number' || !Number.isInteger(perkId) || perkId < 0) {
      throw new HttpError(400, 'bad_request', 'proof, perkId, nullifier and pickup are required.');
    }
    // The relayer's gas is the club's money: cap what one hour can spend before doing any work for the request.
    const hourAgo = Date.now() - 3_600_000;
    while (relayed.length && relayed[0] < hourAgo) relayed.shift();
    if (relayed.length >= (opts.relayPerHour ?? 60)) throw new HttpError(429, 'rate_limited', 'Too many claims this hour. Try again later.');
    return [proof, BigInt(perkId), nullifier, pickup] as const;
  }

  /** Turns a refused simulation into the reason the member can act on. `stale` says what to do about a proof made against an older root. */
  function refuse(e: unknown, stale: string): never {
    const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    const name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
    if (name === 'AlreadyClaimed') throw new HttpError(409, 'already_claimed', 'This card has already claimed this perk.');
    if (name === 'PickupTaken') throw new HttpError(409, 'pickup_taken', 'That pickup code was used before. Try again.');
    if (name === 'UnknownPerk') throw new HttpError(404, 'unknown_perk', 'That perk does not exist.');
    throw new HttpError(409, 'invalid_proof', stale);
  }

  const l1Client = opts.l1 ? createPublicClient({ transport: http(opts.l1.rpcUrl) }) : undefined;
  /** The L1 gate and mirror are the ones the forwarder itself names, so they cannot drift from it. Read once. */
  let l1Contracts: Promise<{ gate: Address; mirror: Address }> | undefined;
  const l1Addresses = () => {
    l1Contracts ??= Promise.all([
      l1Client!.readContract({ address: opts.l1!.forwarder, abi: forwarderAbi, functionName: 'gate' }),
      l1Client!.readContract({ address: opts.l1!.forwarder, abi: forwarderAbi, functionName: 'mirror' }),
    ]).then(([gate, mirror]) => ({ gate, mirror }));
    l1Contracts.catch(() => { l1Contracts = undefined; });
    return l1Contracts;
  };

  /**
   * A nullifier is per card and perk, and the two gates keep separate lists of spent ones, so the contracts accept
   * the same card and perk once on Fuji and once on the school L1. This relayer declines to send the second one:
   * before relaying to either gate it asks every place a claim can be recorded (the Fuji gate, the L1 gate, and
   * ClaimRegistry, which holds the receipts from the L1), and relays nothing if one of them cannot be read.
   *
   * This is not enforcement. Anyone can call PointsGate on Fuji directly, and any wallet on the L1 TxAllowList can
   * call ClaimForwarder; neither goes through here. It only keeps this dashboard from making the second claim
   * itself, and lets the page say why. The fix belongs in the contracts and is not deployed (README, Limits).
   */
  async function spentOn(perkId: bigint, nullifier: Hex): Promise<'fuji' | 'l1' | null> {
    try {
      const [onGate, onRegistry, onL1] = await Promise.all([
        opts.chain.gate ? client.readContract({ address: opts.chain.gate, abi: gateAbi, functionName: 'claimed', args: [perkId, nullifier] }) : false,
        opts.chain.l1 ? client.readContract({ address: opts.chain.l1.registry, abi: registryReadAbi, functionName: 'recorded', args: [perkId, nullifier] }) : false,
        l1Client ? l1Addresses().then(({ gate }) => l1Client.readContract({ address: gate, abi: l1ReadAbi, functionName: 'claimed', args: [perkId, nullifier] })) : false,
      ]);
      return onGate ? 'fuji' : onRegistry || onL1 ? 'l1' : null;
    } catch {
      throw new HttpError(503, 'check_failed', 'Could not check whether this card already claimed this perk on the other chain. Try again shortly.');
    }
  }

  /** One relay per card and perk at a time through this server, so two of its own requests cannot both pass the checks above. */
  const inFlight = new Set<string>();
  async function oneAtATime<T>(perkId: bigint, nullifier: Hex, work: () => Promise<T>): Promise<T> {
    const key = `${perkId}:${nullifier.toLowerCase()}`;
    if (inFlight.has(key)) throw new HttpError(409, 'claim_in_flight', 'This claim is already being relayed.');
    inFlight.add(key);
    try {
      return await work();
    } finally {
      inFlight.delete(key);
    }
  }

  async function relayClaim(body: unknown) {
    if (!opts.relayer || !opts.chain.gate) throw new HttpError(503, 'no_relayer', 'This server does not relay claims.');
    const gate = opts.chain.gate;
    const relayer = opts.relayer;
    const args = claimArgs(body);
    return oneAtATime(args[1], args[2], async () => {
      const spent = await spentOn(args[1], args[2]);
      if (spent === 'fuji') throw new HttpError(409, 'already_claimed', 'This card has already claimed this perk.');
      if (spent === 'l1') throw new HttpError(409, 'claimed_elsewhere', 'This card has already claimed this perk on the school L1.');
      const call = { address: gate, abi: gateAbi, functionName: 'claim', args } as const;
      try {
        await client.simulateContract(call);
      } catch (e) {
        refuse(e, 'The gate rejected the proof. If a new proof of changes just landed, try again.');
      }
      relayed.push(Date.now());
      const gas = (await client.estimateContractGas(call)) * 12n / 10n;
      const txHash = await relayer({ to: gate, data: encodeFunctionData(call), gas });
      const receipt = await client.waitForTransactionReceipt({ hash: txHash, pollingInterval: 500 });
      if (receipt.status !== 'success') throw new HttpError(409, 'reverted', 'The claim transaction reverted.');
      return { txHash, gasUsed: receipt.gasUsed.toString() };
    });
  }

  /**
   * The L1 gate checks a proof against whatever root RootMirror holds. While the newest root has not arrived
   * there, a proof made against the older one still passes, for points a later change may have taken away.
   * This relayer sends a claim to the L1 only while the mirror holds the batch number and root ZkDB holds on this
   * chain. Like the check above, that covers this server only: the L1 contracts do not know Fuji's latest batch.
   */
  async function assertL1RootCurrent() {
    let mirror: { batchNo: bigint; root: Hex };
    let ledger: { batchNo: bigint; root: Hex };
    try {
      const { mirror: address } = await l1Addresses();
      const [mirrorBatch, mirrorRoot, batchCount, root] = await Promise.all([
        l1Client!.readContract({ address, abi: l1ReadAbi, functionName: 'batchNo' }),
        l1Client!.readContract({ address, abi: l1ReadAbi, functionName: 'root' }),
        client.readContract({ ...contract, functionName: 'batchCount' }),
        client.readContract({ ...contract, functionName: 'root' }),
      ]);
      mirror = { batchNo: mirrorBatch, root: mirrorRoot };
      ledger = { batchNo: batchCount, root };
    } catch {
      throw new HttpError(503, 'check_failed', 'Could not read the root the school L1 holds. Try again shortly.');
    }
    if (mirror.batchNo !== ledger.batchNo || BigInt(mirror.root) !== BigInt(ledger.root)) {
      throw new HttpError(409, 'l1_root_behind', `The school L1 has not received the newest root yet: it holds #${mirror.batchNo}, the ledger is at #${ledger.batchNo}. Try again once the root is sent.`);
    }
  }

  /**
   * The same claim, sent to the school L1: ClaimForwarder has PointsGate there check the proof against the root
   * RootMirror holds, then sends the receipt to this chain over ICM. Same cap per hour as the claim above, same
   * checks first, and simulated before anything is sent.
   */
  async function relayClaimL1(body: unknown) {
    if (!opts.l1 || !l1Client) throw new HttpError(503, 'no_l1_relayer', 'This server does not relay claims to the school L1.');
    const l1 = opts.l1;
    const args = claimArgs(body);
    return oneAtATime(args[1], args[2], async () => {
      await assertL1RootCurrent();
      const spent = await spentOn(args[1], args[2]);
      if (spent === 'l1') throw new HttpError(409, 'already_claimed', 'This card has already claimed this perk on the school L1.');
      if (spent === 'fuji') throw new HttpError(409, 'claimed_elsewhere', 'This card has already claimed this perk on Fuji.');
      const call = { address: l1.forwarder, abi: forwarderAbi, functionName: 'claimAndForward', args, account: l1.relayerAddress } as const;
      try {
        await l1Client.simulateContract(call);
      } catch (e) {
        refuse(e, 'The gate on the school L1 rejected the proof.');
      }
      relayed.push(Date.now());
      const gas = (await l1Client.estimateContractGas(call)) * 12n / 10n;
      const { account: _from, ...data } = call;
      const txHash = await l1.relayer({ to: l1.forwarder, data: encodeFunctionData(data), gas });
      const receipt = await l1Client.waitForTransactionReceipt({ hash: txHash, pollingInterval: 500 });
      if (receipt.status !== 'success') throw new HttpError(409, 'reverted', 'The claim transaction reverted on the school L1.');
      const forwarded = parseEventLogs({ abi: forwarderAbi, eventName: 'ClaimForwarded', logs: receipt.logs })[0];
      return { txHash, gasUsed: receipt.gasUsed.toString(), messageId: forwarded?.args.messageID };
    });
  }

  /** A sliding one-hour (or one-day) window of timestamps. */
  const windowed = (list: number[], ms: number) => {
    const since = Date.now() - ms;
    while (list.length && list[0] < since) list.shift();
    return list;
  };
  const trialCards: number[] = [];
  const trialBatches: number[] = [];
  const trialByVisitor = new Map<string, number[]>();
  let trialBusy = false;

  /**
   * Who the per-visitor cap counts. Behind a proxy we run: the header only that proxy sets (clientIpHeader), else
   * the last X-Forwarded-For entry, which is the one the nearest proxy appended. Entries to its left are whatever
   * the client chose to send, so they are never used.
   */
  function visitorOf(req: IncomingMessage): string {
    const t = opts.trial;
    if (t?.trustProxy) {
      const named = t.clientIpHeader ? req.headers[t.clientIpHeader.toLowerCase()] : undefined;
      if (typeof named === 'string' && named.trim()) return named.trim();
      const fwd = req.headers['x-forwarded-for'];
      const last = (Array.isArray(fwd) ? fwd.join(',') : fwd)?.split(',').pop()?.trim();
      if (last) return last;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  async function sendAndWait(by: SendTx, call: Parameters<typeof encodeFunctionData>[0] & { address: Address }) {
    const gas = (await client.estimateContractGas({ ...(call as object), account: opts.trial!.writer.address } as never)) * 12n / 10n;
    const hash = await by({ to: call.address, data: encodeFunctionData(call), gas });
    const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 500 });
    if (receipt.status !== 'success') throw new HttpError(502, 'reverted', 'A trial transaction reverted.');
    return receipt;
  }

  function trialInfo() {
    const t = opts.trial;
    if (!t) return { enabled: false };
    return {
      enabled: true,
      table: t.table.toString(),
      perkId: t.perkId,
      points: t.points.toString(),
      writer: t.writer.address,
      cardsLeftThisHour: Math.max(0, (t.cardsPerHour ?? 20) - windowed(trialCards, 3_600_000).length),
      relayer: !!opts.relayer,
    };
  }

  /** Step 1: insert a card for the visitor's card key and award it the trial points. Two ops in the queue. */
  async function trialCard(req: IncomingMessage, body: unknown) {
    const t = opts.trial;
    if (!t) throw new HttpError(404, 'not_found', 'Try-it mode is off on this server.');
    const { cardKey } = (body ?? {}) as { cardKey?: unknown };
    if (!hex(cardKey, 32) || BigInt(cardKey) === 0n || BigInt(cardKey) >= P) throw new HttpError(400, 'bad_request', 'cardKey must be a field element (32-byte hex).');
    const visitor = visitorOf(req);
    const mine = windowed(trialByVisitor.get(visitor) ?? [], 86_400_000);
    if (mine.length >= (t.cardsPerVisitor ?? 3)) throw new HttpError(429, 'rate_limited', 'This visitor made enough trial cards today. Try again tomorrow.');
    if (windowed(trialCards, 3_600_000).length >= (t.cardsPerHour ?? 20)) throw new HttpError(429, 'rate_limited', 'Trial cards are used up for this hour. Try again later.');
    mine.push(Date.now());
    trialByVisitor.set(visitor, mine);
    trialCards.push(Date.now());

    const nextRow = await client.readContract({ ...contract, functionName: 'nextRowId' });
    const fields = [nextRow, 0n, BigInt(cardKey), 0n, 0n, 0n] as const;
    const ins = await sendAndWait(t.writer.send, { ...contract, functionName: 'insert', args: [t.table, fields] });
    const queued = parseEventLogs({ abi: zkdbAbi, eventName: 'OpQueued', logs: ins.logs })[0];
    if (!queued) throw new HttpError(502, 'no_event', 'The insert did not queue an op.');
    const rowId = queued.args.op[1];
    const v = [t.points, TRIAL_REASON, 0n, 0n, 0n, 0n] as const;
    const add = await sendAndWait(t.writer.send, { ...contract, functionName: 'enqueue', args: [Number(OPCODE.ADD), rowId, BigInt(TRIAL_BALANCE_FIELD), v] });
    return {
      rowId: rowId.toString(),
      card: rowId.toString(),
      points: t.points.toString(),
      txs: [
        { step: 'insert', hash: ins.transactionHash, gasUsed: ins.gasUsed.toString() },
        { step: 'award', hash: add.transactionHash, gasUsed: add.gasUsed.toString() },
      ],
    };
  }

  /** Step 2: prove the next batch of queued ops and submit it, paid by the trial key. */
  async function trialBatch() {
    const t = opts.trial;
    if (!t) throw new HttpError(404, 'not_found', 'Try-it mode is off on this server.');
    if (windowed(trialBatches, 3_600_000).length >= (t.batchesPerHour ?? 20)) throw new HttpError(429, 'rate_limited', 'Trial proofs are used up for this hour. Try again later.');
    const pending = await client.readContract({ ...contract, functionName: 'pendingOps' });
    if (pending === 0n) return { alreadyProven: true };
    trialBatches.push(Date.now());
    const proven = await proveNext();
    const sentAt = performance.now();
    const receipt = await sendAndWait(t.writer.send, {
      ...contract,
      functionName: 'submitBatch',
      args: [proven.proof as Hex, proven.newRoot, proven.ok as unknown as readonly [boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean], proven.ops.map((op) => op.map(BigInt)) as never],
    });
    meta.update(proven.newRoot, { txHash: receipt.transactionHash.toLowerCase(), confirmMs: Math.round(performance.now() - sentAt) });
    // The new root goes on to the other chains, as it does after a proof on the Manage page. Without this the school
    // L1 would keep checking claims against the root before the visitor's batch. The batch stands either way: anyone
    // can call relay() later, and the next root supersedes this one.
    const relayed: { to: string; txHash: Hex; gasUsed: string }[] = [];
    for (const r of [opts.chain.l1, opts.chain.icm]) {
      if (!r) continue;
      try {
        const sent = await sendAndWait(t.writer.send, { address: r.relay, abi: relayAbi, functionName: 'relay' });
        relayed.push({ to: r.name, txHash: sent.transactionHash, gasUsed: sent.gasUsed.toString() });
      } catch {
        // Left for the next relay() call.
      }
    }
    return { txHash: receipt.transactionHash, gasUsed: receipt.gasUsed.toString(), newRoot: proven.newRoot, provingMs: proven.provingMs, consumed: proven.consumed, relayed };
  }

  const readCookie = (req: IncomingMessage, name: string) =>
    req.headers.cookie?.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);

  /**
   * Every demo request must pass all of these, so another web page in the same browser, or a hostile site that
   * points its own name at 127.0.0.1 (DNS rebinding), cannot use the keys:
   *   1. the routes exist only with ZKDB_DEMO=1;
   *   2. the Host header is the dashboard's or the API's own local address;
   *   3. the request is not cross-site, and a signing request names an allowed Origin;
   *   4. a signing request carries the per-launch token cookie;
   *   5. (in route) POSTs are application/json, which a cross-site form cannot send without a preflight.
   */
  function demoGuard(req: IncomingMessage, signing: boolean) {
    if (!opts.demo) throw new HttpError(404, 'not_found', 'Not found.');
    if (!req.headers.host || !opts.demo.hosts.includes(req.headers.host)) throw new HttpError(403, 'bad_host', 'Demo accounts answer on the local dashboard only.');
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    const originOk = origin !== undefined && opts.domains.includes(safeHost(origin));
    if ((origin !== undefined && !originOk) || site === 'cross-site' || (signing && !originOk)) {
      throw new HttpError(403, 'bad_origin', 'This origin is not allowed.');
    }
    if (!signing) return;
    const given = Buffer.from(readCookie(req, DEMO_COOKIE) ?? '');
    const expected = Buffer.from(demoToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, 'bad_token', 'Open the sign-in dialog again.');
  }

  /** A sign-in message this server asked for: SIWE, for an allowed domain, this chain, this account, a live nonce. */
  async function isOwnSignIn(raw: Hex, account: Address): Promise<boolean> {
    let parsed;
    try {
      parsed = parseSiweMessage(hexToString(raw));
    } catch {
      return false;
    }
    const exp = parsed.nonce ? nonces.get(parsed.nonce) : undefined;
    return !!parsed.domain && opts.domains.includes(parsed.domain)
      && !!parsed.address && parsed.address.toLowerCase() === account.toLowerCase()
      && exp !== undefined && exp > Date.now()
      && parsed.chainId === (await client.getChainId());
  }

  /** The two wallet requests a demo account answers. Everything else goes to the RPC from the browser. */
  async function demoWallet(body: unknown) {
    const { address, method, params } = (body ?? {}) as { address?: unknown; method?: unknown; params?: unknown };
    const account = typeof address === 'string' ? demo.get(address.toLowerCase()) : undefined;
    if (!account) throw new HttpError(404, 'unknown_account', 'That demo account is not available.');
    const p = Array.isArray(params) ? params : [];
    if (method === 'personal_sign') {
      if (!hex(p[0]) || !(await isOwnSignIn(p[0], account.address))) throw new HttpError(403, 'not_sign_in', 'Demo accounts only sign this dashboard\'s sign-in message.');
      return { result: await account.signMessage(p[0]) };
    }
    if (method === 'eth_sendTransaction') {
      const tx = (p[0] ?? {}) as { to?: unknown; data?: unknown; gas?: unknown; value?: unknown };
      const to = typeof tx.to === 'string' ? tx.to.toLowerCase() : '';
      const allowed = to === opts.chain.address.toLowerCase() ? DEMO_CALLS[account.role].db
        : to !== '' && (to === opts.chain.icm?.relay.toLowerCase() || to === opts.chain.l1?.relay.toLowerCase()) ? DEMO_CALLS[account.role].relay
          : to !== '' && to === opts.chain.gate?.toLowerCase() ? DEMO_CALLS[account.role].gate
            : to !== '' && to === opts.chain.l1?.registry.toLowerCase() ? DEMO_CALLS[account.role].registry
              : [];
      const noValue = tx.value === undefined || (hex(tx.value) && BigInt(tx.value === '0x' ? 0 : tx.value) === 0n);
      if (!hex(tx.data) || tx.data.length < 10 || !allowed.includes(tx.data.slice(0, 10).toLowerCase() as Hex) || !noValue) {
        throw new HttpError(403, 'forbidden', `The demo ${account.label.toLowerCase()} account cannot make this call.`);
      }
      return { result: await account.send({ to: tx.to as Address, data: tx.data, gas: hex(tx.gas) ? BigInt(tx.gas) : undefined }) };
    }
    throw new HttpError(400, 'bad_request', 'Unsupported wallet request.');
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    const key = `${req.method} ${path}`;

    if (req.method === 'POST') {
      // SameSite=Strict blocks most cross-site posts; this also covers browsers and proxies that do not honour it.
      const origin = req.headers.origin;
      if (origin && !opts.domains.includes(safeHost(origin))) throw new HttpError(403, 'bad_origin', 'This origin is not allowed.');
      if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'bad_type', 'Send JSON.');
    }

    switch (key) {
      case 'GET /api/auth/nonce': {
        const nonce = generateSiweNonce();
        // Unused nonces expire; the map is also capped, oldest first, so it cannot grow without bound.
        const now = Date.now();
        for (const [n, exp] of nonces) if (exp < now || nonces.size >= MAX_NONCES) nonces.delete(n); else break;
        nonces.set(nonce, now + NONCE_MS);
        return send(res, 200, { nonce });
      }
      case 'POST /api/auth/verify': {
        const address = await verifySignIn(req);
        res.setHeader('Set-Cookie', cookie(issueSession(address), SESSION_MS / 1000));
        return send(res, 200, { address });
      }
      case 'POST /api/auth/logout':
        res.setHeader('Set-Cookie', cookie('', 0));
        return send(res, 200, {});
      case 'GET /api/auth/me':
        return send(res, 200, { address: readSession(req) });
      case 'POST /api/batches/prove': {
        const address = readSession(req);
        if (!address) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
        await assertCanOperate(address);
        if (proving) throw new HttpError(409, 'busy', 'A proof is already being generated. Try again shortly.');
        proving = true;
        try {
          return send(res, 200, await proveNext());
        } finally {
          proving = false;
        }
      }
      case 'GET /api/proofs/meta':
        return send(res, 200, meta.all());
      case 'POST /api/proofs/meta': {
        const address = readSession(req);
        if (!address) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
        await assertCanOperate(address);
        return send(res, 200, await recordConfirmation(await readJson(req)));
      }
      case 'POST /api/claims/relay': {
        if (relaying) throw new HttpError(409, 'busy', 'Another claim is being relayed. Try again shortly.');
        relaying = true;
        try {
          return send(res, 200, await relayClaim(await readJson(req)));
        } finally {
          relaying = false;
        }
      }
      case 'GET /api/claims/targets':
        // Where this server can send a claim, so the page only offers what will work.
        return send(res, 200, { fuji: !!(opts.relayer && opts.chain.gate), l1: !!opts.l1 });
      case 'POST /api/claims/relay-l1': {
        if (relaying) throw new HttpError(409, 'busy', 'Another claim is being relayed. Try again shortly.');
        relaying = true;
        try {
          return send(res, 200, await relayClaimL1(await readJson(req)));
        } finally {
          relaying = false;
        }
      }
      case 'GET /api/trial':
        return send(res, 200, trialInfo());
      case 'POST /api/trial/card':
      case 'POST /api/trial/batch': {
        if (!opts.trial) throw new HttpError(404, 'not_found', 'Try-it mode is off on this server.');
        // One trial transaction sequence at a time: the trial key's nonces stay in order, and proving is serialized.
        if (trialBusy || proving) throw new HttpError(409, 'busy', 'Another visitor is using the trial right now. Try again in a minute.');
        trialBusy = true;
        if (key === 'POST /api/trial/batch') proving = true;
        try {
          return send(res, 200, key === 'POST /api/trial/card' ? await trialCard(req, await readJson(req)) : await trialBatch());
        } finally {
          trialBusy = false;
          if (key === 'POST /api/trial/batch') proving = false;
        }
      }
      case 'GET /api/demo/accounts':
        demoGuard(req, false);
        // Listing the accounts is also what hands the page its token for this launch.
        res.setHeader('Set-Cookie', `${DEMO_COOKIE}=${demoToken}; HttpOnly; SameSite=Strict; Path=/api/demo`);
        return send(res, 200, { accounts: [...demo.values()].map((a) => ({ address: a.address, label: a.label })) });
      case 'POST /api/demo/wallet':
        demoGuard(req, true);
        return send(res, 200, await demoWallet(await readJson(req)));
      case 'POST /api/demo/cards':
        // Card secrets of the seeded story, for showing a claim on camera. Same guard as signing.
        demoGuard(req, true);
        return send(res, 200, { cards: opts.demo?.cards ?? [] });
      default:
        throw new HttpError(404, 'not_found', 'Not found.');
    }
  }

  return (req, res) => {
    route(req, res).catch((e) => {
      if (e instanceof HttpError) return send(res, e.status, { code: e.code, error: e.message });
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return send(res, 503, { code: 'circuit_missing', error: 'The circuit is not built yet. Run ./scripts/build-circuits.sh, then try again.' });
      }
      console.error(e);
      send(res, 500, { code: 'internal', error: 'The server could not complete this request.' });
    });
  };
}

/** Host part of an Origin header; an unparsable Origin matches nothing. */
function safeHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return '';
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'too_large', 'The request is too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new HttpError(400, 'bad_request', 'The request is not valid JSON.');
  }
}

export const randomSecret = () => randomBytes(32).toString('hex');
