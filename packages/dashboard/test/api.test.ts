import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, getAddress, http, type Abi, type Address, type Hex } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { foundry } from 'viem/chains';
import type { BatchInput } from '@zkdb/core';
import { createApp, type Prover } from '../server/app';
import { createReader } from '../src/chain';

// Real anvil and real contracts; only the prover is replaced, by the committed fixture proof.
const PORT = 8549;
const RPC = `http://127.0.0.1:${PORT}`;
const DOMAIN = 'localhost:5173';
const CONTRACTS = fileURLToPath(new URL('../../../contracts', import.meta.url));
const env = { ...process.env, PATH: `${homedir()}/.foundry/bin:${process.env.PATH}` };
const fixture = JSON.parse(readFileSync(`${CONTRACTS}/test/fixtures/batch_1.json`, 'utf8'));
const flat: bigint[] = fixture.realOpsFlat.map(BigInt);
const fixtureOps = Array.from({ length: fixture.nRealOps as number }, (_, i) => flat.slice(i * 9, i * 9 + 9));

const transport = http(RPC);
const pub = createPublicClient({ chain: foundry, transport, pollingInterval: 50 });
const wallet = createWalletClient({ chain: foundry, transport });
const artifact = (name: string): { abi: Abi; bytecode: Hex } => {
  const a = JSON.parse(readFileSync(`${CONTRACTS}/out/${name}.sol/${name}.json`, 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object };
};

let anvil: ChildProcess;
let server: Server;
let base: string;
let address: Address;
let owner: Address, writer: Address, stranger: Address;
let prove: Prover;
let lastBatch: BatchInput | undefined;
let batchTx: Hex;

const fixtureProver: Prover = async (b) => {
  lastBatch = b;
  return { proof: Buffer.from(fixture.proof.slice(2), 'hex') };
};

const post = (path: string, body: unknown, cookie?: string, origin?: string) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) },
  body: JSON.stringify(body),
});

async function signedMessage(account: Address, over: { domain?: string; nonce?: string } = {}) {
  const nonce = over.nonce ?? (await (await fetch(`${base}/api/auth/nonce`)).json()).nonce;
  const message = createSiweMessage({
    address: getAddress(account), chainId: foundry.id, domain: over.domain ?? DOMAIN, nonce, uri: `http://${DOMAIN}`, version: '1',
  });
  return { message, signature: await wallet.signMessage({ account, message }), nonce };
}

async function signIn(account: Address) {
  const res = await post('/api/auth/verify', await signedMessage(account));
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0];
}

const hasTools = spawnSync('anvil', ['--version'], { env }).status === 0;

