/**
 * A second app on @zkdb/sdk: a café stamp card. Nothing here comes from the club dashboard.
 *
 *   Every coffee is one stamp. Ten stamps earn a free coffee. The barista's till writes stamps; once a day (or every
 *   16 stamps) the till proves the batch and the café's ledger accepts it on-chain. At the counter a customer proves
 *   "I hold a card with at least 10 stamps" from their phone; the till checks the proof for free and records it, so
 *   the same card cannot get the reward twice. The café never needs to know who the customer is.
 *
 *   npm run cafe -w @zkdb/example-cafe             # a throwaway anvil (Node + Foundry only)
 *   npm run cafe -w @zkdb/example-cafe -- fuji     # Avalanche Fuji; needs CAFE_KEY (funded) in the environment
 *
 * On Fuji, the run writes its transactions to docs/cafe-fuji-run.md. Customer secrets are never printed or saved.
 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalancheFuji, foundry } from 'viem/chains';
import { createLedger, newSecret, ready, rowOf, BALANCE_FIELD, type Ledger } from '@zkdb/sdk';

const STAMPS = 1n; // table id: the café's stamp cards
const FREE_COFFEE_AT = 10n;

const fuji = process.argv[2] === 'fuji';
const env = { ...process.env, PATH: `${homedir()}/.foundry/bin:${process.env.PATH}` };
const built = spawnSync('forge', ['build'], { cwd: fileURLToPath(new URL('../../contracts', import.meta.url)), env, encoding: 'utf8' });
if (built.status !== 0) throw new Error(`forge build failed\n${built.stderr}`);

const rpc = fuji ? (process.env.RPC_URL ?? 'https://avalanche-fuji-c-chain-rpc.publicnode.com') : 'http://127.0.0.1:8567';
const anvil = fuji ? undefined : spawn('anvil', ['--port', '8567', '--silent', '--code-size-limit', '100000'], { env, stdio: 'ignore' });
const key = process.env.CAFE_KEY as Hex | undefined;
if (fuji && !key) throw new Error('Set CAFE_KEY to a funded Fuji key (never commit it).');
const chain = fuji ? avalancheFuji : foundry;
const transport = http(rpc, { retryCount: 6, retryDelay: 1500 });
const pub = createPublicClient({ chain, transport, pollingInterval: fuji ? 1000 : 50 });
// On anvil the till is anvil's first dev account, which the node keeps unlocked: no key in this repo.
const till = createWalletClient({ chain, transport, account: fuji ? privateKeyToAccount(key!) : '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' });

const log: string[] = [];
const tx = (what: string, hash: string) => {
  const url = fuji ? `https://testnet.snowtrace.io/tx/${hash}` : hash;
  console.log(`  ${what}: ${url}`);
  log.push(`| ${what} | ${fuji ? `[${hash.slice(0, 10)}…](${url})` : hash} |`);
};

/** The till's side: one row per stamp card. The phone gives the till only Poseidon2(secret). */
async function newCard(ledger: Ledger, cardNo: bigint, secret: bigint) {
  return ledger.queue([{ insert: { table: STAMPS, fields: rowOf(cardNo, 0n, secret) } }]);
}

async function main() {
  for (let i = 0; i < 100 && !(await pub.getBlockNumber().then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
  await ready();

  console.log('Opening the café ledger:');
  const ledger = await createLedger({ pub, wallet: till, table: STAMPS });
  const reward = await ledger.addThreshold(STAMPS, FREE_COFFEE_AT, 'Free coffee: 10 stamps');
  console.log(`  ZkDB ${ledger.address}, reward gate ${ledger.gate}, reward #${reward}`);

  // Two regulars. Their phones make the secrets.
  const linh = newSecret();
  const nam = newSecret();
  const a = await newCard(ledger, 101n, linh);
  const b = await newCard(ledger, 102n, nam);
  tx('card 101 issued (Linh)', a.txHashes[0]);
  tx('card 102 issued (Nam)', b.txHashes[0]);
  const [linhRow, namRow] = [a.rowIds[0]!, b.rowIds[0]!];

  console.log('A week of coffees: 11 stamps for Linh, 4 for Nam, in one proven batch:');
  const week = await ledger.writeBatch([
    { add: { row: linhRow, field: BALANCE_FIELD, amount: 6n } },
    { add: { row: namRow, field: BALANCE_FIELD, amount: 4n } },
    { add: { row: linhRow, field: BALANCE_FIELD, amount: 5n } },
  ]);
  for (const [i, h] of week.queued.txHashes.entries()) tx(`stamps written (${i + 1}/3)`, h);
  for (const bt of week.batches) tx(`batch proof accepted (${bt.ok.length} changes, proved in ${bt.provingMs} ms, ${bt.gasUsed} gas)`, bt.txHash);

  console.log('At the counter:');
  const claim = await ledger.proveThreshold(reward, linh);
  const check = await ledger.checkThreshold(claim);
  console.log(`  Linh's phone proved "a card with ≥10 stamps" in ${claim.provingMs} ms; the till's free check: ${check.valid ? 'valid' : check.reason}`);
  const { txHash } = await ledger.submitThreshold(claim);
  tx('free coffee recorded (card not revealed)', txHash);
  const again = await ledger.checkThreshold(claim);
  console.log(`  The same card again: ${again.valid ? 'valid?!' : `refused (${again.reason})`}`);
  const namTry = await ledger.proveThreshold(reward, nam).then(() => 'proved?!', (e) => `no proof exists (${(e as Error).message})`);
  console.log(`  Nam tries with 4 stamps: ${namTry}`);

  if (fuji) {
    const link = (x: string) => `[\`${x}\`](https://testnet.snowtrace.io/address/${x})`;
    writeFileSync(fileURLToPath(new URL('../../docs/cafe-fuji-run.md', import.meta.url)), [
      '# Café stamp card on Fuji (second app on @zkdb/sdk)',
      '',
      `Written by \`npm run cafe -w @zkdb/example-cafe -- fuji\` on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
      '',
      `Café ledger ZkDB ${link(ledger.address)}, reward gate ${link(ledger.gate)}. Its own contracts, separate from the club's.`,
      '',
      '| Step | Transaction |', '|---|---|', ...log, '',
      `Refused as expected (simulated, no transaction): the same card claiming again (\`${again.reason}\`); a card with 4 stamps (no proof can be made).`,
      '',
    ].join('\n'));
    console.log('Wrote docs/cafe-fuji-run.md');
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => anvil?.kill());
