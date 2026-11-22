import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, http, parseAbiParameters, stringToHex, type Abi, type Address, type Hex } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { cardKey, initHash } from '@zkdb/core';
import { createApp, type DemoAccount, type SendTx } from '../server/app';
import { createReader } from '../src/chain';
import { pointsEvents, unqueuedProposals } from '../src/points';
import { rolesOf } from '../src/roles';

// Real anvil, real contracts and real proofs (contracts/test/fixtures/claim_1.json): three members join table 1 in
// one proven batch, then two of them claim a 500-point perk through the server's relayer.
const PORT = 8548;
const RPC = `http://127.0.0.1:${PORT}`;
const DOMAIN = 'localhost:5173';
const CONTRACTS = fileURLToPath(new URL('../../../contracts', import.meta.url));
const env = { ...process.env, PATH: `${homedir()}/.foundry/bin:${process.env.PATH}` };
const fixture = JSON.parse(readFileSync(`${CONTRACTS}/test/fixtures/claim_1.json`, 'utf8'));
const flat: bigint[] = fixture.opsFlat.map(BigInt);
const ops = Array.from({ length: flat.length / 9 }, (_, i) => flat.slice(i * 9, i * 9 + 9));
// anvil's second and third accounts: published test keys, used here as the demo treasurer and auditor.
const TREASURER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const AUDITOR_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

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
let db: Address, gate: Address;
let owner: Address, treasurer: Address, auditor: Address, relayerAccount: Address;
let chain: { rpcUrl: string; address: Address; fromBlock: bigint; gate: Address };
let apiPort: number;

/** A raw request, so a test can send any Host, Origin and Cookie, as a hostile page or a rebinding attacker would. */
function raw(method: 'GET' | 'POST', path: string, o: { body?: unknown; headers?: Record<string, string>; port?: number } = {}) {
  return new Promise<{ status: number; body: { code?: string; result?: Hex; accounts?: unknown[] }; cookie?: string }>((resolve, reject) => {
    const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
    const req = request({
      host: '127.0.0.1', port: o.port ?? apiPort, path, method,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}), ...o.headers },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text || '{}'), cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const ORIGIN = { Origin: `http://${DOMAIN}` };
/** The token cookie, as the dashboard page gets it when it lists the demo accounts. */
const demoCookie = async () => (await raw('GET', '/api/demo/accounts')).cookie!;
/** A demo wallet request sent the way the dashboard sends it: allowed Origin, token cookie, JSON. */
const demoCall = async (body: unknown, headers: Record<string, string> = {}) =>
  raw('POST', '/api/demo/wallet', { body, headers: { ...ORIGIN, Cookie: await demoCookie(), ...headers } });
const signInMessage = async (account: Address, over: { domain?: string; nonce?: string } = {}) => stringToHex(createSiweMessage({
  address: account, chainId: foundry.id, domain: over.domain ?? DOMAIN, uri: `http://${DOMAIN}`, version: '1',
  nonce: over.nonce ?? (await (await fetch(`${base}/api/auth/nonce`)).json()).nonce,
}));

const post = (path: string, body: unknown) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://${DOMAIN}` }, body: JSON.stringify(body),
});
const dbAbi = () => artifact('ZkDB').abi;
const send = async (account: Address, to: Address, abi: Abi, functionName: string, args: unknown[]) => {
  const hash = await wallet.writeContract({ address: to, abi, functionName, args, account });
  expect((await pub.waitForTransactionReceipt({ hash })).status).toBe('success');
  return hash;
};

const hasTools = spawnSync('anvil', ['--version'], { env }).status === 0;

