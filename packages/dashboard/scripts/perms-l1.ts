/**
 * The permission model of the school L1 (zkdb, chainId 510102), shown live: who may send a transaction and who may
 * deploy a contract is decided by the chain itself (Subnet-EVM precompiles), not by our contracts.
 *
 *   npm run perms:l1 -w @zkdb/dashboard
 *
 *   1. an outsider wallet (it holds ZKD) sends a transfer and a deploy: the L1 refuses both (TxAllowList)
 *   2. the claim relayer (allowed to send, not to deploy) tries a deploy: refused (ContractDeployerAllowList)
 *   3. the school admin makes two new wallets, a school deployer and a claim relayer, and funds them; the new relayer
 *      tries to send before it is enabled: refused
 *   4. the admin enables both (and the deployer on the deployer list)
 *   5. the new deployer deploys a perk gate for a second club (reading RootMirror) and adds a perk
 *   6. the new relayer sends a transaction; flow:l1 --relayer NEW_CLAIM_RELAYER_KEY then has it forward a real claim
 *   7. the admin takes the new deployer off the deployer list; its next deploy is refused
 *
 * The new keys are kept in packages/dashboard/.env.l1-members.local (gitignored) and never printed.
 * Writes docs/l1-permissions.json and docs/l1-permissions.md.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createWalletClient, encodeDeployData, formatEther, http, parseAbi, parseEther, parseGwei, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { PROGRAM } from '../src/points';
import { artifact, L1, l1, pathOf, readDeployment, zkdbL1 } from './l1';

export const TX_ALLOW_LIST: Address = '0x0200000000000000000000000000000000000002';
export const DEPLOYER_ALLOW_LIST: Address = '0x0200000000000000000000000000000000000000';
export const allowListAbi = parseAbi([
  'function readAllowList(address addr) view returns (uint256 role)',
  'function setEnabled(address addr)',
  'function setAdmin(address addr)',
  'function setNone(address addr)',
]);
export const ROLE = ['none', 'enabled', 'admin', 'manager'] as const;

const MEMBERS = pathOf('../.env.l1-members.local');
const d = readDeployment();
if (!d.mirror || !d.claimVerifier) throw new Error('run `npm run deploy:l1 -w @zkdb/dashboard` first');

const acct = (k: string) => privateKeyToAccount(k as Hex);
const wallet = (a: PrivateKeyAccount) => createWalletClient({ chain: zkdbL1, transport: http(L1.rpcUrl), account: a });

function memberKey(name: string): PrivateKeyAccount {
  if (process.env[name]) return acct(process.env[name]!);
  const k = generatePrivateKey();
  appendFileSync(MEMBERS, `${name}=${k}\n`, { mode: 0o600 });
  process.env[name] = k;
  return acct(k);
}

const admin = acct(process.env.DEPLOYER_KEY!);
const claimRelayer = acct(process.env.RELAYER_KEY!);
const outsider = acct(readFileSync(process.env.OUTSIDER_KEY_FILE ?? `${homedir()}/.zkdb/outsider.key`, 'utf8').trim());

interface Step { step: string; who: string; address: Address; result: 'ok' | 'refused'; tx?: Hex; detail: string }
const steps: Step[] = [];
const log = (s: Step) => {
  steps.push(s);
  console.log(`  ${s.result === 'ok' ? 'ok     ' : 'REFUSED'} ${s.step.padEnd(58)} ${s.tx ?? s.detail}`);
};

const roles = async (a: Address) => {
  const [tx, deploy] = await Promise.all([
    l1.readContract({ address: TX_ALLOW_LIST, abi: allowListAbi, functionName: 'readAllowList', args: [a] }),
    l1.readContract({ address: DEPLOYER_ALLOW_LIST, abi: allowListAbi, functionName: 'readAllowList', args: [a] }),
  ]);
  return { tx: ROLE[Number(tx)], deploy: ROLE[Number(deploy)] };
};

/** The node's own words, without viem's request dump. */
const reason = (e: unknown) => {
  const err = e as { details?: string; shortMessage?: string; message?: string };
  return (err.details ?? err.shortMessage ?? err.message ?? String(e)).split('\n')[0];
};

/** Signs a transaction locally (fixed gas, no estimate) and hands it to the L1, so the refusal comes from the node's mempool. */
async function sendRaw(a: PrivateKeyAccount, tx: { to?: Address; data?: Hex; value?: bigint; gas: bigint }): Promise<{ hash?: Hex; error?: string }> {
  const nonce = await l1.getTransactionCount({ address: a.address, blockTag: 'pending' });
  const signed = await a.signTransaction({ chainId: L1.chainId, type: 'eip1559', nonce, maxFeePerGas: parseGwei('25'), maxPriorityFeePerGas: parseGwei('1'), ...tx });
  try {
    const hash = await l1.sendRawTransaction({ serializedTransaction: signed });
    return { hash };
  } catch (e) {
    return { error: reason(e) };
  }
}

