import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { buildClaim, cardKey, initHash } from '@zkdb/core';
import { createApp, type SendTx } from '../server/app';
import { createReader, gateAbi, readGovernor, relayAbi } from '../src/chain';
import { toHex32 } from '../src/format';
import { newCardSecret, newPickupCode, pickupHash } from '../src/pickup';

/**
 * Try-it mode end to end on anvil with the real provers: a visitor with no wallet gets a card, the server proves and
 * submits the batch with the real batch circuit, the visitor proves a claim with the real claim circuit, the relayer
 * sends it and PointsGate accepts it. Nothing is mocked except the chain (anvil instead of Fuji).
 */
const PORT = 8551;
const RPC = `http://127.0.0.1:${PORT}`;
const DOMAIN = 'localhost:5173';
const TRIAL_TABLE = 900n;
const CONTRACTS = fileURLToPath(new URL('../../../contracts', import.meta.url));
const env = { ...process.env, PATH: `${homedir()}/.foundry/bin:${process.env.PATH}` };
const transport = http(RPC);
const pub = createPublicClient({ chain: foundry, transport, pollingInterval: 50 });
const wallet = createWalletClient({ chain: foundry, transport });
const artifact = (name: string): { abi: Abi; bytecode: Hex } => {
  const a = JSON.parse(readFileSync(`${CONTRACTS}/out/${name}.sol/${name}.json`, 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object };
};
const hasTools = spawnSync('anvil', ['--version'], { env }).status === 0;

let anvil: ChildProcess;
let server: Server;
let base: string;
let db: Address;
let gate: Address;
let trialKey: Address;
let rootRelay: Address;
let relayerKey: Address;

const sender = (account: Address): SendTx => (tx) => wallet.sendTransaction({ ...tx, account, chain: null });
const post = (path: string, body: unknown, ip?: string) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(ip ? { 'X-Forwarded-For': ip } : {}) },
  body: JSON.stringify(body),
});

