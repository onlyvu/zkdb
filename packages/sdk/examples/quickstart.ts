/**
 * The three jobs of @zkdb/sdk in one file. Starts its own anvil, so it needs only Node 20+ and Foundry.
 *   npm run quickstart -w @zkdb/sdk
 * On Fuji instead: RPC_URL=https://avalanche-fuji-c-chain-rpc.publicnode.com PRIVATE_KEY=0x… (funded with test AVAX).
 */
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalancheFuji, foundry } from 'viem/chains';
import { createLedger, newSecret, ready, rowOf, BALANCE_FIELD } from '../src/index';

const env = { ...process.env, PATH: `${homedir()}/.foundry/bin:${process.env.PATH}` };
const built = spawnSync('forge', ['build'], { cwd: fileURLToPath(new URL('../../../contracts', import.meta.url)), env, encoding: 'utf8' });
if (built.status !== 0) throw new Error(`forge build failed (run git submodule update --init?)\n${built.stderr}`);

const fuji = !!process.env.RPC_URL;
const rpc = process.env.RPC_URL ?? 'http://127.0.0.1:8565';
// Without RPC_URL: a throwaway anvil and its first dev account, which anvil keeps unlocked (no key needed).
const anvil = fuji ? undefined : spawn('anvil', ['--port', '8565', '--silent', '--code-size-limit', '100000'], { env, stdio: 'ignore' });
const key = process.env.PRIVATE_KEY as Hex | undefined;
if (fuji && !key) throw new Error('Set PRIVATE_KEY to a funded Fuji key (never commit it).');
const chain = fuji ? avalancheFuji : foundry;
const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: fuji ? 1000 : 50 });
const wallet = createWalletClient({ chain, transport: http(rpc), account: key ? privateKeyToAccount(key) : '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' });
const explorer = (h: string) => (fuji ? `https://testnet.snowtrace.io/tx/${h}` : h);

async function main() {
  for (let i = 0; i < 100 && !(await pub.getBlockNumber().then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
  await ready();

  // 1. Create a ledger. Table 1 belongs to this wallet.
  const ledger = await createLedger({ pub, wallet, table: 1n });
  console.log(`1. ledger ZkDB ${ledger.address}, gate ${ledger.gate}`);

  // 2. Write a batch: two rows, then balances. Each batch is proven and checked on-chain.
  const alice = newSecret(); // kept by Alice; the ledger stores only Poseidon2(alice)
  const bob = newSecret();
  const { queued } = await ledger.writeBatch([
    { insert: { table: 1n, fields: rowOf(1n, 0n, alice) } },
    { insert: { table: 1n, fields: rowOf(2n, 0n, bob) } },
  ]);
  const [a, b] = queued.rowIds as [bigint, bigint];
  const { batches } = await ledger.writeBatch([
    { add: { row: a, field: BALANCE_FIELD, amount: 120n } },
    { add: { row: b, field: BALANCE_FIELD, amount: 40n } },
    { sub: { row: b, field: BALANCE_FIELD, amount: 90n } }, // would go below zero: the proof marks it rejected
  ]);
  console.log(`2. batch proven in ${batches[0].provingMs} ms, accepted on-chain: ${explorer(batches[0].txHash)}; per change ok = ${batches[0].ok}`);

  // 3. A threshold claim: "some row in table 1 has at least 100", without saying which.
  const threshold = await ledger.addThreshold(1n, 100n, 'at least 100');
  const claim = await ledger.proveThreshold(threshold, alice);
  console.log(`3. claim proven in ${claim.provingMs} ms; on-chain check: ${JSON.stringify(await ledger.checkThreshold(claim))}`);
  const { txHash } = await ledger.submitThreshold(claim);
  console.log(`   recorded: ${explorer(txHash)}; a second use is refused: ${JSON.stringify(await ledger.checkThreshold(claim))}`);
  await ledger.proveThreshold(threshold, bob).catch((e) => console.log(`   Bob cannot prove it: ${(e as Error).message}`));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => anvil?.kill());