/** A deploy as the node judges it before mining (eth_estimateGas): the deployer allow-list answers here. */
async function tryDeploy(a: PrivateKeyAccount, data: Hex): Promise<string | undefined> {
  try {
    await l1.estimateGas({ account: a.address, data });
    return undefined;
  } catch (e) {
    return reason(e);
  }
}

async function write(a: PrivateKeyAccount, list: Address, functionName: 'setEnabled' | 'setNone', target: Address) {
  const hash = await wallet(a).writeContract({ address: list, abi: allowListAbi, functionName, args: [target] });
  const r = await l1.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
  return hash;
}

async function main() {
  console.log(`Permissions on ${L1.name} (chainId ${await l1.getChainId()}), block ${await l1.getBlockNumber()}\n`);
  const gate = artifact('PointsGate');
  const gateDeploy = encodeDeployData({ abi: gate.abi, bytecode: gate.bytecode, args: [d.mirror!, d.claimVerifier!] });

  // 1. Outsider.
  const o = await roles(outsider.address);
  console.log(`  outsider ${outsider.address}: tx ${o.tx}, deploy ${o.deploy}, holds ${formatEther(await l1.getBalance({ address: outsider.address }))} ZKD`);
  const t1 = await sendRaw(outsider, { to: outsider.address, value: 1n, gas: 21_000n });
  log({ step: 'outsider sends 1 wei of ZKD', who: 'outsider', address: outsider.address, result: t1.hash ? 'ok' : 'refused', tx: t1.hash, detail: t1.error ?? '' });
  const t2 = await sendRaw(outsider, { data: gateDeploy, gas: 3_000_000n });
  log({ step: 'outsider deploys a PointsGate', who: 'outsider', address: outsider.address, result: t2.hash ? 'ok' : 'refused', tx: t2.hash, detail: t2.error ?? '' });

  // 2. Allowed to send, not to deploy.
  const c = await roles(claimRelayer.address);
  console.log(`  claim relayer ${claimRelayer.address}: tx ${c.tx}, deploy ${c.deploy}`);
  const t3 = await tryDeploy(claimRelayer, gateDeploy);
  log({ step: 'claim relayer (tx-enabled) deploys a PointsGate', who: 'claim relayer', address: claimRelayer.address, result: t3 ? 'refused' : 'ok', detail: t3 ?? 'accepted' });

  // 3. New members, funded, not yet enabled.
  const a = await roles(admin.address);
  console.log(`  school admin ${admin.address}: tx ${a.tx}, deploy ${a.deploy}`);
  const newDeployer = memberKey('NEW_SCHOOL_DEPLOYER_KEY');
  const newRelayer = memberKey('NEW_CLAIM_RELAYER_KEY');
  for (const [who, m] of [['new school deployer', newDeployer], ['new claim relayer', newRelayer]] as const) {
    if ((await l1.getBalance({ address: m.address })) < parseEther('5')) {
      const hash = await wallet(admin).sendTransaction({ to: m.address, value: parseEther('20') });
      await l1.waitForTransactionReceipt({ hash });
      log({ step: `admin sends 20 ZKD to the ${who}`, who: 'school admin', address: admin.address, result: 'ok', tx: hash, detail: m.address });
    }
  }
  if ((await roles(newRelayer.address)).tx === 'none') {
    const t = await sendRaw(newRelayer, { to: newRelayer.address, value: 1n, gas: 21_000n });
    log({ step: 'new claim relayer sends before it is enabled', who: 'new claim relayer', address: newRelayer.address, result: t.hash ? 'ok' : 'refused', tx: t.hash, detail: t.error ?? '' });
  }

  // 4. The admin enables them.
  const enable: [string, PrivateKeyAccount, Address, string][] = [
    ['new school deployer', newDeployer, TX_ALLOW_LIST, 'TxAllowList'],
    ['new school deployer', newDeployer, DEPLOYER_ALLOW_LIST, 'ContractDeployerAllowList'],
    ['new claim relayer', newRelayer, TX_ALLOW_LIST, 'TxAllowList'],
  ];
  for (const [who, m, list, name] of enable) {
    const role = Number(await l1.readContract({ address: list, abi: allowListAbi, functionName: 'readAllowList', args: [m.address] }));
    if (role !== 0) continue;
    const hash = await write(admin, list, 'setEnabled', m.address);
    log({ step: `admin: ${name}.setEnabled(${who})`, who: 'school admin', address: admin.address, result: 'ok', tx: hash, detail: m.address });
  }
  const nd = await roles(newDeployer.address);
  const nr = await roles(newRelayer.address);
  console.log(`  new school deployer ${newDeployer.address}: tx ${nd.tx}, deploy ${nd.deploy}`);
  console.log(`  new claim relayer   ${newRelayer.address}: tx ${nr.tx}, deploy ${nr.deploy}`);

  // 5. A product action by the new deployer: a perk gate for a second club, on the same mirrored root.
  const dw = wallet(newDeployer);
  const gh = await dw.deployContract({ abi: gate.abi, bytecode: gate.bytecode, args: [d.mirror!, d.claimVerifier!] });
  const gr = await l1.waitForTransactionReceipt({ hash: gh });
  if (gr.status !== 'success') throw new Error(`gate deploy reverted ${gh}`);
  log({ step: 'new school deployer deploys a PointsGate (club #2)', who: 'new school deployer', address: newDeployer.address, result: 'ok', tx: gh, detail: gr.contractAddress! });
  const ph = await dw.writeContract({ address: gr.contractAddress!, abi: gate.abi, functionName: 'addPerk', args: [PROGRAM.table, 300n, 'Club #2 lab access'] } as never);
  await l1.waitForTransactionReceipt({ hash: ph });
  log({ step: 'new school deployer adds a perk (at least 300 points)', who: 'new school deployer', address: newDeployer.address, result: 'ok', tx: ph, detail: '' });

  // 6. The new relayer can send now.
  const rh = await wallet(newRelayer).sendTransaction({ to: newRelayer.address, value: 0n });
  await l1.waitForTransactionReceipt({ hash: rh });
  log({ step: 'new claim relayer sends a transaction', who: 'new claim relayer', address: newRelayer.address, result: 'ok', tx: rh, detail: '' });

  // 7. Offboard the new deployer from deploying.
  const off = await write(admin, DEPLOYER_ALLOW_LIST, 'setNone', newDeployer.address);
  log({ step: 'admin: ContractDeployerAllowList.setNone(new school deployer)', who: 'school admin', address: admin.address, result: 'ok', tx: off, detail: newDeployer.address });
  const t7 = await tryDeploy(newDeployer, gateDeploy);
  log({ step: 'new school deployer deploys again', who: 'new school deployer', address: newDeployer.address, result: t7 ? 'refused' : 'ok', detail: t7 ?? 'accepted' });
  const after = await roles(newDeployer.address);
  console.log(`  new school deployer now: tx ${after.tx}, deploy ${after.deploy}`);

  const record = {
    at: new Date().toISOString(),
    chainId: L1.chainId,
    members: { admin: admin.address, claimRelayer: claimRelayer.address, outsider: outsider.address, newDeployer: newDeployer.address, newRelayer: newRelayer.address, clubGate: gr.contractAddress },
    steps,
  };
  writeFileSync(pathOf('../../../docs/l1-permissions.json'), JSON.stringify(record, null, 2) + '\n');
  writeFileSync(pathOf('../../../docs/l1-permissions.md'), render(record));
  console.log('\nWrote docs/l1-permissions.md and docs/l1-permissions.json');
}