describe.skipIf(!hasTools)('perk gate, relayer, demo accounts and corrections on a real chain', () => {
  beforeAll(async () => {
    await initHash();
    spawnSync('forge', ['build'], { cwd: CONTRACTS, env });
    anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      if (await pub.getBlockNumber().then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    [owner, treasurer, auditor, relayerAccount] = (await wallet.getAddresses()) as Address[];
    const deploy = async (name: string, args: unknown[]) => {
      const { abi, bytecode } = artifact(name);
      const hash = await wallet.deployContract({ abi, bytecode, args, account: owner });
      return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
    };
    db = await deploy('ZkDB', [await deploy('BatchVerifier', []), fixture.emptyRoot]);
    gate = await deploy('PointsGate', [db, await deploy('ClaimVerifier', [])]);
    await send(owner, db, dbAbi(), 'setWriter', [treasurer, true]);
    await send(owner, db, dbAbi(), 'setTableOwner', [1n, treasurer]);
    await send(owner, gate, artifact('PointsGate').abi, 'addPerk', [1n, 500n, 'Priority event ticket']);
    for (const op of ops) await send(treasurer, db, dbAbi(), 'insert', [op[2], op.slice(3)]);
    await send(treasurer, db, dbAbi(), 'submitBatch', [fixture.batchProof, fixture.root, Array(16).fill(true), ops]);

    chain = { rpcUrl: RPC, address: db, fromBlock: 0n, gate };
    const relayer: SendTx = (tx) => wallet.sendTransaction({ ...tx, account: relayerAccount });
    const demoAccount = (k: Hex, label: string, role: DemoAccount['role']): DemoAccount => {
      const key = privateKeyToAccount(k);
      const keyWallet = createWalletClient({ account: key, chain: foundry, transport });
      return { address: key.address, label, role, signMessage: (raw) => key.signMessage({ message: { raw } }), send: (tx) => keyWallet.sendTransaction(tx) };
    };
    const hosts: string[] = [DOMAIN];
    server = createServer(createApp({
      chain, domains: [DOMAIN], secret: 's', prove: async () => { throw new Error('unused'); }, relayer,
      demo: { accounts: [demoAccount(TREASURER_KEY, 'Treasurer', 'treasurer'), demoAccount(AUDITOR_KEY, 'Auditor', 'auditor')], cards: [{ card: '42', secret: `0x${'00'.repeat(27)}0a11ce0042` }], hosts },
    }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    apiPort = (server.address() as AddressInfo).port;
    hosts.push(`127.0.0.1:${apiPort}`);
    base = `http://127.0.0.1:${apiPort}`;
  }, 120_000);

  afterAll(() => {
    server?.close();
    anvil?.kill();
  });

  const claim = (i: number, over: Record<string, unknown> = {}) =>
    post('/api/claims/relay', { proof: fixture.claims[i].proof, perkId: 0, nullifier: fixture.claims[i].nullifier, pickup: fixture.claims[i].pickup, ...over });

  it('relays a valid claim and the gate records it without naming a card', async () => {
    const res = await claim(0);
    expect(res.status).toBe(200);
    const { txHash } = await res.json();
    const receipt = await pub.getTransactionReceipt({ hash: txHash });
    expect(receipt.from.toLowerCase()).toBe(relayerAccount.toLowerCase());

    const s = await createReader(chain).snapshot();
    expect(s.perks).toEqual([{ id: 0, tableId: 1n, minPoints: 500n, claims: 1, name: 'Priority event ticket' }]);
    expect(s.claims).toHaveLength(1);
    expect(s.claims[0]).toMatchObject({ perkId: 0, nullifier: fixture.claims[0].nullifier, pickup: fixture.claims[0].pickup, collected: false, root: BigInt(fixture.root) });
    // the transaction carries the nullifier, and not the card's key (the hash of its secret stored in the row)
    const tx = await pub.getTransaction({ hash: txHash });
    expect(tx.input.includes(fixture.claims[0].nullifier.slice(2))).toBe(true);
    const key = cardKey(0xa11ce0042n).toString(16).padStart(64, '0');
    expect(ops[0][5].toString(16).padStart(64, '0')).toBe(key);
    expect(tx.input.includes(key)).toBe(false);
  });

  it('refuses the same card twice and spends no gas on it', async () => {
    const before = await pub.getTransactionCount({ address: relayerAccount });
    const res = await claim(0);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('already_claimed');
    expect(await pub.getTransactionCount({ address: relayerAccount })).toBe(before);
  });

  it('refuses a proof that does not match its nullifier, before sending anything', async () => {
    const before = await pub.getTransactionCount({ address: relayerAccount });
    const res = await claim(1, { nullifier: `0x${'22'.repeat(32)}` });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('invalid_proof');
    expect(await pub.getTransactionCount({ address: relayerAccount })).toBe(before);
  });

  it('refuses to redirect a claim to another pickup code (round-2 audit PoC), before sending anything', async () => {
    const before = await pub.getTransactionCount({ address: relayerAccount });
    // someone copies card 2's proof and tries to have it recorded for their own pickup hash
    const res = await claim(1, { pickup: `0x00${'33'.repeat(31)}` });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('invalid_proof');
    expect(await pub.getTransactionCount({ address: relayerAccount })).toBe(before);
  });

  it('accepts a second card and rejects malformed requests', async () => {
    expect((await claim(1)).status).toBe(200);
    expect((await claim(1, { pickup: '0x12' })).status).toBe(400);
    expect((await claim(1, { pickup: undefined })).status).toBe(400);
    expect((await claim(1, { perkId: 7 })).status).toBe(404);
    expect((await claim(1, { proof: 'nope' })).status).toBe(400);
    expect((await claim(1, { nullifier: '0x12' })).status).toBe(400);
    expect((await claim(1, { perkId: -1 })).status).toBe(400);
  });

  it('stops relaying when the hourly cap is reached, before doing any work for the request', async () => {
    const relayer: SendTx = async () => { throw new Error('must not be reached'); };
    const capped = createServer(createApp({ chain, domains: [DOMAIN], secret: 's', prove: async () => { throw new Error('unused'); }, relayer, relayPerHour: 0 }));
    await new Promise<void>((r) => capped.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(capped.address() as AddressInfo).port}`;
    const res = await fetch(`${url}/api/claims/relay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proof: fixture.claims[0].proof, perkId: 0, nullifier: fixture.claims[0].nullifier, pickup: fixture.claims[0].pickup }),
    });
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('rate_limited');
    capped.close();
  });

  it('does not relay when no relayer is configured', async () => {
    const bare = createServer(createApp({ chain, domains: [DOMAIN], secret: 's', prove: async () => { throw new Error('unused'); } }));
    await new Promise<void>((r) => bare.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    const res = await fetch(`${url}/api/claims/relay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(503);
    bare.close();
  });

  // --- claims on the school L1: the same proof goes through ClaimForwarder, which sends the receipt on over ICM ---

  describe('claims relayed to the school L1', () => {
    const SOURCE = `0x${'11'.repeat(32)}` as Hex;
    const DESTINATION = `0x${'22'.repeat(32)}` as Hex;
    const rootMessage = (batchNo: bigint, root: Hex) => encodeAbiParameters(parseAbiParameters('uint64, bytes32'), [batchNo, root]);
    let mirror: Address, l1Gate: Address, teleporter: Address, forwarder: Address, registry: Address, gate2: Address;
    let l1Server: Server;
    let l1Base: string;
    let l1Chain: Parameters<typeof createApp>[0]['chain'];
    const noProver = async () => { throw new Error('unused'); };
    const relayer: SendTx = (tx) => wallet.sendTransaction({ ...tx, account: relayerAccount });
    const teleporterArtifact = () => {
      const a = JSON.parse(readFileSync(`${CONTRACTS}/out/RootRelay.t.sol/MockTeleporter.json`, 'utf8'));
      return { abi: a.abi as Abi, bytecode: a.bytecode.object as Hex };
    };
    const claimBody = (i: number, over: Record<string, unknown> = {}) =>
      JSON.stringify({ proof: fixture.claims[i].proof, perkId: 0, nullifier: fixture.claims[i].nullifier, pickup: fixture.claims[i].pickup, ...over });
    const headers = { 'Content-Type': 'application/json', Origin: `http://${DOMAIN}` };
    const claimL1 = (i: number, over: Record<string, unknown> = {}, at = l1Base) => fetch(`${at}/api/claims/relay-l1`, { method: 'POST', headers, body: claimBody(i, over) });
    /** The claim sent to the gate on this chain, through the server that also knows the L1. */
    const claimHere = (i: number, over: Record<string, unknown> = {}) => fetch(`${l1Base}/api/claims/relay`, { method: 'POST', headers, body: claimBody(i, over) });
    const claimedOn = (address: Address, i: number) =>
      pub.readContract({ address, abi: artifact('PointsGate').abi, functionName: 'claimed', args: [0n, fixture.claims[i].nullifier] });
    const sentOverIcm = () => pub.readContract({ address: teleporter, abi: teleporterArtifact().abi, functionName: 'sent' });
    const relayerNonce = () => pub.getTransactionCount({ address: relayerAccount });

    beforeAll(async () => {
      const deploy = async ({ abi, bytecode }: { abi: Abi; bytecode: Hex }, args: unknown[]) => {
        const hash = await wallet.deployContract({ abi, bytecode, args, account: owner });
        return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
      };
      // The owner account stands in for Teleporter and for the contract on the other chain, so it can hand the
      // mirror a root and the registry a receipt.
      mirror = await deploy(artifact('RootMirror'), [owner, SOURCE, owner]);
      await send(owner, mirror, artifact('RootMirror').abi, 'receiveTeleporterMessage', [SOURCE, owner, rootMessage(1n, fixture.root)]);
      const verifier = await deploy(artifact('ClaimVerifier'), []);
      l1Gate = await deploy(artifact('PointsGate'), [mirror, verifier]);
      await send(owner, l1Gate, artifact('PointsGate').abi, 'addPerk', [1n, 500n, 'Priority event ticket']);
      teleporter = await deploy(teleporterArtifact(), [DESTINATION]);
      forwarder = await deploy(artifact('ClaimForwarder'), [l1Gate, teleporter, DESTINATION, owner]);
      registry = await deploy(artifact('ClaimRegistry'), [owner, SOURCE, owner]);
      // A second gate on this chain where neither fixture card has claimed yet: the tests above spent both on the first.
      gate2 = await deploy(artifact('PointsGate'), [db, verifier]);
      await send(owner, gate2, artifact('PointsGate').abi, 'addPerk', [1n, 500n, 'Priority event ticket']);
      l1Chain = { ...chain, gate: gate2, l1: { name: 'school L1', chainId: 1, token: 'T', blockchainId: 'x', relay: owner, registry, fromBlock: 0n } };
      l1Server = createServer(createApp({
        chain: l1Chain, domains: [DOMAIN], secret: 's', prove: noProver, relayer,
        l1: { rpcUrl: RPC, forwarder, relayer, relayerAddress: relayerAccount },
      }));
      await new Promise<void>((r) => l1Server.listen(0, '127.0.0.1', r));
      l1Base = `http://127.0.0.1:${(l1Server.address() as AddressInfo).port}`;
    }, 60_000);

    afterAll(() => { l1Server?.close(); });

    it('tells the page where a claim can go', async () => {
      expect(await (await fetch(`${l1Base}/api/claims/targets`)).json()).toEqual({ fuji: true, l1: true });
      expect(await (await fetch(`${base}/api/claims/targets`)).json()).toEqual({ fuji: true, l1: false });
    });

    it('keeps the hourly cap of the other relay, before doing any work for the request', async () => {
      const never: SendTx = async () => { throw new Error('must not be reached'); };
      const capped = createServer(createApp({ chain: l1Chain, domains: [DOMAIN], secret: 's', prove: noProver, relayer: never, relayPerHour: 0, l1: { rpcUrl: RPC, forwarder, relayer: never, relayerAddress: relayerAccount } }));
      await new Promise<void>((r) => capped.listen(0, '127.0.0.1', r));
      const res = await claimL1(0, {}, `http://127.0.0.1:${(capped.address() as AddressInfo).port}`);
      expect(res.status).toBe(429);
      expect((await res.json()).code).toBe('rate_limited');
      capped.close();
    });

    it('refuses a page on another origin, like the other relay', async () => {
      const res = await fetch(`${l1Base}/api/claims/relay-l1`, { method: 'POST', headers: { ...headers, Origin: 'http://evil.example' }, body: claimBody(0) });
      expect(res.status).toBe(403);
    });

    it('relays one of two simultaneous requests for the same claim: the L1 gate records it once and one receipt leaves', async () => {
      const results = await Promise.all([claimL1(0), claimL1(0)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const ok = results.find((r) => r.status === 200)!;
      const { txHash, messageId } = await ok.json();
      const receipt = await pub.getTransactionReceipt({ hash: txHash });
      expect(receipt.from.toLowerCase()).toBe(relayerAccount.toLowerCase());
      expect(receipt.to?.toLowerCase()).toBe(forwarder.toLowerCase());
      expect(await claimedOn(l1Gate, 0)).toBe(true);
      expect(await sentOverIcm()).toBe(1n);
      expect(BigInt(messageId)).toBe(1n);
    });

    it('refuses the same card twice on the L1 and spends no gas on it', async () => {
      const before = await relayerNonce();
      const res = await claimL1(0);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('already_claimed');
      expect(await relayerNonce()).toBe(before);
    });

    it('refuses on this chain a claim already made on the L1 (double spend across chains)', async () => {
      // gate2 has never seen this nullifier, so the contract alone would accept it
      expect(await claimedOn(gate2, 0)).toBe(false);
      const before = await relayerNonce();
      const res = await claimHere(0);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('claimed_elsewhere');
      expect(await relayerNonce()).toBe(before);
      expect(await claimedOn(gate2, 0)).toBe(false);
    });

    it('refuses on the L1 a claim already made on this chain (double spend across chains)', async () => {
      expect((await claimHere(1)).status).toBe(200);
      expect(await claimedOn(l1Gate, 1)).toBe(false);
      const before = await relayerNonce();
      const res = await claimL1(1);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('claimed_elsewhere');
      expect(await relayerNonce()).toBe(before);
      expect(await claimedOn(l1Gate, 1)).toBe(false);
      expect(await sentOverIcm()).toBe(1n);
    });

    it('refuses on both paths a nullifier whose receipt from the L1 is already in ClaimRegistry', async () => {
      const nullifier = `0x${'00'.repeat(31)}99` as Hex;
      const receiptMessage = encodeAbiParameters(parseAbiParameters('uint256, bytes32, bytes32, uint64, bytes32, uint64'), [0n, nullifier, `0x00${'44'.repeat(31)}`, 500n, fixture.root, 1n]);
      await send(owner, registry, artifact('ClaimRegistry').abi, 'receiveTeleporterMessage', [SOURCE, owner, receiptMessage]);
      const here = await claimHere(1, { nullifier });
      expect(here.status).toBe(409);
      expect((await here.json()).code).toBe('claimed_elsewhere');
      const there = await claimL1(1, { nullifier });
      expect(there.status).toBe(409);
      expect((await there.json()).code).toBe('already_claimed');
    });

    it('rejects malformed requests', async () => {
      expect((await claimL1(1, { pickup: '0x12' })).status).toBe(400);
      expect((await claimL1(1, { proof: 'nope' })).status).toBe(400);
      expect((await claimL1(1, { perkId: -1 })).status).toBe(400);
    });

    it('relays nothing to the L1 while it holds another root than the ledger, and says which', async () => {
      // the mirror moves to a batch the ledger on this chain does not have: the two no longer agree
      await send(owner, mirror, artifact('RootMirror').abi, 'receiveTeleporterMessage', [SOURCE, owner, rootMessage(2n, `0x${'00'.repeat(31)}07`)]);
      const before = await relayerNonce();
      const res = await claimL1(1, { nullifier: `0x${'00'.repeat(31)}55` });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('l1_root_behind');
      expect(body.error).toMatch(/holds #2, the ledger is at #1/);
      expect(await relayerNonce()).toBe(before);
      // the gate on this chain reads the ledger's own root, so it still relays as before
      const here = await claimHere(0, { nullifier: `0x${'00'.repeat(31)}56` });
      expect((await here.json()).code).toBe('invalid_proof');
    });

    it('fails closed when the L1 cannot be read', async () => {
      const blind = createServer(createApp({ chain: l1Chain, domains: [DOMAIN], secret: 's', prove: noProver, relayer, l1: { rpcUrl: 'http://127.0.0.1:9', forwarder, relayer, relayerAddress: relayerAccount } }));
      await new Promise<void>((r) => blind.listen(0, '127.0.0.1', r));
      const at = `http://127.0.0.1:${(blind.address() as AddressInfo).port}`;
      const before = await relayerNonce();
      const there = await claimL1(1, {}, at);
      expect(there.status).toBe(503);
      expect((await there.json()).code).toBe('check_failed');
      const here = await fetch(`${at}/api/claims/relay`, { method: 'POST', headers, body: claimBody(1, { nullifier: `0x${'00'.repeat(31)}57` }) });
      expect(here.status).toBe(503);
      expect(await relayerNonce()).toBe(before);
      blind.close();
    }, 30_000);

    it('does not relay to the L1 when no L1 relayer is configured', async () => {
      const res = await claimL1(1, {}, base);
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe('no_l1_relayer');
    });
  });

  // --- demo accounts: a signer on localhost has to refuse everyone but the dashboard page ---

  it('has no demo routes unless the server was started with the demo flag', async () => {
    const bare = createServer(createApp({ chain, domains: [DOMAIN], secret: 's', prove: async () => { throw new Error('unused'); } }));
    await new Promise<void>((r) => bare.listen(0, '127.0.0.1', r));
    const port = (bare.address() as AddressInfo).port;
    expect((await raw('GET', '/api/demo/accounts', { port })).status).toBe(404);
    const call = await raw('POST', '/api/demo/wallet', { port, body: { address: treasurer, method: 'personal_sign', params: ['0x00'] }, headers: ORIGIN });
    expect(call.status).toBe(404);
    bare.close();
  });

  it('lists the demo accounts and hands the page a token cookie scripts cannot read', async () => {
    const res = await fetch(`${base}/api/demo/accounts`);
    expect(await res.json()).toEqual({ accounts: [{ address: treasurer, label: 'Treasurer' }, { address: auditor, label: 'Auditor' }] });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^zkdb_demo=[\w-]{43}; HttpOnly; SameSite=Strict; Path=\/api\/demo$/);
  });

  it('signs in through a demo account when the page asks the way the dashboard does', async () => {
    const message = await signInMessage(treasurer);
    const signed = await demoCall({ address: treasurer, method: 'personal_sign', params: [message, treasurer] });
    expect(signed.status).toBe(200);
    const verify = await post('/api/auth/verify', { message: Buffer.from(message.slice(2), 'hex').toString(), signature: signed.body.result });
    expect(verify.status).toBe(200);
    expect((await verify.json()).address).toBe(treasurer);
  });

  it('refuses a request whose Host is not the local dashboard (DNS rebinding)', async () => {
    const body = { address: treasurer, method: 'personal_sign', params: [await signInMessage(treasurer), treasurer] };
    const cookie = await demoCookie();
    for (const Host of ['evil.example', `evil.example:${apiPort}`, '127.0.0.1:1']) {
      const res = await raw('POST', '/api/demo/wallet', { body, headers: { ...ORIGIN, Cookie: cookie, Host } });
      expect([res.status, res.body.code]).toEqual([403, 'bad_host']);
      expect((await raw('GET', '/api/demo/accounts', { headers: { Host } })).status).toBe(403);
    }
  });

  it('refuses a missing or foreign Origin, and any cross-site request (CSRF)', async () => {
    const body = { address: treasurer, method: 'personal_sign', params: [await signInMessage(treasurer), treasurer] };
    const cookie = await demoCookie();
    const send = (headers: Record<string, string>) => raw('POST', '/api/demo/wallet', { body, headers: { Cookie: cookie, ...headers } });
    expect((await send({})).body.code).toBe('bad_origin');
    expect((await send({ Origin: 'https://evil.example' })).body.code).toBe('bad_origin');
    expect((await send({ Origin: 'null' })).body.code).toBe('bad_origin');
    expect((await send({ ...ORIGIN, 'Sec-Fetch-Site': 'cross-site' })).body.code).toBe('bad_origin');
    // the token is not handed to a cross-site page either
    expect((await raw('GET', '/api/demo/accounts', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    expect((await raw('GET', '/api/demo/accounts', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await send(ORIGIN)).status).toBe(200);
  });

  it('refuses a request without this launch\'s token', async () => {
    const body = { address: treasurer, method: 'personal_sign', params: [await signInMessage(treasurer), treasurer] };
    const noToken = await raw('POST', '/api/demo/wallet', { body, headers: ORIGIN });
    expect([noToken.status, noToken.body.code]).toEqual([401, 'bad_token']);
    const wrong = await raw('POST', '/api/demo/wallet', { body, headers: { ...ORIGIN, Cookie: `zkdb_demo=${'A'.repeat(43)}` } });
    expect([wrong.status, wrong.body.code]).toEqual([401, 'bad_token']);
    const short = await raw('POST', '/api/demo/wallet', { body, headers: { ...ORIGIN, Cookie: 'zkdb_demo=x' } });
    expect(short.status).toBe(401);
  });

  it('refuses a body that is not JSON', async () => {
    const res = await new Promise<number>((resolve) => {
      const req = request({ host: '127.0.0.1', port: apiPort, path: '/api/demo/wallet', method: 'POST', headers: { ...ORIGIN, 'Content-Type': 'text/plain' } }, (r) => { r.resume(); resolve(r.statusCode!); });
      req.end('{}');
    });
    expect(res).toBe(415);
  });

  it('signs nothing but a sign-in message this server issued a nonce for', async () => {
    const sign = async (message: Hex, address = treasurer) => (await demoCall({ address, method: 'personal_sign', params: [message, address] })).body.code;
    expect(await sign(stringToHex('hello'))).toBe('not_sign_in');
    expect(await sign(stringToHex('Transfer everything to 0x0000000000000000000000000000000000000001'))).toBe('not_sign_in');
    expect(await sign(await signInMessage(treasurer, { domain: 'evil.example' }))).toBe('not_sign_in');
    expect(await sign(await signInMessage(treasurer, { nonce: 'abcdefgh12345678' }))).toBe('not_sign_in');
    expect(await sign(await signInMessage(owner))).toBe('not_sign_in'); // a message for another account
    expect((await demoCall({ address: treasurer, method: 'personal_sign', params: ['hello'] })).body.code).toBe('not_sign_in');
    expect((await demoCall({ address: owner, method: 'personal_sign', params: ['0x00'] })).status).toBe(404); // not a demo account
    expect((await demoCall({ address: treasurer, method: 'eth_sign', params: [] })).status).toBe(400);
    expect((await demoCall({ address: treasurer, method: 'eth_signTypedData_v4', params: [] })).status).toBe(400);
  });

  it('gives the seeded card secrets only to the dashboard page', async () => {
    const noToken = await raw('POST', '/api/demo/cards', { body: {}, headers: ORIGIN });
    expect([noToken.status, noToken.body.code]).toEqual([401, 'bad_token']);
    const cookie = await demoCookie();
    expect((await raw('POST', '/api/demo/cards', { body: {}, headers: { Cookie: cookie } })).body.code).toBe('bad_origin');
    expect((await raw('POST', '/api/demo/cards', { body: {}, headers: { ...ORIGIN, Cookie: cookie, Host: 'evil.example' } })).body.code).toBe('bad_host');
    const ok = await raw('POST', '/api/demo/cards', { body: {}, headers: { ...ORIGIN, Cookie: cookie } });
    expect(ok.status).toBe(200);
    expect((ok.body as { cards?: unknown[] }).cards).toEqual([{ card: '42', secret: `0x${'00'.repeat(27)}0a11ce0042` }]);
  });

  it('lets the demo treasurer hand a claimed perk out with the pickup code, once', async () => {
    const collect = (code: string) => encodeFunctionData({ abi: artifact('PointsGate').abi, functionName: 'collect', args: [0n, code] });
    const sent = await demoCall({ address: treasurer, method: 'eth_sendTransaction', params: [{ to: gate, data: collect(fixture.claims[0].pickupCode) }] });
    expect(sent.status).toBe(200);
    expect((await pub.waitForTransactionReceipt({ hash: sent.body.result! })).status).toBe('success');
    const s = await createReader(chain).snapshot();
    expect(s.claims.map((c) => c.collected)).toEqual([true, false]);
    // the auditor's demo account has no call on the gate
    const other = await demoCall({ address: auditor, method: 'eth_sendTransaction', params: [{ to: gate, data: collect(fixture.claims[1].pickupCode) }] });
    expect(other.status).toBe(403);
  });

  it('sends only the calls its role is allowed, to this deployment, with no value', async () => {
    const data = (functionName: string, args: unknown[]) => encodeFunctionData({ abi: dbAbi(), functionName, args });
    const award = data('enqueue', [3, 0n, 1n, [100n, 1n, 0n, 0n, 0n, 0n]]);
    const tx = async (address: Address, t: Record<string, unknown>) => {
      const before = await pub.getTransactionCount({ address });
      const res = await demoCall({ address, method: 'eth_sendTransaction', params: [t] });
      expect(await pub.getTransactionCount({ address })).toBe(before); // nothing was sent
      return [res.status, res.body.code];
    };
    const refused = [403, 'forbidden'];
    expect(await tx(treasurer, { to: owner, data: award })).toEqual(refused); // not a contract of this deployment
    expect(await tx(treasurer, { to: gate, data: award })).toEqual(refused); // on the gate the treasurer may only collect
    expect(await tx(treasurer, { to: db, data: award, value: '0x1' })).toEqual(refused);
    expect(await tx(treasurer, { to: db, data: '0x' })).toEqual(refused); // a plain transfer
    expect(await tx(treasurer, { to: db, data: data('setWriter', [owner, true]) })).toEqual(refused); // owner-only selector
    expect(await tx(treasurer, { to: db, data: data('transferOwnership', [treasurer]) })).toEqual(refused);
    expect(await tx(treasurer, { to: db, data: data('approveChange', [0n, Array(9).fill(0n)]) })).toEqual(refused); // the auditor's call
    expect(await tx(treasurer, { to: gate, data: encodeFunctionData({ abi: artifact('PointsGate').abi, functionName: 'addPerk', args: [1n, 1n, 'free'] }) })).toEqual(refused);
    expect(await tx(auditor, { to: db, data: award })).toEqual(refused); // the treasurer's call
    expect(await tx(auditor, { to: db, data: data('insert', [1n, Array(6).fill(0n)]) })).toEqual(refused);
  });

  it('shows who queued each change, and both signers of a correction', async () => {
    // an award sent through the demo treasurer: an allowed call, one signature
    const award = encodeFunctionData({ abi: dbAbi(), functionName: 'enqueue', args: [3, 0n, 1n, [100n, 1n, 0n, 0n, 0n, 0n]] });
    const sent = await demoCall({ address: treasurer, method: 'eth_sendTransaction', params: [{ to: db, data: award }] });
    expect(sent.status).toBe(200);
    await pub.waitForTransactionReceipt({ hash: sent.body.result! });

    await send(owner, db, dbAbi(), 'setTableAuditor', [1n, auditor]);
    const v = [250n, 20n, 0n, 0n, 0n, 0n];
    await send(treasurer, db, dbAbi(), 'proposeChange', [2, 0n, 1n, v]);
    await send(treasurer, db, dbAbi(), 'proposeChange', [2, 1n, 1n, v]);

    const reader = createReader(chain);
    let s = await reader.snapshot();
    expect(s.tableAuditors).toEqual([{ tableId: 1n, auditor }]);
    expect(s.proposals.map((c) => [c.id, c.status, c.proposer])).toEqual([[0, 'open', treasurer], [1, 'open', treasurer]]);
    expect(s.pending).toBe(1); // only the award: a proposal is not in the queue
    // with an auditor on the table the treasurer can no longer subtract alone
    await expect(pub.simulateContract({ address: db, abi: dbAbi(), functionName: 'enqueue', args: [4, 0n, 1n, v], account: treasurer })).rejects.toThrow(/NeedsAuditor/);
    expect(unqueuedProposals(s.proposals, s.ops).map((p) => [p.rowId, p.amount])).toEqual([[1, 250n], [0, 250n]]);
    expect(rolesOf(s, treasurer)).toEqual(['Treasurer']);
    expect(rolesOf(s, auditor)).toEqual(['Auditor']);
    expect(rolesOf(s, owner)).toEqual(['Owner']);

    await send(auditor, db, dbAbi(), 'approveChange', [0n, [2n, 0n, 1n, ...v]]);
    await send(auditor, db, dbAbi(), 'declineChange', [1n, [2n, 1n, 1n, ...v]]);
    s = await reader.snapshot();
    expect(s.proposals.map((c) => [c.status, c.decidedBy, c.opId])).toEqual([['approved', auditor, 4], ['declined', auditor, undefined]]);
    expect(s.pending).toBe(2);
    const queued = s.ops.find((o) => o.id === 4)!;
    expect(queued.by).toBe(treasurer); // the proposer, not the auditor who sent the approving transaction
    expect(s.ops.find((o) => o.id === 3)!.by).toBe(treasurer);
    const ev = pointsEvents(s.ops, s.proposals).find((e) => e.op.id === 4)!;
    expect(ev).toMatchObject({ kind: 'correct', amount: 250n, cosigner: auditor, status: 'pending' });
    expect(unqueuedProposals(s.proposals, s.ops).map((p) => p.proposal.status)).toEqual(['declined']);
  });
});
