/**
 * Local demo: starts anvil, deploys the real ZkDB, PointsGate and both verifiers, seeds the points program with three
 * batches and one zero-knowledge claim that are proven for real and verified on-chain (see seed.ts), then serves the
 * dashboard with demo mode on (anvil's own test accounts, and the seeded card secrets for the Perks page).
 * ICM needs a real Avalanche network, so the root relay exists only on Fuji.
 * Usage: npm run demo -w @zkdb/dashboard [-- --no-ui]
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { initHash, ZkDbState } from '@zkdb/core';
import { fileStore } from '../server/meta';
import { seedPoints, type Send } from './seed';

// Not anvil's default 8545, so the demo can run next to other local chains (override with ZKDB_ANVIL_PORT).
const PORT = Number(process.env.ZKDB_ANVIL_PORT ?? 8559);
const RPC = `http://127.0.0.1:${PORT}`;
const pathOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const CONTRACTS = pathOf('../../../contracts');
const env = { ...process.env, PATH: `${homedir()}/.foundry/bin:${process.env.PATH}` };
const children: ChildProcess[] = [];

const stop = (code = 0) => { for (const c of children) c.kill(); process.exit(code); };
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

const transport = http(RPC);
const pub = createPublicClient({ chain: foundry, transport, pollingInterval: 50 });
const rpcUp = () => pub.getBlockNumber().then(() => true, () => false);

async function startAnvil() {
  if (await rpcUp()) throw new Error(`An RPC is already running on port ${PORT}. Stop it and run the demo again.`);
  const anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { env, stdio: 'inherit' });
  anvil.on('error', () => { console.error('Could not start anvil. Install Foundry first.'); stop(1); });
  anvil.on('exit', () => { console.error('anvil stopped, shutting the demo down.'); stop(1); });
  children.push(anvil);
  for (let i = 0; i < 100 && !(await rpcUp()); i++) await new Promise((r) => setTimeout(r, 100));
  if (!(await rpcUp())) throw new Error('anvil did not respond.');
}

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const a = JSON.parse(readFileSync(`${CONTRACTS}/out/${name}.sol/${name}.json`, 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object };
}

async function main() {
  const built = spawnSync('forge', ['build'], { cwd: CONTRACTS, env, encoding: 'utf8' });
  if (built.status !== 0) {
    throw new Error(`forge build failed (did you run git submodule update --init?)\n${built.stderr ?? built.error}`);
  }
  await startAnvil();

  // anvil keeps its dev accounts unlocked, so no private key is needed here.
  const wallet = createWalletClient({ chain: foundry, transport });
  const [owner, treasurer, auditor, relayer] = (await wallet.getAddresses()) as [Address, Address, Address, Address];

  const deploy = async (name: string, args: unknown[]) => {
    const { abi, bytecode } = artifact(name);
    const hash = await wallet.deployContract({ abi, bytecode, args, account: owner });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  };

  const verifier = await deploy('BatchVerifier', []);
  await initHash();
  const address = await deploy('ZkDB', [verifier, `0x${new ZkDbState().root.toString(16).padStart(64, '0')}`]);
  const gate = await deploy('PointsGate', [address, await deploy('ClaimVerifier', [])]);
  const targets = { db: { address, abi: artifact('ZkDB').abi }, gate: { address: gate, abi: artifact('PointsGate').abi } };

  const accountOf = { owner, treasurer, auditor, relayer } as const;
  const send: Send = async (role, target, functionName, args) => {
    if (target === 'relay') throw new Error('no ICM on a local chain');
    const hash = await wallet.writeContract({ ...targets[target], functionName, args, account: accountOf[role] });
    const sentAt = performance.now();
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
    return { receipt, confirmMs: Math.round(performance.now() - sentAt) };
  };

  console.log('Seeding the points program (three batch proofs and one claim proof, verified on-chain):');
  const meta = fileStore(pathOf(`../server/proof-meta/${address.toLowerCase()}.json`));
  const { cards } = await seedPoints({ send, owner, treasurer, auditor, gate: true, meta });
  // The seed played the members and made their card secrets. They stay in a local, uncommitted file; the demo's own
  // server reads it (ZKDB_DEMO=1 below) so the Perks page can offer the cards.
  writeFileSync(pathOf('../.demo-cards.anvil.local'), JSON.stringify(cards, null, 1) + '\n');

  writeFileSync(pathOf('../.env.local'), `VITE_ZKDB_ADDRESS=${address}\nVITE_GATE_ADDRESS=${gate}\nVITE_RPC_URL=${RPC}\n`);
  console.log(`ZkDB: ${address}\nGate: ${gate}\nRPC:  ${RPC}`);
  console.log(`Test accounts in anvil order: owner ${owner}, treasurer ${treasurer}, auditor ${auditor}; ${relayer} relays claims.`);

  const server = spawn('npx', ['tsx', 'server/main.ts'], { cwd: pathOf('..'), env: { ...env, ZKDB_DEMO: '1' }, stdio: 'inherit' });
  server.on('exit', () => { console.error('The API server stopped, shutting the demo down.'); stop(1); });
  children.push(server);

  if (process.argv.includes('--no-ui')) {
    console.log('Anvil is still running. Press Ctrl-C to stop.');
    return;
  }
  const ui = spawn('npx', ['vite', '--port', '5173', '--strictPort'], { cwd: pathOf('..'), env, stdio: 'inherit' });
  ui.on('exit', (code) => stop(code ?? 0));
  children.push(ui);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); stop(1); });