describe.skipIf(!hasTools)('try-it mode (anvil, real provers)', () => {
  beforeAll(async () => {
    spawnSync('forge', ['build'], { cwd: CONTRACTS, env });
    anvil = spawn('anvil', ['--port', String(PORT), '--silent', '--code-size-limit', '100000'], { env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      if (await pub.getBlockNumber().then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await initHash();
    const { ZkDbState } = await import('@zkdb/core');
    const [owner, trial, relayer] = (await wallet.getAddresses()) as [Address, Address, Address];
    trialKey = trial;
    relayerKey = relayer;
    const deploy = async (name: string, args: unknown[]) => {
      const { abi, bytecode } = artifact(name);
      const hash = await wallet.deployContract({ abi, bytecode, args, account: owner });
      return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
    };
    const emptyRoot = toHex32(new ZkDbState().root) as Hex;
    db = await deploy('ZkDB', [await deploy('BatchVerifier', []), emptyRoot]);
    gate = await deploy('PointsGate', [db, await deploy('ClaimVerifier', [])]);
    const call = async (address: Address, name: string, functionName: string, args: unknown[]) => {
      const hash = await wallet.writeContract({ address, abi: artifact(name).abi, functionName, args, account: owner });
      expect((await pub.waitForTransactionReceipt({ hash })).status).toBe('success');
    };
    await call(db, 'ZkDB', 'setWriter', [trial, true]);
    await call(db, 'ZkDB', 'setTableOwner', [TRIAL_TABLE, trial]);
    await call(db, 'ZkDB', 'setSoloLimit', [TRIAL_TABLE, true, 1, 200n, 100_000n]);
    await call(gate, 'PointsGate', 'addPerk', [TRIAL_TABLE, 100n, 'Trial: at least 100 points']);

    const prove = async (b: Parameters<typeof import('@zkdb/core/prover').proveBatch>[0]) => {
      const { loadCircuit, proveBatch } = await import('@zkdb/core/prover');
      return proveBatch(b, loadCircuit());
    };
    // The school L1's end on this chain: RootRelay hands each root to Teleporter (a mock here; ICM needs a real network).
    const mock = JSON.parse(readFileSync(`${CONTRACTS}/out/RootRelay.t.sol/MockTeleporter.json`, 'utf8'));
    const teleporterTx = await wallet.deployContract({ abi: mock.abi, bytecode: mock.bytecode.object, args: [`0x${'22'.repeat(32)}`], account: owner });
    const teleporter = (await pub.waitForTransactionReceipt({ hash: teleporterTx })).contractAddress!;
    rootRelay = await deploy('RootRelay', [db, teleporter, `0x${'11'.repeat(32)}`, owner]);
    // ClaimRegistry holds the L1's receipts on this chain; the claim relayer reads it before it sends a claim.
    const registry = await deploy('ClaimRegistry', [teleporter, `0x${'11'.repeat(32)}`, owner]);
    server = createServer(createApp({
      chain: { rpcUrl: RPC, address: db, fromBlock: 0n, gate, l1: { name: 'school L1', chainId: 1, token: 'T', blockchainId: 'x', relay: rootRelay, registry, fromBlock: 0n } },
      domains: [DOMAIN],
      secret: 'test-secret',
      prove,
      relayer: sender(relayer),
      trial: { table: TRIAL_TABLE, perkId: 0, points: 150n, writer: { address: trial, send: sender(trial) }, cardsPerVisitor: 1, trustProxy: true },
    }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 180_000);

  afterAll(() => {
    server?.close();
    anvil?.kill();
  });

  it('reads the rules of a governor that owns the ledger, and nothing from a plain wallet', async () => {
    const [a, b, c] = (await wallet.getAddresses()) as [Address, Address, Address];
    const { abi, bytecode } = artifact('AdminGovernor');
    const hash = await wallet.deployContract({ abi, bytecode, args: [[a, b, c], 2n, 120n], account: a });
    const governor = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
    expect(await readGovernor(pub, governor)).toEqual({ threshold: 2, delay: 120, signers: [a, b, c] });
    expect(await readGovernor(pub, a)).toBeUndefined();
    // This ledger is still owned by a wallet, so its snapshot names no governor.
    expect((await createReader({ rpcUrl: RPC, address: db, fromBlock: 0n, gate }).snapshot()).governor).toBeUndefined();
  });

  it('reports itself on', async () => {
    const info = await (await fetch(`${base}/api/trial`)).json();
    expect(info).toMatchObject({ enabled: true, table: '900', perkId: 0, points: '150', relayer: true });
  });

  it('card → batch proof → zero-knowledge claim, with no wallet on the visitor side', async () => {
    const secret = newCardSecret();
    const card = await post('/api/trial/card', { cardKey: toHex32(cardKey(secret)) }, '10.0.0.1');
    expect(card.status).toBe(200);
    const made = await card.json();
    expect(made.txs.map((t: { step: string }) => t.step)).toEqual(['insert', 'award']);
    for (const t of made.txs) expect((await pub.getTransactionReceipt({ hash: t.hash })).from.toLowerCase()).toBe(trialKey.toLowerCase());

    const batch = await post('/api/trial/batch', {});
    expect(batch.status).toBe(200);
    const proven = await batch.json();
    expect(proven.consumed).toBe(2);
    const zkdb = { address: db, abi: artifact('ZkDB').abi } as const;
    expect(await pub.readContract({ ...zkdb, functionName: 'root' })).toBe(proven.newRoot);
    // The trial key also sent the new root on to the school L1, so claims there are not checked against an old one.
    expect(proven.relayed.map((r: { to: string }) => r.to)).toEqual(['school L1']);
    expect((await pub.getTransactionReceipt({ hash: proven.relayed[0].txHash })).from.toLowerCase()).toBe(trialKey.toLowerCase());
    expect(await pub.readContract({ address: rootRelay, abi: relayAbi, functionName: 'lastRelayedBatch' })).toBe(1n);

    // The visitor's side: rebuild the table from events, prove the claim locally, hand it to the relayer.
    const snapshot = await createReader({ rpcUrl: RPC, address: db, fromBlock: 0n, gate }).snapshot();
    expect(snapshot.matches).toBe(true);
    const code = newPickupCode();
    const built = buildClaim(snapshot.state, TRIAL_TABLE, { id: 0n, minPoints: 100n }, secret, pickupHash(code));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const { loadClaimCircuit } = await import('@zkdb/core/prover');
    const { proveClaim } = await import('@zkdb/core/claim-prover');
    const { proof } = await proveClaim(built.input, loadClaimCircuit());
    const nullifier = toHex32(built.input.nullifier) as Hex;
    const relay = await post('/api/claims/relay', {
      proof: `0x${Buffer.from(proof).toString('hex')}`, perkId: 0, nullifier, pickup: toHex32(built.input.pickup),
    });
    expect(relay.status).toBe(200);
    const { txHash } = await relay.json();
    expect((await pub.getTransactionReceipt({ hash: txHash })).from.toLowerCase()).toBe(relayerKey.toLowerCase());
    expect(await pub.readContract({ address: gate, abi: gateAbi, functionName: 'claimed', args: [0n, nullifier] })).toBe(true);
  }, 600_000);

  it('caps cards per visitor', async () => {
    const res = await post('/api/trial/card', { cardKey: toHex32(cardKey(newCardSecret())) }, '10.0.0.1');
    expect(res.status).toBe(429);
  });

  it('does not let a visitor reset the cap by sending its own X-Forwarded-For entries', async () => {
    // The proxy appends the address it saw; everything to the left of it came from the client.
    const res = await post('/api/trial/card', { cardKey: toHex32(cardKey(newCardSecret())) }, '203.0.113.9, 198.51.100.7, 10.0.0.1');
    expect(res.status).toBe(429);
  });

  it('rejects a card key outside the field', async () => {
    const res = await post('/api/trial/card', { cardKey: `0x${'f'.repeat(64)}` }, '10.0.0.2');
    expect(res.status).toBe(400);
  });

  it('says so when nothing is waiting to be proven', async () => {
    expect(await (await post('/api/trial/batch', {})).json()).toEqual({ alreadyProven: true });
  });
});
