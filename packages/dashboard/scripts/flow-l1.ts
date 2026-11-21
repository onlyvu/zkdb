/**
 * Both ICM directions between the Fuji C-Chain and the school L1 (zkdb, chainId 510102), end to end, and writes
 * every transaction to docs/l1-run.md (runs kept in docs/l1-runs.json).
 *
 *   npm run flow:l1 -w @zkdb/dashboard            (after deploy:l1; run flow:fuji first to have a new root to send)
 *
 *   1. Fuji: RootRelay reads the root ZkDB holds (accepted with a batch proof) and sends it to the L1 over ICM
 *   2. L1: the team relayer delivers it; Teleporter runs RootMirror.receiveTeleporterMessage (MessageExecuted)
 *   3. a member proves "a card in this root has at least N points" against the mirrored root (card hidden)
 *   4. L1: the claim relayer sends it to ClaimForwarder; PointsGate on the L1 checks the proof and spends the
 *      nullifier; ClaimForwarder sends the receipt (perk id, nullifier, pickup hash, root) to Fuji over ICM
 *   5. Fuji: the relayer delivers it; ClaimRegistry records it (MessageExecuted)
 *   6. Fuji: a sponsor desk on the C-Chain redeems the perk once, against the member's one-time pickup code
 *
 * --render rewrites docs/l1-run.md from docs/l1-runs.json and sends nothing.
 * Options: --relayer <ENV_NAME> picks the L1 claim relayer key (default RELAYER_KEY; e.g. NEW_CLAIM_RELAYER_KEY, enabled
 * by perms:l1); --card <number> --perk <id> to pick the claim; by default the newest flow card that has not claimed a
 * perk on either gate, preferring a perk it has not claimed on Fuji (a nullifier is per card and perk id).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeEventLog, toHex, type Abi, type Address, type Hex, type TransactionReceipt } from 'viem';
import { buildClaim, claimNullifier, initHash, ZkDbState } from '@zkdb/core';
import { createReader, gateAbi, readConfig } from '../src/chain';
import { newPickupCode, pickupHash } from '../src/pickup';
import { formatCard, PROGRAM } from '../src/points';
import {
  EXPLORER, forwarderAbi, fuji, fujiWallet, L1, l1, l1Wallet, mirrorAbi, pathOf, readDeployment, registryAbi, relayAbi,
  waitForDelivery, zkdbReadAbi, type Delivery,
} from './l1';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const cfg = readConfig(process.env);
if (!cfg?.gate) throw new Error('packages/dashboard/.env.fuji has no full deployment.');
const d = readDeployment();
if (!d.relay || !d.registry || !d.mirror || !d.gate || !d.forwarder) throw new Error('run `npm run deploy:l1 -w @zkdb/dashboard` first');

interface Tx { chain: 'fuji' | 'l1'; what: string; hash: Hex; gas: string; ms: number }
const txs: Tx[] = [];
const fuWallet = fujiWallet('TREASURER_KEY');
const claimRelayer = l1Wallet(arg('relayer') ?? 'RELAYER_KEY');

async function send(chain: 'fuji' | 'l1', address: Address, abi: Abi, functionName: string, args: unknown[], what: string): Promise<TransactionReceipt> {
  const w = chain === 'fuji' ? fuWallet : claimRelayer;
  const client = chain === 'fuji' ? fuji : l1;
  const hash = await w.writeContract({ address, abi, functionName, args } as never);
  const t0 = performance.now();
  const r = await client.waitForTransactionReceipt({ hash });
  const ms = Math.round(performance.now() - t0);
  if (r.status !== 'success') throw new Error(`${what} reverted: ${hash}`);
  txs.push({ chain, what, hash, gas: r.gasUsed.toString(), ms });
  console.log(`  ${chain.padEnd(4)} ${what.padEnd(52)} gas ${String(r.gasUsed).padStart(8)}  ${chain === 'fuji' ? `${EXPLORER}/tx/${hash}` : hash}`);
  return r;
}

function eventArgs(r: TransactionReceipt, abi: Abi, eventName: string): Record<string, unknown> {
  for (const log of r.logs) {
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics }) as unknown as { eventName: string; args: Record<string, unknown> };
      if (ev.eventName === eventName) return ev.args;
    } catch { /* another contract's event */ }
  }
  throw new Error(`no ${eventName} in ${r.transactionHash}`);
}

