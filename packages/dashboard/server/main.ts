import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readConfig } from '../src/chain';
import { createApp, randomSecret, type DemoCard, type DemoOptions, type DemoRole, type Prover, type SendTx } from './app';
import { fileStore } from './meta';

// ZKDB_MODE=fuji reads .env.fuji (the public deployment) and, if present, .env.fuji.local (test keys, gitignored);
// otherwise .env.local (written by the local demo).
const mode = process.env.ZKDB_MODE;
for (const file of mode ? [`../.env.${mode}`, `../.env.${mode}.local`] : ['../.env.local']) {
  try {
    process.loadEnvFile(fileURLToPath(new URL(file, import.meta.url)));
  } catch {
    // Optional: the same values can come from the environment.
  }
}

const chain = readConfig(process.env);
if (!chain) {
  console.error('Set VITE_ZKDB_ADDRESS to the deployed ZkDB address.');
  process.exit(1);
}

/** Loaded on first use, so the server still starts on a machine without a built circuit. */
const prove: Prover = async (batch) => {
  const { loadCircuit, proveBatch, verifyBatch } = await import('@zkdb/core/prover');
  const circuit = loadCircuit();
  const proof = await proveBatch(batch, circuit);
  if (!(await verifyBatch(proof, circuit))) throw new Error('generated proof did not verify');
  return proof;
};

const transport = http(chain.rpcUrl, { retryCount: 4, retryDelay: 1000 });
const pub = createPublicClient({ transport });
const LOCAL_CHAIN_ID = 31337;

/** A sender for one private key. Transactions are sent one after another, so nonces never collide. */
function keySender(key: Hex): { address: Address; send: SendTx; signMessage: (raw: Hex) => Promise<Hex> } {
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, transport });
  let last: Promise<unknown> = Promise.resolve();
  const send: SendTx = (tx) => {
    const next = last.then(async () => wallet.sendTransaction({ ...tx, chain: null }));
    last = next.catch(() => {});
    return next;
  };
  return { address: account.address, send, signMessage: (raw) => account.signMessage({ message: { raw } }) };
}

/** Who pays the gas of members' claims: RELAYER_KEY, or on the local chain an unlocked anvil account. */
async function relayer(): Promise<SendTx | undefined> {
  if (process.env.RELAYER_KEY) return keySender(process.env.RELAYER_KEY as Hex).send;
  if ((await pub.getChainId().catch(() => 0)) !== LOCAL_CHAIN_ID) return undefined;
  const wallet = createWalletClient({ transport });
  const account = (await wallet.getAddresses())[3];
  return account ? (tx) => wallet.sendTransaction({ ...tx, account, chain: null }) : undefined;
}

const port = Number(process.env.ZKDB_API_PORT ?? 8788);
const domains = (process.env.ZKDB_SIWE_DOMAINS ?? 'localhost:5173,127.0.0.1:5173').split(',');

/**
 * Demo mode: only with ZKDB_DEMO=1, never in production. The test keys in the local env file then appear in the
 * sign-in dialog and this server signs for them, and the Perks page is given the secrets of the seeded cards (kept
 * by the deploy script in a local file), so every role and a claim can be recorded without a wallet extension.
 */
function demo(): DemoOptions | undefined {
  if (process.env.ZKDB_DEMO !== '1' || process.env.NODE_ENV === 'production') return undefined;
  const accounts = ([['DEPLOYER_KEY', 'Owner', 'owner'], ['TREASURER_KEY', 'Treasurer', 'treasurer'], ['AUDITOR_KEY', 'Auditor', 'auditor']] as const)
    .filter(([name]) => /^0x[0-9a-fA-F]{64}$/.test(process.env[name] ?? ''))
    .map(([name, label, role]) => ({ label, role: role as DemoRole, ...keySender(process.env[name] as Hex) }));
  let cards: DemoCard[] = [];
  try {
    cards = JSON.parse(readFileSync(fileURLToPath(new URL(`../.demo-cards.${mode ?? 'anvil'}.local`, import.meta.url)), 'utf8'));
  } catch {
    // No seeded cards on this machine.
  }
  if (accounts.length === 0 && cards.length === 0) return undefined;
  console.warn(`ZKDB_DEMO=1: this server signs for ${accounts.length} test account(s) and holds ${cards.length} demo card secret(s). Local recording only; do not expose this port.`);
  return { accounts, cards, hosts: [...domains, `127.0.0.1:${port}`, `localhost:${port}`] };
}

const app = createApp({
  chain,
  domains,
  // Without a configured secret, sessions simply end when the server restarts.
  secret: process.env.ZKDB_SESSION_SECRET ?? randomSecret(),
  secureCookie: process.env.NODE_ENV === 'production',
  prove,
  relayer: await relayer(),
  demo: demo(),
  relayPerHour: process.env.ZKDB_RELAY_PER_HOUR ? Number(process.env.ZKDB_RELAY_PER_HOUR) : undefined,
  programTable: BigInt(process.env.VITE_PROGRAM_TABLE ?? 1),
  // Committed for public deployments (fuji), so anyone running the dashboard sees the measured proving times.
  meta: fileStore(fileURLToPath(new URL(`./proof-meta/${chain.address.toLowerCase()}.json`, import.meta.url))),
});
createServer(app).listen(port, '127.0.0.1', () => console.log(`zkDB API on http://127.0.0.1:${port}`));
