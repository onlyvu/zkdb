/**
 * Admin steps on the live Fuji deployment (the ZkDB and PointsGate in .env.fuji, no redeploy). Each run writes its
 * transactions to docs/.
 *
 *   npm run trial:setup -w @zkdb/dashboard
 *     Try-it mode: makes TRIAL_KEY in .env.fuji.local (gitignored) and funds it; the owner makes it a writer and the
 *     owner of table 900; the gate admin adds the perk "Trial: at least 100 points" on table 900. Prints the server
 *     settings to start the API with. Writes docs/fuji-trial-setup.md.
 *
 *   npm run governor -w @zkdb/dashboard -- [delaySeconds]
 *     Ends single-key ownership of ZkDB: deploys AdminGovernor (2 of 3 signers, the given delay, default 120 s),
 *     the owner key starts the transfer, signer 1 proposes acceptOwnership, signer 2 approves, the script waits the
 *     delay and executes. Then it shows that the old owner key is refused (a simulated call, no gas). Writes
 *     docs/fuji-governance-run.md.
 *     The three signer keys are made in .env.fuji.local. On one laptop they are one team's keys, so this shows the
 *     mechanism, not independent people; replace GOV_SIGNERS with addresses held by different people for real use.
 *
 * Run trial:setup before governor: after the handover, setWriter and setTableOwner go through the governor.
 * Works against anvil too: RPC_URL=http://127.0.0.1:8545 ZKDB_ADDRESS=… GATE_ADDRESS=… DEPLOYER_KEY=…
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, encodeFunctionData, formatEther, http, parseEther, type Abi, type Address, type Chain, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { avalancheFuji, foundry } from 'viem/chains';

const pathOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const CONTRACTS = pathOf('../../../contracts');
const LOCAL_ENV = pathOf('../.env.fuji.local');
for (const f of ['../.env.fuji', '../.env.fuji.local']) {
  try {
    process.loadEnvFile(pathOf(f));
  } catch {
    // optional
  }
}

const rpc = process.env.RPC_URL ?? process.env.VITE_RPC_URL!;
const local = /127\.0\.0\.1|localhost/.test(rpc);
const chain: Chain = local ? foundry : avalancheFuji;
const explorer = local ? '' : (process.env.VITE_EXPLORER_URL ?? 'https://testnet.snowtrace.io');
const DB = (process.env.ZKDB_ADDRESS ?? process.env.VITE_ZKDB_ADDRESS) as Address;
const GATE = (process.env.GATE_ADDRESS ?? process.env.VITE_GATE_ADDRESS) as Address;
const TRIAL_TABLE = BigInt(process.env.ZKDB_TRIAL_TABLE ?? 900);
const TRIAL_MIN = 100n;

const transport = http(rpc, { retryCount: 6, retryDelay: 1500 });
const pub = createPublicClient({ chain, transport, pollingInterval: 1000 });
const walletOf = (key: Hex) => createWalletClient({ chain, transport, account: privateKeyToAccount(key) });

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const a = JSON.parse(readFileSync(`${CONTRACTS}/out/${name}.sol/${name}.json`, 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object };
}

function localKey(name: string): Hex {
  let k = process.env[name] as Hex | undefined;
  if (!k) {
    k = generatePrivateKey();
    process.env[name] = k;
    if (!local) {
      appendFileSync(LOCAL_ENV, `\n${name}=${k}\n`);
      console.log(`Created ${name} in .env.fuji.local`);
    }
  }
  return k;
}

const rows: string[] = [];
const link = (hash: string) => (explorer ? `[${hash.slice(0, 10)}…](${explorer}/tx/${hash})` : `\`${hash}\``);
const addr = (a: string) => (explorer ? `[\`${a}\`](${explorer}/address/${a})` : `\`${a}\``);

async function tx(what: string, wallet: ReturnType<typeof walletOf>, req: { to: Address; data?: Hex; value?: bigint } | { abi: Abi; bytecode: Hex; args: unknown[] }) {
  const hash = 'bytecode' in req
    ? await wallet.deployContract({ ...req, account: wallet.account, chain })
    : await wallet.sendTransaction({ ...req, account: wallet.account, chain });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${what} reverted: ${explorer}/tx/${hash}`);
  console.log(`  ${what}: gas ${r.gasUsed}  ${explorer ? `${explorer}/tx/${hash}` : hash}`);
  rows.push(`| ${what} | ${wallet.account.address.slice(0, 10)}… | ${r.gasUsed} | ${link(hash)} |`);
  return r;
}

async function fund(from: ReturnType<typeof walletOf>, to: Address, what: string) {
  // Fuji fees are far below a nAVAX per gas, so a small float lasts; FUND_AVAX / FUND_MIN_AVAX change it.
  const amount = parseEther(process.env.FUND_AVAX ?? '0.05');
  const min = parseEther(process.env.FUND_MIN_AVAX ?? '0.02');
  if ((await pub.getBalance({ address: to })) < min) await tx(`fund ${what} (${formatEther(amount)})`, from, { to, value: amount });
}

function doc(file: string, title: string, intro: string[]) {
  if (local) return console.log('(local chain: no doc written)');
  writeFileSync(pathOf(`../../../docs/${file}`), [
    `# ${title}`, '', `Written by \`scripts/fuji-admin.ts\` on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`, '',
    ...intro, '', '| Step | From | Gas | Transaction |', '|---|---|---|---|', ...rows, '',
  ].join('\n'));
  console.log(`Wrote docs/${file}`);
}

const db = () => ({ address: DB, abi: artifact('ZkDB').abi });

async function trialSetup() {
  const owner = walletOf(process.env.DEPLOYER_KEY as Hex);
  const trial = privateKeyToAccount(localKey('TRIAL_KEY'));
  const { abi: dbAbi } = db();
  const gateAbi = artifact('PointsGate').abi;
  console.log(`Trial key ${trial.address}, table ${TRIAL_TABLE}`);
  await fund(owner, trial.address, 'trial key');
  if (!(await pub.readContract({ address: DB, abi: dbAbi, functionName: 'isWriter', args: [trial.address] }))) {
    await tx('setWriter(trial key)', owner, { to: DB, data: encodeFunctionData({ abi: dbAbi, functionName: 'setWriter', args: [trial.address, true] }) });
  }
  if ((await pub.readContract({ address: DB, abi: dbAbi, functionName: 'tableOwner', args: [TRIAL_TABLE] })) !== trial.address) {
    await tx(`setTableOwner(${TRIAL_TABLE}, trial key)`, owner, { to: DB, data: encodeFunctionData({ abi: dbAbi, functionName: 'setTableOwner', args: [TRIAL_TABLE, trial.address] }) });
  }
  const count = Number(await pub.readContract({ address: GATE, abi: gateAbi, functionName: 'perkCount' }));
  let perkId = -1;
  for (let i = 0; i < count; i++) {
    const p = await pub.readContract({ address: GATE, abi: gateAbi, functionName: 'perk', args: [BigInt(i)] }) as { tableId: bigint };
    if (p.tableId === TRIAL_TABLE) perkId = i;
  }
  if (perkId < 0) {
    perkId = count;
    await tx(`addPerk(table ${TRIAL_TABLE}, ≥${TRIAL_MIN})`, owner, { to: GATE, data: encodeFunctionData({ abi: gateAbi, functionName: 'addPerk', args: [TRIAL_TABLE, TRIAL_MIN, 'Trial: at least 100 points'] }) });
  }
  if (!process.env.RELAYER_KEY) console.warn('No RELAYER_KEY: the claim step of the trial needs the claim relayer.');
  console.log(`\nStart the API server with (TRIAL_KEY is already in .env.fuji.local):\n  ZKDB_TRIAL_PERK=${perkId} ZKDB_TRIAL_TABLE=${TRIAL_TABLE} ZKDB_MODE=fuji npm run server -w @zkdb/dashboard`);
  if (!local) appendFileSync(LOCAL_ENV, `\nZKDB_TRIAL_PERK=${perkId}\nZKDB_TRIAL_TABLE=${TRIAL_TABLE}\n`);
  doc('fuji-trial-setup.md', 'Try-it mode set up on Fuji', [
    `Trial key ${addr(trial.address)} writes table ${TRIAL_TABLE} of ZkDB ${addr(DB)}; perk #${perkId} on PointsGate ${addr(GATE)} needs ${TRIAL_MIN} points on that table.`,
    'The club table (1) is untouched: the trial key owns no other table, and the server refuses a trial table equal to the club table.',
  ]);
}

async function governor() {
  const delay = BigInt(process.argv[3] ?? 120);
  const owner = walletOf(process.env.DEPLOYER_KEY as Hex);
  const keys = [localKey('GOV_SIGNER_1'), localKey('GOV_SIGNER_2'), localKey('GOV_SIGNER_3')];
  const signers = keys.map(walletOf);
  const signerAddrs = (process.env.GOV_SIGNERS?.split(',') as Address[] | undefined) ?? signers.map((s) => s.account.address);
  const { abi: dbAbi } = db();
  const govArt = artifact('AdminGovernor');
  const current = await pub.readContract({ address: DB, abi: dbAbi, functionName: 'owner' }) as Address;
  if (current.toLowerCase() !== owner.account.address.toLowerCase()) throw new Error(`ZkDB owner is ${current}, not the deployer key. Already handed over?`);
  for (const [i, s] of signers.slice(0, 2).entries()) await fund(owner, s.account.address, `signer ${i + 1}`);

  console.log(`Deploying AdminGovernor: 2 of ${signerAddrs.length}, delay ${delay}s`);
  const deployed = await tx('deploy AdminGovernor', owner, { ...govArt, args: [signerAddrs, 2n, delay] });
  const gov = deployed.contractAddress!;
  await tx('ZkDB.transferOwnership(governor) by the old owner key', owner, { to: DB, data: encodeFunctionData({ abi: dbAbi, functionName: 'transferOwnership', args: [gov] }) });
  const accept = encodeFunctionData({ abi: dbAbi, functionName: 'acceptOwnership' });
  const call = (name: string, args: unknown[]) => encodeFunctionData({ abi: govArt.abi, functionName: name, args });
  const id = await pub.readContract({ address: gov, abi: govArt.abi, functionName: 'actionCount' }) as bigint;
  await tx(`governor.propose(acceptOwnership) #${id} by signer 1`, signers[0], { to: gov, data: call('propose', [DB, accept]) });

  // One signature is never enough: simulate execute now.
  const refused = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      throw new Error(`${label} was not refused`);
    } catch (e) {
      const rev = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
      const name = rev instanceof ContractFunctionRevertedError ? rev.data?.errorName : String((e as Error).message).slice(0, 80);
      console.log(`  refused as expected: ${label} → ${name}`);
      rows.push(`| ${label} | (simulated, no transaction) | — | refused: \`${name}\` |`);
    }
  };
  await refused('execute with 1 of 2 signatures', () => pub.simulateContract({ address: gov, abi: govArt.abi, functionName: 'execute', args: [id], account: signers[0].account }));
  await tx(`governor.approve #${id} by signer 2`, signers[1], { to: gov, data: call('approve', [id]) });
  await refused('execute before the delay', () => pub.simulateContract({ address: gov, abi: govArt.abi, functionName: 'execute', args: [id], account: signers[0].account }));
  console.log(`Waiting ${delay}s for the timelock…`);
  const ready = (await pub.readContract({ address: gov, abi: govArt.abi, functionName: 'action', args: [id] }) as { readyAt: bigint }).readyAt;
  for (;;) {
    const block = await pub.getBlock();
    if (block.timestamp >= ready) break;
    await new Promise((r) => setTimeout(r, 5000));
    if (local) await pub.request({ method: 'evm_mine' as never, params: [] as never }).catch(() => {});
  }
  await tx(`governor.execute #${id}: ZkDB.acceptOwnership`, signers[0], { to: gov, data: call('execute', [id]) });
  const now = await pub.readContract({ address: DB, abi: dbAbi, functionName: 'owner' }) as Address;
  if (now.toLowerCase() !== gov.toLowerCase()) throw new Error('ownership did not move');
  await refused('old owner key: setTableAuditor(1, 0)', () => pub.simulateContract({ address: DB, abi: dbAbi, functionName: 'setTableAuditor', args: [1n, '0x0000000000000000000000000000000000000000'], account: owner.account }));
  await refused('one signer: setTableAuditor(1, 0) directly', () => pub.simulateContract({ address: DB, abi: dbAbi, functionName: 'setTableAuditor', args: [1n, '0x0000000000000000000000000000000000000000'], account: signers[0].account }));
  if (!local) appendFileSync(LOCAL_ENV, `\nGOVERNOR_ADDRESS=${gov}\n`);
  doc('fuji-governance-run.md', 'ZkDB ownership moved to a 2-of-3 governor with a timelock', [
    `ZkDB ${addr(DB)} is now owned by AdminGovernor ${addr(gov)}: signers ${signerAddrs.map((a) => `\`${a}\``).join(', ')}, threshold 2, delay ${delay} s.`,
    'Turning the auditor rule off or on, adding or removing a writer, assigning a table and handing ownership on now need two signers and the delay; any one signer can cancel during the delay.',
    'Limit: the three signer keys were made on one team machine for this run, so they show the mechanism, not three independent people.',
    'Not covered: the batch verifier cannot be changed by anyone (it is immutable in ZkDB), and PointsGate\'s admin is an immutable single key that can only add perks.',
  ]);
  console.log(`Total spent by the deployer: see the explorer. Balance now ${formatEther(await pub.getBalance({ address: owner.account.address }))}`);
}

const env = { ...process.env, PATH: `${homedir()}/.foundry/bin:${process.env.PATH}` };
const built = spawnSync('forge', ['build'], { cwd: CONTRACTS, env, encoding: 'utf8' });
if (built.status !== 0) throw new Error(`forge build failed\n${built.stderr}`);
if (!process.env.DEPLOYER_KEY) throw new Error('Set DEPLOYER_KEY in packages/dashboard/.env.fuji.local');
const cmd = process.argv[2];
(cmd === 'trial-setup' ? trialSetup() : cmd === 'governor' ? governor() : Promise.reject(new Error('Usage: fuji-admin.ts trial-setup | governor [delaySeconds]')))
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