function cards(): { card: bigint; secret: bigint }[] {
  const out: { card: bigint; secret: bigint }[] = [];
  try {
    const lines = readFileSync(pathOf('../.flow-cards.fuji.local'), 'utf8').trim().split('\n').filter(Boolean).reverse();
    for (const l of lines) { const c = JSON.parse(l); out.push({ card: BigInt(c.card), secret: BigInt(c.secret) }); }
  } catch { /* none yet */ }
  try {
    for (const c of JSON.parse(readFileSync(pathOf('../.demo-cards.fuji.local'), 'utf8'))) out.push({ card: BigInt(c.card), secret: BigInt(c.secret) });
  } catch { /* none */ }
  return out;
}

async function main() {
  if (process.argv.includes('--render')) {
    // Rewrite docs/l1-run.md from docs/l1-runs.json without sending anything.
    writeFileSync(pathOf('../../../docs/l1-run.md'), renderDoc(JSON.parse(readFileSync(pathOf('../../../docs/l1-runs.json'), 'utf8'))));
    return;
  }
  await initHash();
  const started = new Date();
  console.log(`ICM both ways between Fuji and ${L1.name} (chainId ${await l1.getChainId()})\n`);

  // 1-2. The root, C-Chain → L1.
  const [batchCount, lastRelayed] = await Promise.all([
    fuji.readContract({ address: cfg!.address, abi: zkdbReadAbi, functionName: 'batchCount' }),
    fuji.readContract({ address: d.relay!, abi: relayAbi, functionName: 'lastRelayedBatch' }),
  ]);
  let rootLeg: { batchNo: number; root: Hex; messageId: Hex; delivery: Delivery } | undefined;
  if (batchCount > lastRelayed) {
    const l1From = await l1.getBlockNumber();
    const r = await send('fuji', d.relay!, relayAbi, 'relay', [], `send root #${batchCount} to ${L1.name} over ICM`);
    const ev = eventArgs(r, relayAbi, 'RootRelayed');
    const messageId = ev.messageID as Hex;
    const delivery = await waitForDelivery(l1, messageId, l1From);
    console.log(`  l1   delivered after ${delivery.ms} ms: ${delivery.status}  ${delivery.tx ?? ''}`);
    if (delivery.status !== 'executed') throw new Error(`root message ${messageId} on the L1: ${delivery.status}`);
    rootLeg = { batchNo: Number(ev.batchNo), root: ev.root as Hex, messageId, delivery };
  } else {
    console.log(`  root #${batchCount} was already sent to the L1; run flow:fuji first for a new one`);
  }
  const [mRoot, mBatch, dbRoot] = await Promise.all([
    l1.readContract({ address: d.mirror!, abi: mirrorAbi, functionName: 'root' }),
    l1.readContract({ address: d.mirror!, abi: mirrorAbi, functionName: 'batchNo' }),
    fuji.readContract({ address: cfg!.address, abi: zkdbReadAbi, functionName: 'root' }),
  ]);
  console.log(`  RootMirror on the L1: batch #${mBatch} ${mRoot} (${mRoot === dbRoot ? 'same as' : 'DIFFERENT from'} ZkDB.root() on Fuji)`);
  if (mRoot !== dbRoot) throw new Error('the mirror does not hold the current root yet');

  // 3. Rebuild the ledger from Fuji chain data, as the member's browser does, and check it gives the mirrored root.
  const s = await createReader(cfg!).snapshot();
  const state = new ZkDbState();
  for (const o of [...s.ops].sort((a, b) => a.id - b.id).slice(0, s.head)) state.applyOp(o.op);
  if (toHex(state.root, { size: 32 }) !== mRoot) throw new Error('replayed root differs from the mirrored root');

  const gateL1 = { address: d.gate!, abi: gateAbi } as const;
  const perkCount = Number(await l1.readContract({ ...gateL1, functionName: 'perkCount' }));
  const perks = await Promise.all(Array.from({ length: perkCount }, async (_, id) => ({ id: BigInt(id), ...(await l1.readContract({ ...gateL1, functionName: 'perk', args: [BigInt(id)] })) })));
  const wantCard = arg('card') ? BigInt(arg('card')!) : undefined;
  const wantPerk = arg('perk') ? BigInt(arg('perk')!) : undefined;
  let pick: { card: bigint; secret: bigint; perk: (typeof perks)[number]; claim: Extract<ReturnType<typeof buildClaim>, { ok: true }> } | undefined;
  const code = newPickupCode();
  outer: for (const pass of ['fresh', 'any'] as const) {
    for (const c of cards()) {
      if (wantCard !== undefined && c.card !== wantCard) continue;
      for (const p of [...perks].reverse()) {
        if (wantPerk !== undefined && p.id !== wantPerk) continue;
        const nullifier = toHex(claimNullifier(c.secret, p.id), { size: 32 });
        if (await l1.readContract({ ...gateL1, functionName: 'claimed', args: [p.id, nullifier] })) continue;
        if (pass === 'fresh' && (await fuji.readContract({ address: cfg!.gate!, abi: gateAbi, functionName: 'claimed', args: [p.id, nullifier] }))) continue;
        const claim = buildClaim(state, PROGRAM.table, { id: p.id, minPoints: p.minPoints }, c.secret, pickupHash(code));
        if (claim.ok) { pick = { ...c, perk: p, claim }; break outer; }
      }
    }
  }
  if (!pick) throw new Error('no card with an unclaimed perk on the L1 gate and enough points');
  console.log(`  claim: ${formatCard(pick.card)} proves "at least ${pick.perk.minPoints} points" for L1 perk #${pick.perk.id} "${pick.perk.name}" (the card number stays on this machine)`);
  const { loadClaimCircuit } = await import('@zkdb/core/prover');
  const { proveClaim, verifyClaim } = await import('@zkdb/core/claim-prover');
  const circuit = loadClaimCircuit();
  const t0 = performance.now();
  const proof = await proveClaim(pick.claim.input, circuit);
  const provingMs = Math.round(performance.now() - t0);
  if (!(await verifyClaim(proof, circuit))) throw new Error('claim proof did not verify locally');
  console.log(`  proven in ${(provingMs / 1000).toFixed(1)} s`);

  // 4-5. The receipt, L1 → C-Chain.
  const nullifier = toHex(pick.claim.input.nullifier, { size: 32 });
  const pickup = toHex(pick.claim.input.pickup, { size: 32 });
  const fujiFrom = await fuji.getBlockNumber();
  const r = await send('l1', d.forwarder!, forwarderAbi, 'claimAndForward', [toHex(proof.proof), pick.perk.id, nullifier, pickup], `claim perk #${pick.perk.id} on the L1 and send the receipt`);
  const claimMessageId = eventArgs(r, forwarderAbi, 'ClaimForwarded').messageID as Hex;
  const back = await waitForDelivery(fuji, claimMessageId, fujiFrom > 5n ? fujiFrom - 5n : 0n);
  console.log(`  fuji delivered after ${back.ms} ms: ${back.status}  ${back.tx ? `${EXPLORER}/tx/${back.tx}` : ''}`);
  if (back.status !== 'executed') throw new Error(`claim receipt ${claimMessageId} on Fuji: ${back.status}`);
  const recorded = await fuji.readContract({ address: d.registry!, abi: registryAbi, functionName: 'recorded', args: [pick.perk.id, nullifier] });
  if (!recorded) throw new Error('ClaimRegistry has no record of the nullifier');

  // 6. The perk handed out on the C-Chain.
  await send('fuji', d.registry!, registryAbi, 'redeem', [pick.perk.id, code], 'redeem the perk on Fuji with the pickup code');
  const count = await fuji.readContract({ address: d.registry!, abi: registryAbi, functionName: 'count' });
  console.log(`\nClaimRegistry on Fuji: ${count} receipt(s); nullifier ${nullifier} recorded for perk #${pick.perk.id}.`);

  // Record the run and rewrite docs/l1-run.md.
  const logPath = pathOf('../../../docs/l1-runs.json');
  const log = JSON.parse(readFileSync(logPath, 'utf8'));
  log.runs.push({
    at: started.toISOString(),
    root: rootLeg ? { batchNo: rootLeg.batchNo, root: rootLeg.root, messageId: rootLeg.messageId, sendTx: txs.find((t) => t.what.startsWith('send root'))!.hash, receiveTx: rootLeg.delivery.tx, status: rootLeg.delivery.status, deliveredMs: rootLeg.delivery.ms } : null,
    mirror: { batchNo: Number(mBatch), root: mRoot },
    claim: { relayer: claimRelayer.account.address, perkId: Number(pick.perk.id), perk: pick.perk.name, minPoints: Number(pick.perk.minPoints), provingMs, nullifier, messageId: claimMessageId, sendTx: r.transactionHash, receiveTx: back.tx, status: back.status, deliveredMs: back.ms },
    redeemTx: txs.at(-1)!.hash,
    registryCount: Number(count),
    txs,
  });
  writeFileSync(logPath, JSON.stringify(log, null, 2) + '\n');
  writeFileSync(pathOf('../../../docs/l1-run.md'), renderDoc(log));
  console.log('Wrote docs/l1-run.md and docs/l1-runs.json');
}

