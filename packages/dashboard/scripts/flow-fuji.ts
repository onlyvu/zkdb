/**
 * Runs the main flow once, end to end, against the live Fuji deployment (not a fresh one) and writes every
 * transaction to docs/fuji-flow-run.md.
 *
 *   npm run flow:fuji -w @zkdb/dashboard
 *
 * One fresh member, so the seeded demo cards are left alone:
 *   1. the treasurer adds the member (enrol code = Poseidon2 hash of a secret made here) and awards 600 points
 *   2. a second award is typed as 450 instead of 45; the treasurer proposes the correction, the auditor co-signs
 *   3. a 100-point redemption, proposed and co-signed
 *   4. a 5,000-point redemption, proposed and co-signed: more than the balance, so the proof marks it rejected
 *   5. the batch is proven with bb.js (UltraHonk) and submitted; ZkDB stores the new root only if the verifier accepts
 *   6. RootRelay sends the new root to the Dispatch L1 over ICM; the script waits for Teleporter there to receive it
 *   7. the member proves "a card in this root has at least 500 points" (zero-knowledge, card hidden); the claim
 *      relayer sends it to PointsGate
 *   8. the perk is collected at the desk with the one-time pickup code
 *
 * Reads the public settings (.env.fuji) and the test keys (.env.fuji.local, gitignored). The new card's secret is
 * appended to .flow-cards.fuji.local (gitignored) and never printed.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, decodeEventLog, http, toHex, type Abi, type Address, type Hex, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalancheFuji } from 'viem/chains';
import { buildBatch, buildClaim, cardKey, initHash, K, OPCODE, ZkDbState, type Op } from '@zkdb/core';
import { createReader, gateAbi, readConfig, relayAbi, teleporterAbi, zkdbAbi } from '../src/chain';
import { newCardSecret, newPickupCode, pickupHash } from '../src/pickup';
import { BALANCE_FIELD, CARD_FIELD, formatCard, PROGRAM, REASONS } from '../src/points';
import { fileStore } from '../server/meta';
import { measurementsTable, PERKS, type Measured } from './seed';

const network = 'fuji';
const pathOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
for (const file of [`../.env.${network}`, `../.env.${network}.local`]) {
  try { process.loadEnvFile(pathOf(file)); } catch { /* optional */ }
}
const cfg = readConfig(process.env);
if (!cfg?.gate || !cfg.icm) throw new Error(`packages/dashboard/.env.${network} has no full deployment.`);
const explorer = cfg.explorer!;
const transport = http(cfg.rpcUrl, { retryCount: 6, retryDelay: 1500 });
const pub = createPublicClient({ chain: avalancheFuji, transport, pollingInterval: 250 });
const dispatch = createPublicClient({ transport: http(cfg.icm.rpcUrl, { retryCount: 4, retryDelay: 1500 }) });
const account = (name: string) => {
  const k = process.env[name];
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${name} missing from .env.${network}.local`);
  return privateKeyToAccount(k as Hex);
};
const wallets = {
  treasurer: createWalletClient({ chain: avalancheFuji, transport, account: account('TREASURER_KEY') }),
  auditor: createWalletClient({ chain: avalancheFuji, transport, account: account('AUDITOR_KEY') }),
  relayer: createWalletClient({ chain: avalancheFuji, transport, account: account('RELAYER_KEY') }),
};
type Who = keyof typeof wallets;
const targets = { db: { address: cfg.address, abi: zkdbAbi as Abi }, gate: { address: cfg.gate, abi: gateAbi as Abi }, relay: { address: cfg.icm.relay, abi: relayAbi as Abi } };

const measured: (Measured & { who: Who; block: bigint })[] = [];
async function send(who: Who, target: keyof typeof targets, functionName: string, args: unknown[], what: string, provingMs?: number): Promise<TransactionReceipt> {
  const hash = await wallets[who].writeContract({ ...targets[target], functionName, args } as never);
  const t0 = performance.now();
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const confirmMs = Math.round(performance.now() - t0);
  if (receipt.status !== 'success') throw new Error(`${what} reverted: ${explorer}/tx/${hash}`);
  measured.push({ what, who, hash, gasUsed: receipt.gasUsed, feeWei: receipt.gasUsed * receipt.effectiveGasPrice, confirmMs, provingMs, block: receipt.blockNumber });
  console.log(`  ${who.padEnd(9)} ${what.padEnd(46)} gas ${String(receipt.gasUsed).padStart(8)}  ${confirmMs} ms  ${explorer}/tx/${hash}`);
  return receipt;
}

function eventArg<T>(receipt: TransactionReceipt, abi: Abi, eventName: string, arg: string): T {
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics }) as unknown as { eventName: string; args: Record<string, unknown> };
      if (ev.eventName === eventName) return ev.args[arg] as T;
    } catch { /* another contract's event */ }
  }
  throw new Error(`no ${eventName} in ${receipt.transactionHash}`);
}

/** The treasurer proposes, the auditor puts the same op into the queue. */
async function coSigned(opcode: bigint, row: bigint, v: bigint[], what: string): Promise<Op> {
  const proposed = await send('treasurer', 'db', 'proposeChange', [Number(opcode), row, BigInt(BALANCE_FIELD), v], `propose ${what}`);
  const id = eventArg<bigint>(proposed, zkdbAbi, 'ChangeProposed', 'id');
  const op: Op = [opcode, row, BigInt(BALANCE_FIELD), ...v];
  await send('auditor', 'db', 'approveChange', [id, op], `co-sign proposal #${id} (auditor)`);
  return op;
}

