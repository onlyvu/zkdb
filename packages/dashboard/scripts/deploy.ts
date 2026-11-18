/**
 * Deploys zkDB to a public network and seeds it like the local demo (see seed.ts): ZkDB + BatchVerifier, PointsGate +
 * ClaimVerifier, and RootRelay, which sends each proven root to another Avalanche L1 over ICM. Writes measured gas,
 * fees and times to docs/<network>-measurements.md.
 *
 * Usage: npm run deploy:fuji -w @zkdb/dashboard
 * Needs DEPLOYER_KEY in packages/dashboard/.env.fuji.local (gitignored), funded with test AVAX. The other test keys
 * (treasurer, auditor, claim relayer, mirror deployer) are created there on first run.
 * Writes the public settings (addresses, RPC, explorer) to packages/dashboard/.env.fuji, which is committed.
 */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, formatEther, getContractAddress, http, parseEther, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { initHash, ZkDbState } from '@zkdb/core';
import { fileStore } from '../server/meta';
import { measurementsTable, seedPoints, type Role, type Send } from './seed';
import { avalancheFuji } from 'viem/chains';

const NETWORKS = {
  fuji: {
    chain: avalancheFuji,
    // The official endpoint caps eth_getLogs at 100 blocks; publicnode allows 50,000 and sends CORS headers.
    rpc: 'https://avalanche-fuji-c-chain-rpc.publicnode.com',
    logRange: 50_000,
    name: 'Avalanche Fuji',
    currency: 'AVAX',
    explorer: 'https://testnet.snowtrace.io',
    // Avalanche Data API (Glacier): sender, block time and fee of the contract's transactions in one request.
    dataApi: 'https://data-api.avax.network/v1/chains/43113',
    // Fuji fees are a few wei per gas. The dashboard also prices the same gas at this network's live base fee.
    priceRef: { name: 'C-Chain mainnet', rpc: 'https://api.avax.network/ext/bc/C/rpc' },
    // ICM: TeleporterMessenger has the same address on every Avalanche chain. Roots go to the Dispatch test L1,
    // delivered by the public Fuji relayer.
    icm: {
      teleporter: '0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf',
      name: 'Dispatch L1',
      blockchainId: '0x9f3be606497285d0ffbb5ac9ba24aa60346a9b1812479ed66cb329f394a4b1c7',
      rpc: 'https://subnets.avax.network/dispatch/testnet/rpc',
      explorer: 'https://subnets-test.avax.network/dispatch',
    },
  },
} as const;

const network = (process.argv[2] ?? 'fuji') as keyof typeof NETWORKS;
const net = NETWORKS[network];
if (!net) throw new Error(`Unknown network ${process.argv[2]}. Known: ${Object.keys(NETWORKS).join(', ')}`);

const pathOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const CONTRACTS = pathOf('../../../contracts');
try {
  process.loadEnvFile(pathOf(`../.env.${network}.local`));
} catch {
  // The key can also come from the environment.
}
const key = process.env.DEPLOYER_KEY as Hex | undefined;
if (!key) throw new Error(`Set DEPLOYER_KEY in packages/dashboard/.env.${network}.local`);

const account = privateKeyToAccount(key);
const transport = http(process.env.RPC_URL ?? net.rpc, { retryCount: 6, retryDelay: 1500 });
const pub = createPublicClient({ chain: net.chain, transport, pollingInterval: 1000 });
const wallet = createWalletClient({ chain: net.chain, transport, account });

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const a = JSON.parse(readFileSync(`${CONTRACTS}/out/${name}.sol/${name}.json`, 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object };
}