const fujiTx = (h?: string) => (h ? `[${h.slice(0, 10)}…](${EXPLORER}/tx/${h})` : '–');
const l1Tx = (h?: string) => (h ? `\`${h}\`` : '–');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderDoc(log: { deployment: any[]; runs: any[] }): string {
  const rows: string[] = [];
  log.runs.forEach((run, i) => {
    const n = i + 1;
    if (run.root) {
      rows.push(`| ${n} | Fuji → L1 | RootRelay sends root #${run.root.batchNo} | ${fujiTx(run.root.sendTx)} | Teleporter on the L1 runs RootMirror: **${run.root.status}**, within ${Math.max(1, Math.ceil(run.root.deliveredMs / 1000))} s of the send's receipt | ${l1Tx(run.root.receiveTx)} |`);
    }
    rows.push(`| ${n} | L1 → Fuji | Claim for perk #${run.claim.perkId} (at least ${run.claim.minPoints}) checked on the L1, receipt sent${run.claim.relayer ? ` (relayer \`${run.claim.relayer.slice(0, 6)}…\`)` : ''} | ${l1Tx(run.claim.sendTx)} | Teleporter on Fuji runs ClaimRegistry: **${run.claim.status}**, within ${Math.max(1, Math.ceil(run.claim.deliveredMs / 1000))} s of the send's receipt | ${fujiTx(run.claim.receiveTx)} |`);
    rows.push(`| ${n} | Fuji | Perk redeemed with the one-time code | ${fujiTx(run.redeemTx)} | ClaimRegistry: pickup marked redeemed | |`);
  });
  const dep = log.deployment.map((c) => `| ${c.chain === 'fuji' ? 'Fuji C-Chain' : 'zkdb L1'} | ${c.what} | ${c.chain === 'fuji' ? `[\`${c.address}\`](${EXPLORER}/address/${c.address})` : `\`${c.address}\``} | ${c.chain === 'fuji' ? fujiTx(c.tx) : l1Tx(c.tx)} | ${Number(c.gas).toLocaleString('en-US')} |`);
  const last = log.runs.at(-1);
  return [
    '# The school L1: ICM both ways, run',
    '',
    `zkDB's own Avalanche L1 \`zkdb\` (chainId ${L1.chainId}, token ${L1.token}, blockchainID \`${L1.blockchainIdCb58}\`, subnetID \`${L1.subnetId}\`) talks to the Fuji C-Chain over ICM (Teleporter) in both directions. Written by \`npm run flow:l1 -w @zkdb/dashboard\`; the raw record is [l1-runs.json](l1-runs.json).`,
    '',
    '- Fuji → L1: RootRelay reads the root ZkDB accepted with a batch proof and sends it; Teleporter on the L1 calls RootMirror, which takes it only from that relay on the C-Chain.',
    '- L1 → Fuji: a member\'s zero-knowledge claim ("a card in this root has at least N points") is checked on the L1 by PointsGate against RootMirror; ClaimForwarder sends a receipt (perk id, nullifier, pickup hash, threshold, root). Teleporter on Fuji calls ClaimRegistry, which takes it only from that forwarder on the zkdb L1 and records each nullifier once per perk. A C-Chain desk then redeems the perk once with the member\'s pickup code.',
    '',
    '## Why the school has its own L1',
    '',
    'The school runs the validator and the fee token (ZKD), so students never hold or pay AVAX: the claim relayer pays each claim in ZKD from the school\'s genesis allocation. Claims are checked and nullifiers spent on the school chain; only a 32-byte root comes in and a small receipt goes out over ICM, so any Avalanche chain can honour a claim without the club\'s data or trusting the club\'s server. In this deployment the ledger itself (ZkDB and its batch proofs) stays on the Fuji C-Chain as the public anchor; the L1 is where the root is used.',
    '',
    'Since 21 Nov 2026 01:26 VN (unix 1795199165) a network upgrade turns on two precompiles: only wallets on the TxAllowList may send transactions and only the school may deploy contracts ([l1/README.md](../l1/README.md), demo in [l1-permissions.md](l1-permissions.md)). Runs from 3 on are after the upgrade; in run 3 the claim was sent by a claim relayer the school admin enabled that night.',
    '',
    'Limits: one validator (a team laptop, proof of authority, the PoA owner is a team key), the L1 RPC is localhost only, the validator\'s P-Chain balance needs topping up about once a day, no fee manager or native minter. A nullifier is per card and perk id, not per gate, so a card that claims perk #0 on both the Fuji gate and the L1 gate shows the same nullifier on both (the card stays hidden; the two claims are linkable). The runs below use perk #1 on the L1 for cards that claimed perk #0 on Fuji.',
    '',
    '"Executed" means the receive transaction on the destination has Teleporter\'s `MessageExecuted` event for the message (not `MessageExecutionFailed`). Fuji transactions open on the explorer; L1 transactions are on the team validator\'s local RPC, and every L1 → Fuji receive on Fuji carries a Warp message signed by the L1 validator.',
    '',
    '## Runs',
    '',
    '| Run | Direction | What | Sent | Delivered | Received |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    last ? `After run ${log.runs.length} (${String(last.at).slice(0, 16).replace('T', ' ')} UTC): RootMirror holds batch #${last.mirror.batchNo}, the same root as \`ZkDB.root()\` on Fuji; ClaimRegistry on Fuji holds ${last.registryCount} receipt(s).` : '',
    '',
    '## Contracts',
    '',
    '| Chain | Contract | Address | Deploy tx | Gas |',
    '|---|---|---|---|---|',
    ...dep,
    '',
    'The ClaimVerifier on the L1 is the same UltraHonk verifier as on Fuji (15.7 KB of runtime code, 3.45M gas to deploy, under the L1\'s 30M block gas limit). A claim on the L1 costs about 1.0M gas, paid in ZKD by the claim relayer; the member pays nothing.',
    '',
    '## Check it',
    '',
    '```bash',
    `RPC=${process.env.VITE_RPC_URL}`,
    `cast call ${d.registry} "count()(uint256)" --rpc-url $RPC   # receipts recorded on Fuji`,
    `cast call ${d.relay} "lastRelayedBatch()(uint64)" --rpc-url $RPC`,
    '# the L1 is converted, with its validator (public P-Chain API):',
    `curl -s -X POST -H 'content-type:application/json' --data '{"jsonrpc":"2.0","id":1,"method":"platform.getSubnet","params":{"subnetID":"${L1.subnetId}"}}' https://api.avax-test.network/ext/bc/P`,
    '# on the validator machine only (RPC is localhost):',
    `cast call ${d.mirror} "batchNo()(uint64)" --rpc-url ${L1.rpcUrl}`,
    '```',
    '',
  ].join('\n');
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