async function main() {
  await initHash();
  const started = new Date();
  const before = await createReader(cfg!).snapshot();
  if (!before.matches) throw new Error('replay does not match the contract root; not running on top of it');
  if (before.pending > 0 || before.proposals.some((p) => p.status === 'open')) {
    throw new Error('queue or proposals not empty; run `npm run prerecord -w @zkdb/dashboard -- --restage` first');
  }
  console.log(`Main flow on ${cfg!.network}, ZkDB ${cfg!.address}: ${before.head} changes, ${before.batchCount} proofs before\n`);

  // 1. A new member: the secret is made here, the way the member's own browser makes it; only its hash goes on-chain.
  const card = before.rows.filter((r) => r.table === PROGRAM.table).reduce((m, r) => (r.fields[CARD_FIELD] > m ? r.fields[CARD_FIELD] : m), 0n) + 1n;
  const secret = newCardSecret();
  appendFileSync(pathOf(`../.flow-cards.${network}.local`), JSON.stringify({ card: card.toString(), secret: toHex(secret, { size: 32 }), at: started.toISOString() }) + '\n');
  const row = BigInt(before.nextRowId);
  const fields = [card, 0n, cardKey(secret), 0n, 0n, 0n];
  const queued: Op[] = [];
  await send('treasurer', 'db', 'insert', [PROGRAM.table, fields], `add member ${formatCard(card)} (enrol code only)`);
  queued.push([OPCODE.INSERT, row, PROGRAM.table, ...fields]);
  const award = async (points: bigint, reason: keyof typeof REASONS) => {
    const v = [points, REASONS[reason].code, 0n, 0n, 0n, 0n];
    await send('treasurer', 'db', 'enqueue', [Number(OPCODE.ADD), row, BigInt(BALANCE_FIELD), v], `award ${points} (${reason})`);
    queued.push([OPCODE.ADD, row, BigInt(BALANCE_FIELD), ...v]);
  };
  await award(600n, 'volunteer');
  // 2. A typo: 450 instead of 45. Fixing it overwrites the balance, so it needs the auditor.
  await award(450n, 'blood');
  queued.push(await coSigned(OPCODE.SET, row, [645n, REASONS.correction.code, 0n, 0n, 0n, 0n], 'correction 1,050 → 645'));
  // 3 and 4. Two redemptions; the second is larger than the balance.
  queued.push(await coSigned(OPCODE.SUB, row, [100n, REASONS.shirt.code, 0n, 0n, 0n, 0n], 'redeem 100 (shirt)'));
  queued.push(await coSigned(OPCODE.SUB, row, [5000n, REASONS.ticket.code, 0n, 0n, 0n, 0n], 'redeem 5,000 (more than the balance)'));

  // 5. Prove exactly what the chain has queued, the way the Prove button does.
  const s = await createReader(cfg!).snapshot();
  const ops = [...s.ops].sort((a, b) => a.id - b.id);
  const state = new ZkDbState();
  for (const o of ops.slice(0, s.head)) state.applyOp(o.op);
  const pending = ops.slice(s.head, s.head + K).map((o) => o.op);
  if (JSON.stringify(pending.map(String)) !== JSON.stringify(queued.map(String))) throw new Error('the queue holds ops this run did not send');
  const batch = buildBatch(state, pending);
  const { loadCircuit, loadClaimCircuit, proveBatch, verifyBatch } = await import('@zkdb/core/prover');
  const circuit = loadCircuit();
  const t0 = performance.now();
  const proof = await proveBatch(batch, circuit);
  const provingMs = Math.round(performance.now() - t0);
  if (!(await verifyBatch(proof, circuit))) throw new Error('proof did not verify locally');
  const rootHex = toHex(batch.newRoot, { size: 32 });
  const submitted = await send('treasurer', 'db', 'submitBatch', [toHex(proof.proof), rootHex, batch.ok, pending], `submit proof #${s.batchCount + 1} (${pending.length} changes)`, provingMs);
  const rejected = batch.ok.slice(0, pending.length).map((ok, i) => (ok ? null : i)).filter((i) => i !== null);
  fileStore(pathOf(`../server/proof-meta/${cfg!.address.toLowerCase()}.json`)).update(rootHex, {
    provingMs, provedAt: Date.now(), txHash: submitted.transactionHash.toLowerCase(), confirmMs: measured.at(-1)!.confirmMs,
  });

  // 6. Send the root over ICM and wait for Teleporter on Dispatch to receive it.
  const relayed = await send('treasurer', 'relay', 'relay', [], `send root #${s.batchCount + 1} to ${cfg!.icm!.name} over ICM`);
  const messageId = eventArg<Hex>(relayed, relayAbi, 'RootRelayed', 'messageID');
  const dispatchStart = await dispatch.getBlockNumber();
  let received = false;
  const waitStart = performance.now();
  for (let i = 0; i < 60 && !received; i++) {
    received = await dispatch.readContract({ address: cfg!.icm!.teleporter, abi: teleporterAbi, functionName: 'messageReceived', args: [messageId] });
    if (!received) await new Promise((r) => setTimeout(r, 2000));
  }
  const deliveredMs = Math.round(performance.now() - waitStart);
  let receiveTx: Hex | undefined;
  let executionFailed = false;
  if (received) {
    const head = await dispatch.getBlockNumber();
    const logs = await dispatch.request({
      method: 'eth_getLogs',
      // Filtered here rather than by a null topic, which this RPC does not honour.
      params: [{ address: cfg!.icm!.teleporter, fromBlock: toHex(dispatchStart > 20n ? dispatchStart - 20n : 0n), toBlock: toHex(head) }],
    }) as { transactionHash: Hex; topics: Hex[] }[];
    receiveTx = logs.find((l) => l.topics.some((t) => t.toLowerCase() === messageId.toLowerCase()))?.transactionHash;
    executionFailed = (await dispatch.readContract({ address: cfg!.icm!.teleporter, abi: teleporterAbi, functionName: 'receivedFailedMessageHashes', args: [messageId] })) !== `0x${'0'.repeat(64)}`;
  }
  console.log(`  ICM message ${messageId}: ${received ? `received on ${cfg!.icm!.name} after ${deliveredMs} ms${receiveTx ? `  ${cfg!.icm!.explorer}/tx/${receiveTx}` : ''}${executionFailed ? ' (stored, not executed: no RootMirror there)' : ''}` : 'not received within 2 minutes'}`);

  // 7. The member's claim: proven over the new root, card hidden, made out to a one-time pickup code.
  const perkId = 0n;
  const perk = { id: perkId, minPoints: PERKS[0].minPoints };
  const code = newPickupCode();
  const claim = buildClaim(state, PROGRAM.table, perk, secret, pickupHash(code));
  if (!claim.ok) throw new Error(`claim not possible: ${claim.reason}`);
  const { proveClaim, verifyClaim } = await import('@zkdb/core/claim-prover');
  const claimCircuit = loadClaimCircuit();
  const t1 = performance.now();
  const claimProof = await proveClaim(claim.input, claimCircuit);
  const claimMs = Math.round(performance.now() - t1);
  if (!(await verifyClaim(claimProof, claimCircuit))) throw new Error('claim proof did not verify locally');
  await send('relayer', 'gate', 'claim', [toHex(claimProof.proof), perkId, toHex(claim.input.nullifier, { size: 32 }), toHex(claim.input.pickup, { size: 32 })], `claim "${PERKS[0].name}" (ZK, card hidden)`, claimMs);
  // 8. At the desk.
  await send('treasurer', 'gate', 'collect', [perkId, code], 'collect the perk with the pickup code');

  const after = await createReader(cfg!).snapshot();
  const balance = after.rows.find((r) => r.rowId === Number(row))?.fields[BALANCE_FIELD];
  console.log(`\nAfter: ${after.head} changes, ${after.batchCount} proofs, replay ${after.matches ? 'matches' : 'DOES NOT match'} the root. ${formatCard(card)} has ${balance} points; rejected op index ${rejected.join(', ')}.`);

  const totalGas = measured.reduce((a, m) => a + m.gasUsed, 0n);
  const totalFee = measured.reduce((a, m) => a + m.feeWei, 0n);
  const link = (a: Address) => `[\`${a}\`](${explorer}/address/${a})`;
  const doc = [
    '# The main flow, run on Fuji',
    '',
    `Run on ${started.toISOString().replace('T', ' ').slice(0, 16)} UTC by \`npm run flow:fuji -w @zkdb/dashboard\` against the live deployment (ZkDB ${link(cfg!.address)}, PointsGate ${link(cfg!.gate!)}, RootRelay ${link(cfg!.icm!.relay)}). Three separate test accounts sign: the treasurer, the auditor and the claim relayer. Every row below is a Fuji transaction.`,
    '',
    `Card ${formatCard(card)} is a new member made for this run, so the seeded demo cards are untouched. Its secret was made on the machine running the script; only its Poseidon2 hash went on-chain.`,
    '',
    '| Step | What happened |',
    '|---|---|',
    `| Add and award | ${formatCard(card)} joins and gets 600 points, then 450 that should have been 45 |`,
    '| Correction | The treasurer proposes overwriting 1,050 with 645; it enters the queue only when the auditor co-signs |',
    '| Redemptions | 100 points (co-signed, accepted) and 5,000 points (co-signed, more than the balance) |',
    `| Proof #${s.batchCount + 1} | ${pending.length} changes proven in ${(provingMs / 1000).toFixed(1)} s with bb.js; the verifier contract accepted it and ZkDB stored the new root. The 5,000-point redemption is marked rejected in the proof (op index ${rejected.join(', ')}), so the balance stays ${balance} |`,
    `| ICM | RootRelay sent the root to ${cfg!.icm!.name}. ${received ? `Teleporter there had received it within ${Math.max(1, Math.ceil(deliveredMs / 1000))} s of the send's receipt${receiveTx ? ` ([receive tx on Dispatch](${cfg!.icm!.explorer}/tx/${receiveTx}))` : ''}${executionFailed ? ' and stored it unexecuted, because RootMirror is not deployed on Dispatch' : ''}` : 'Not received within two minutes of the send'}. Message ID \`${messageId}\` |`,
    `| Claim | Proven in ${(claimMs / 1000).toFixed(1)} s: "a card in this root has at least ${PERKS[0].minPoints} points". The relayer sent it; PointsGate checked it against \`ZkDB.root()\`. The transaction does not contain the card number |`,
    '| Collect | The perk is handed out once, against the one-time pickup code |',
    '',
    measurementsTable(measured, cfg!.currency ?? 'AVAX', explorer),
    '',
    `Signers: treasurer \`${wallets.treasurer.account.address}\`, auditor \`${wallets.auditor.account.address}\`, relayer \`${wallets.relayer.account.address}\`.`,
    '',
    `Total: ${measured.length} transactions, ${totalGas.toLocaleString('en-US')} gas, ${(Number(totalFee) / 1e18).toExponential(3)} AVAX on Fuji (160 wei per gas: 10 wei base fee plus a 150 wei tip). At the C-Chain mainnet base fee of 7.5 nAVAX the same gas would cost ${(Number(totalGas) * 7.5e-9).toFixed(4)} AVAX (calculated, not paid).`,
    '',
    `State after the run: ${after.head} changes, ${after.batchCount} proofs, and the dashboard's replay ${after.matches ? 'matches' : 'does not match'} the contract root. Check it yourself:`,
    '',
    '```bash',
    `RPC=${cfg!.rpcUrl}`,
    `cast call ${cfg!.address} "batchCount()(uint64)" --rpc-url $RPC   # ${after.batchCount} or more`,
    `cast call ${cfg!.gate} "perk(uint256)((uint256,uint64,uint64,string))" 0 --rpc-url $RPC`,
    '```',
    '',
  ].join('\n');
  writeFileSync(pathOf('../../../docs/fuji-flow-run.md'), doc);
  console.log('Wrote docs/fuji-flow-run.md');
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
