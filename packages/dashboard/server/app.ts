import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { BaseError, ContractFunctionRevertedError, createPublicClient, getAddress, hexToString, http, isAddress, parseEventLogs, toFunctionSelector, type Address, type Hex } from 'viem';
import { generateSiweNonce, parseSiweMessage } from 'viem/siwe';
import { buildBatch, initHash, K, ZkDbState, type BatchInput } from '@zkdb/core';
import { createReader, gateAbi, zkdbAbi, type ChainConfig } from '../src/chain';
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

const DEMO_COOKIE = 'zkdb_demo';
const selectors = (...signatures: string[]) => signatures.map((sig) => toFunctionSelector(`function ${sig}`));
const SUBMIT = 'submitBatch(bytes,bytes32,bool[16],uint256[9][])';
const PROPOSE = 'proposeChange(uint8,uint64,uint256,uint256[6])';
const DECLINE = 'declineChange(uint64,uint256[9])';
/** What each demo role may call: `db` is ZkDB, `relay` is RootRelay, `gate` is PointsGate (handing a perk out). */
const DEMO_CALLS: Record<DemoRole, { db: Hex[]; relay: Hex[]; gate: Hex[] }> = {
  owner: { db: selectors('setWriter(address,bool)', 'setTableOwner(uint256,address)', 'setTableAuditor(uint256,address)', SUBMIT), relay: selectors('relay()'), gate: [] },
  treasurer: {
    db: selectors('insert(uint256,uint256[6])', 'enqueue(uint8,uint64,uint256,uint256[6])', PROPOSE, DECLINE, SUBMIT),
    relay: selectors('relay()'),
    gate: selectors('collect(uint256,bytes32)'),
  },
  auditor: { db: selectors('approveChange(uint64,uint256[9])', DECLINE, SUBMIT), relay: selectors('relay()'), gate: [] },
};

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
  /** Present only when the server was started with ZKDB_DEMO=1. Without it the demo routes do not exist. */
  demo?: DemoOptions;
  /** Most claims the relayer sends per hour, so a script cannot spend its gas. Default 60. */
  relayPerHour?: number;
  /** The points table: its auditor may run the prover too. Default 1. */
  programTable?: bigint;
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
  async function relayClaim(body: unknown) {
    if (!opts.relayer || !opts.chain.gate) throw new HttpError(503, 'no_relayer', 'This server does not relay claims.');
    const { proof, perkId, nullifier, pickup } = (body ?? {}) as { proof?: unknown; perkId?: unknown; nullifier?: unknown; pickup?: unknown };
    if (!hex(proof) || proof.length > 2 + 2 * 16_384 || !hex(nullifier, 32) || !hex(pickup, 32) || typeof perkId !== 'number' || !Number.isInteger(perkId) || perkId < 0) {
      throw new HttpError(400, 'bad_request', 'proof, perkId, nullifier and pickup are required.');
    }
    // The relayer's gas is the club's money: cap what one hour can spend before doing any work for the request.
    const hourAgo = Date.now() - 3_600_000;
    while (relayed.length && relayed[0] < hourAgo) relayed.shift();
    if (relayed.length >= (opts.relayPerHour ?? 60)) throw new HttpError(429, 'rate_limited', 'Too many claims this hour. Try again later.');
    const call = { address: opts.chain.gate, abi: gateAbi, functionName: 'claim', args: [proof, BigInt(perkId), nullifier, pickup] } as const;
    try {
      await client.simulateContract(call);
    } catch (e) {
      const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
      const name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
      if (name === 'AlreadyClaimed') throw new HttpError(409, 'already_claimed', 'This card has already claimed this perk.');
      if (name === 'PickupTaken') throw new HttpError(409, 'pickup_taken', 'That pickup code was used before. Try again.');
      if (name === 'UnknownPerk') throw new HttpError(404, 'unknown_perk', 'That perk does not exist.');
      throw new HttpError(409, 'invalid_proof', 'The gate rejected the proof. If a new proof of changes just landed, try again.');
    }
    relayed.push(Date.now());
    const { encodeFunctionData } = await import('viem');
    const gas = (await client.estimateContractGas(call)) * 12n / 10n;
    const txHash = await opts.relayer({ to: opts.chain.gate, data: encodeFunctionData(call), gas });
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, pollingInterval: 500 });
    if (receipt.status !== 'success') throw new HttpError(409, 'reverted', 'The claim transaction reverted.');
    return { txHash, gasUsed: receipt.gasUsed.toString() };
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
        : to !== '' && to === opts.chain.icm?.relay.toLowerCase() ? DEMO_CALLS[account.role].relay
          : to !== '' && to === opts.chain.gate?.toLowerCase() ? DEMO_CALLS[account.role].gate
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