function render(r: { at: string; members: Record<string, string | null | undefined>; steps: Step[] }) {
  const rows = r.steps.map((s, i) => `| ${i + 1} | ${s.step} | \`${s.address.slice(0, 6)}…${s.address.slice(-4)}\` | ${s.result === 'ok' ? 'ok' : '**refused**'} | ${s.tx ? `\`${s.tx}\`` : s.detail.replace(/\|/g, '\\|')} |`);
  return [
    '# Who may write to the school L1',
    '',
    `Run on ${r.at.slice(0, 16).replace('T', ' ')} UTC by \`npm run perms:l1 -w @zkdb/dashboard\` against the zkdb L1 (chainId ${L1.chainId}). Why the L1 has these lists and how to check them: [l1/README.md](../l1/README.md). Raw record: [l1-permissions.json](l1-permissions.json).`,
    '',
    `School admin \`${r.members.admin}\` (admin on both lists). Outsider \`${r.members.outsider}\` (holds 1 ZKD, on neither list). New school deployer \`${r.members.newDeployer}\` and new claim relayer \`${r.members.newRelayer}\`, made by this run. The new deployer's perk gate for a second club: \`${r.members.clubGate}\`.`,
    '',
    'Refusals come from the L1 node. A transfer or deploy from a wallet not on the TxAllowList is rejected when it reaches the mempool, so it never gets a hash. A deploy from a wallet that may send but not deploy is rejected before mining (the node\'s `eth_estimateGas` answer is shown).',
    '',
    '| # | Step | Signer | Result | L1 tx or node error |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    'The new claim relayer then forwarded a real zero-knowledge claim to Fuji over ICM: see the latest run in [l1-run.md](l1-run.md).',
    '',
  ].join('\n');
}

if (!existsSync(MEMBERS)) writeFileSync(MEMBERS, '# New L1 members made by scripts/perms-l1.ts. Test keys, gitignored.\n', { mode: 0o600 });
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