describe.skipIf(!hasTools)('dashboard API', () => {
  beforeAll(async () => {
    spawnSync('forge', ['build'], { cwd: CONTRACTS, env });
    anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      if (await pub.getBlockNumber().then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    [owner, writer, stranger] = (await wallet.getAddresses()) as [Address, Address, Address];

    const deploy = async (name: string, args: unknown[]) => {
      const { abi, bytecode } = artifact(name);
      const hash = await wallet.deployContract({ abi, bytecode, args, account: owner });
      return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
    };
    const verifier = await deploy('BatchVerifier', []);
    address = await deploy('ZkDB', [verifier, fixture.emptyRoot]);
    const send = async (account: Address, functionName: string, args: unknown[]) => {
      const hash = await wallet.writeContract({ address, abi: artifact('ZkDB').abi, functionName, args, account });
      expect((await pub.waitForTransactionReceipt({ hash })).status).toBe('success');
    };
    await send(owner, 'setWriter', [writer, true]);
    await send(owner, 'setTableOwner', [1n, writer]);
    await send(owner, 'setTableOwner', [2n, writer]);
    for (const op of fixtureOps) {
      if (op[0] === 1n) await send(writer, 'insert', [op[2], op.slice(3)]);
      else await send(writer, 'enqueue', [Number(op[0]), op[1], op[2], op.slice(3)]);
    }

    server = createServer(createApp({
      chain: { rpcUrl: RPC, address, fromBlock: 0n },
      domains: [DOMAIN],
      secret: 'test-secret',
      prove: (b) => prove(b),
    }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(() => {
    server?.close();
    anvil?.kill();
  });

  beforeEach(() => {
    prove = fixtureProver;
    lastBatch = undefined;
  });

  it('signs in with a valid message and reports the session', async () => {
    const cookie = await signIn(writer);
    expect(cookie).toMatch(/^zkdb_session=/);
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).json();
    expect(me.address).toBe(getAddress(writer));
  });

  it('sets a cookie scripts cannot read', async () => {
    const res = await post('/api/auth/verify', await signedMessage(writer));
    const header = res.headers.get('set-cookie')!;
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
  });

  it('rejects a reused nonce', async () => {
    const signed = await signedMessage(writer);
    expect((await post('/api/auth/verify', signed)).status).toBe(200);
    const again = await post('/api/auth/verify', signed);
    expect(again.status).toBe(401);
    expect((await again.json()).code).toBe('bad_nonce');
  });

  it('rejects a nonce the server never issued', async () => {
    const res = await post('/api/auth/verify', await signedMessage(writer, { nonce: 'abcdefgh12345678' }));
    expect((await res.json()).code).toBe('bad_nonce');
  });

  it('rejects a message signed for another site', async () => {
    const res = await post('/api/auth/verify', await signedMessage(writer, { domain: 'evil.example' }));
    expect((await res.json()).code).toBe('bad_domain');
  });

  it('rejects a signature from a different account', async () => {
    const signed = await signedMessage(writer);
    const forged = await wallet.signMessage({ account: stranger, message: signed.message });
    const res = await post('/api/auth/verify', { message: signed.message, signature: forged });
    expect((await res.json()).code).toBe('bad_signature');
  });

  it('ignores a tampered session cookie', async () => {
    const cookie = await signIn(stranger);
    const [name, value] = cookie.split('=');
    const [, mac] = value.split('.');
    const forged = Buffer.from(JSON.stringify({ address: getAddress(writer), exp: Date.now() + 1000 })).toString('base64url');
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: `${name}=${forged}.${mac}` } })).json();
    expect(me.address).toBeNull();
  });

  it('blocks posts from another origin and non-JSON posts', async () => {
    expect((await post('/api/batches/prove', {}, undefined, 'https://evil.example')).status).toBe(403);
    const res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    expect(res.status).toBe(415);
  });

  it('requires a session to prove', async () => {
    expect((await post('/api/batches/prove', {})).status).toBe(401);
  });

  it('refuses to prove for an account with no role', async () => {
    const res = await post('/api/batches/prove', {}, await signIn(stranger));
    expect(res.status).toBe(403);
  });

  it('reports a missing circuit clearly', async () => {
    prove = async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
    const res = await post('/api/batches/prove', {}, await signIn(writer));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('circuit_missing');
  });

  it('builds the batch from the chain and the result is accepted on-chain', async () => {
    const res = await post('/api/batches/prove', {}, await signIn(writer));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(lastBatch?.newRoot).toBe(BigInt(fixture.newRoot));
    expect(body.newRoot).toBe(fixture.newRoot);
    expect(body.consumed).toBe(fixture.nRealOps);

    const hash = await wallet.writeContract({
      address,
      abi: artifact('ZkDB').abi,
      functionName: 'submitBatch',
      args: [body.proof, body.newRoot, body.ok, body.ops.map((op: string[]) => op.map(BigInt))],
      account: stranger,
    });
    expect((await pub.waitForTransactionReceipt({ hash })).status).toBe('success');
    const root = await pub.readContract({ address, abi: artifact('ZkDB').abi, functionName: 'root' });
    expect(root).toBe(fixture.newRoot);
    batchTx = hash;
    expect(typeof body.provingMs).toBe('number');
  });

  it('keeps the measured proving time for each proof', async () => {
    const meta = await (await fetch(`${base}/api/proofs/meta`)).json();
    expect(meta[fixture.newRoot.toLowerCase()].provingMs).toBeGreaterThanOrEqual(0);
  });

  it('stores a confirmation time only for the transaction that published the proof', async () => {
    const body = { newRoot: fixture.newRoot, txHash: batchTx, confirmMs: 1234 };
    expect((await post('/api/proofs/meta', body)).status).toBe(401);
    const cookie = await signIn(writer);
    const wrongRoot = { ...body, newRoot: `0x${'11'.repeat(32)}` };
    expect((await post('/api/proofs/meta', wrongRoot, cookie)).status).toBe(400);
    expect((await post('/api/proofs/meta', { ...body, confirmMs: -1 }, cookie)).status).toBe(400);
    expect((await post('/api/proofs/meta', body, cookie)).status).toBe(200);
    const meta = await (await fetch(`${base}/api/proofs/meta`)).json();
    expect(meta[fixture.newRoot.toLowerCase()]).toMatchObject({ confirmMs: 1234, txHash: batchTx.toLowerCase() });
  });

  it('refuses confirmation times from accounts with no role', async () => {
    const res = await post('/api/proofs/meta', { newRoot: fixture.newRoot, txHash: batchTx, confirmMs: 1 }, await signIn(stranger));
    expect(res.status).toBe(403);
  });

  it('reads a snapshot pinned to one block, so a later tx cannot split it', async () => {
    const reader = createReader({ rpcUrl: RPC, address, fromBlock: 0n });
    const latest = await pub.getBlockNumber();
    const before = await reader.snapshot(latest - 1n);
    expect(before.block).toBe(latest - 1n);
    expect(before.head).toBe(0);
    expect(before.batches).toHaveLength(0);
    expect(before.ops).toHaveLength(fixtureOps.length);
    expect(before.matches).toBe(true);
    const after = await reader.snapshot(latest);
    expect(after.head).toBe(fixtureOps.length);
    expect(after.matches).toBe(true);
  });

  it('reads the same snapshot when the RPC only allows small log ranges', async () => {
    const latest = await pub.getBlockNumber();
    const whole = await createReader({ rpcUrl: RPC, address, fromBlock: 0n }).snapshot(latest);
    const chunked = createReader({ rpcUrl: RPC, address, fromBlock: 0n, logRange: 2n });
    // Twice: the second call must reuse the kept logs and still match.
    for (let i = 0; i < 2; i++) {
      const s = await chunked.snapshot(latest);
      expect(s.ops).toEqual(whole.ops);
      expect(s.batches.map((b) => b.batchNo)).toEqual(whole.batches.map((b) => b.batchNo));
      expect(s.writers).toEqual(whole.writers);
      expect(s.matches).toBe(true);
    }
  });

  it('reports an empty queue after the batch is in', async () => {
    const res = await post('/api/batches/prove', {}, await signIn(writer));
    expect((await res.json()).code).toBe('empty_queue');
  });

  it('ends the session on logout', async () => {
    const res = await post('/api/auth/logout', {}, await signIn(writer));
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