/** A shared RPC and a shared owner key: rate limits and nonce clashes are retried. */
async function retry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (e) {
      const msg = String((e as Error).message);
      if (attempt >= 4 || !/nonce|replacement|underpriced|429|rate limit/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

/** A test key from the local env file, created there on first use. */
function localKey(name: string): Hex {
  let k = process.env[name] as Hex | undefined;
  if (!k) {
    k = generatePrivateKey();
    appendFileSync(pathOf(`../.env.${network}.local`), `\n${name}=${k}\n`);
    console.log(`Created ${name} in the local env file.`);
  }
  return k;
}

async function main() {
  const env = { ...process.env, PATH: `${homedir()}/.foundry/bin:${process.env.PATH}` };
  const built = spawnSync('forge', ['build'], { cwd: CONTRACTS, env, encoding: 'utf8' });
  if (built.status !== 0) throw new Error(`forge build failed\n${built.stderr ?? built.error}`);

  const balance = await pub.getBalance({ address: account.address });
  console.log(`Deployer ${account.address} on ${net.name}: ${formatEther(balance)} ${net.currency}`);
  if (balance === 0n) throw new Error(`The deployer has no ${net.currency}. Fund it from the faucet first.`);

  let fee = 0n;
  const wait = async (hash: Hex, what: string) => {
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${what} reverted (${net.explorer}/tx/${hash})`);
    fee += r.gasUsed * r.effectiveGasPrice;
    console.log(`  ${what}: gas ${r.gasUsed}  ${net.explorer}/tx/${hash}`);
    return r;
  };
  const deploy = async (name: string, args: unknown[]) => {
    const { abi, bytecode } = artifact(name);
    const r = await wait(await retry(() => wallet.deployContract({ abi, bytecode, args })), `deploy ${name}`);
    return { address: r.contractAddress!, block: r.blockNumber };
  };

  await initHash();
  const verifier = await deploy('BatchVerifier', []);
  const db = await deploy('ZkDB', [verifier.address, `0x${new ZkDbState().root.toString(16).padStart(64, '0')}`]);
  const claimVerifier = await deploy('ClaimVerifier', []);
  const gate = await deploy('PointsGate', [db.address, claimVerifier.address]);
  // RootMirror will be the first contract the mirror deployer creates on the destination L1, so its address is
  // known now and the relay can be told where to send.
  const mirror = getContractAddress({ from: privateKeyToAccount(localKey('MIRROR_DEPLOYER_KEY')).address, nonce: 0n });
  const relay = await deploy('RootRelay', [db.address, net.icm.teleporter, net.icm.blockchainId, mirror]);

  // The other roles are separate test accounts with a little AVAX for gas: the treasurer writes the points table
  // and submits proofs, the auditor co-signs corrections, the relayer pays for members' claims.
  const roles = {
    owner: wallet,
    treasurer: createWalletClient({ chain: net.chain, transport, account: privateKeyToAccount(localKey('TREASURER_KEY')) }),
    auditor: createWalletClient({ chain: net.chain, transport, account: privateKeyToAccount(localKey('AUDITOR_KEY')) }),
    relayer: createWalletClient({ chain: net.chain, transport, account: privateKeyToAccount(localKey('RELAYER_KEY')) }),
  } as const;
  for (const role of ['treasurer', 'auditor', 'relayer'] as const) {
    const to = roles[role].account.address;
    if ((await pub.getBalance({ address: to })) < parseEther('0.005')) {
      await wait(await retry(() => wallet.sendTransaction({ to, value: parseEther('0.01') })), `fund ${role}`);
    }
  }

  const targets: Record<string, { address: Address; abi: Abi }> = {
    db: { address: db.address, abi: artifact('ZkDB').abi },
    gate: { address: gate.address, abi: artifact('PointsGate').abi },
    relay: { address: relay.address, abi: artifact('RootRelay').abi },
  };
  const send: Send = async (role: Role, target, functionName, args) => {
    // Only the broadcast is retried: once a hash exists, sending again would queue the change twice.
    const sendWall = Date.now();
    const hash = await retry(() => roles[role].writeContract({ ...targets[target], functionName, args }));
    const sentAt = performance.now();
    const receipt = await retry(() => pub.waitForTransactionReceipt({ hash, pollingInterval: 250 }));
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted (${net.explorer}/tx/${hash})`);
    const confirmMs = Math.round(performance.now() - sentAt);
    fee += receipt.gasUsed * receipt.effectiveGasPrice;
    // Avalanche blocks carry a millisecond timestamp: how long after we sent the transaction its block was built.
    // It compares this machine's clock with the validators', so it is good to a few tens of milliseconds.
    const block = await retry(() => pub.request({ method: 'eth_getBlockByNumber', params: [`0x${receipt.blockNumber.toString(16)}`, false] })) as { timestampMilliseconds?: Hex } | null;
    const inBlockMs = block?.timestampMilliseconds ? Number(BigInt(block.timestampMilliseconds)) - sendWall : undefined;
    return { receipt, confirmMs, inBlockMs };
  };

  console.log('Seeding the points program:');
  const meta = fileStore(pathOf(`../server/proof-meta/${db.address.toLowerCase()}.json`));
  const { measured, cards } = await seedPoints({
    send, owner: account.address, treasurer: roles.treasurer.account.address, auditor: roles.auditor.account.address, gate: true, relay: true, meta,
  });
  // Card secrets of the seeded members: local and uncommitted (*.local is gitignored). The dashboard server offers
  // them on the Perks page only when started with ZKDB_DEMO=1.
  writeFileSync(pathOf(`../.demo-cards.${network}.local`), JSON.stringify(cards, null, 1) + '\n');
  const link = (a: string) => `[${a}](${net.explorer}/address/${a})`;
  writeFileSync(pathOf(`../../../docs/${network}-measurements.md`), [
    `# Measured on ${net.name}`,
    '',
    `Written by \`npm run deploy:${network} -w @zkdb/dashboard\` on ${new Date().toISOString().slice(0, 10)}.`,
    '',
    `- ZkDB ${link(db.address)}, BatchVerifier ${link(verifier.address)}`,
    `- PointsGate ${link(gate.address)}, ClaimVerifier ${link(claimVerifier.address)}`,
    `- RootRelay ${link(relay.address)} (sends to \`${mirror}\` on ${net.icm.name}, where RootMirror is not deployed yet)`,
    '',
    '"Receipt after" is the time from broadcasting the transaction to having its receipt (polled every 250 ms).',
    '"In a block after" is the time from sending the transaction to the millisecond timestamp of the block that included it; it compares the deploying machine\'s clock with the validators\'.',
    '"Proved in" is UltraHonk proof generation with bb.js on the deploying machine.',
    'Fees are gas used × the price actually paid: 160 wei per gas, which is the Fuji base fee that day (10 wei) plus the wallet\'s 150 wei tip. The README prices the same gas at the C-Chain mainnet base fee.',
    '',
    measurementsTable(measured, net.currency, net.explorer),
    '',
  ].join('\n'));

  writeFileSync(pathOf(`../.env.${network}`), [
    `# ${net.name} deployment, written by scripts/deploy.ts. Public values only.`,
    `VITE_ZKDB_ADDRESS=${db.address}`,
    `VITE_ZKDB_FROM_BLOCK=${verifier.block}`,
    `VITE_GATE_ADDRESS=${gate.address}`,
    `VITE_RELAY_ADDRESS=${relay.address}`,
    `VITE_RPC_URL=${net.rpc}`,
    `VITE_LOG_RANGE=${net.logRange}`,
    `VITE_NETWORK_NAME=${net.name}`,
    `VITE_CURRENCY=${net.currency}`,
    `VITE_EXPLORER_URL=${net.explorer}`,
    `VITE_DATA_API_URL=${net.dataApi}`,
    `VITE_PRICE_REF_NAME=${net.priceRef.name}`,
    `VITE_PRICE_REF_RPC_URL=${net.priceRef.rpc}`,
    `VITE_ICM_NAME=${net.icm.name}`,
    `VITE_ICM_RPC_URL=${net.icm.rpc}`,
    `VITE_ICM_TELEPORTER=${net.icm.teleporter}`,
    `VITE_ICM_EXPLORER_URL=${net.icm.explorer}`,
    `VITE_ICM_MIRROR=${mirror}`,
    '',
  ].join('\n'));
  console.log(`\nZkDB ${db.address}  ${net.explorer}/address/${db.address}`);
  console.log(`BatchVerifier ${verifier.address}\nPointsGate ${gate.address}\nClaimVerifier ${claimVerifier.address}\nRootRelay ${relay.address} → mirror ${mirror}`);
  console.log(`Total fee ${formatEther(fee)} ${net.currency}. Settings written to packages/dashboard/.env.${network}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
