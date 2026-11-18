/**
 * Pre-record check for the Fuji demo: is everything a one-shot beat needs in place?
 *
 *   npm run prerecord -w @zkdb/dashboard              # check only; exit code 1 if something is missing
 *   npm run prerecord -w @zkdb/dashboard -- --restage # also fix what it can: decline stray proposals, prove a
 *                                                     # non-empty queue, add a fresh qualifying card if fewer than
 *                                                     # two demo cards can still claim the first perk or no
 *                                                     # card is left for the live correction
 *
 * Reads the public settings (.env.fuji), the test keys (.env.fuji.local) and the seeded card secrets
 * (.demo-cards.fuji.local). The last two never leave this machine.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, formatEther, http, parseEther, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildBatch, cardKey, claimNullifier, initHash, K, OPCODE, ZkDbState } from '@zkdb/core';
import { createReader, gateAbi, readConfig, relayAbi, zkdbAbi, type Snapshot } from '../src/chain';
import { newCardSecret } from '../src/pickup';
import { BALANCE_FIELD, CARD_FIELD, formatCard, KEY_FIELD, PROGRAM, REASONS } from '../src/points';
import type { DemoCard } from '../server/app';

const network = process.argv.find((a) => !a.startsWith('-') && !a.includes('/')) ?? 'fuji';
const restage = process.argv.includes('--restage');
const pathOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
for (const file of [`../.env.${network}`, `../.env.${network}.local`]) {
  try { process.loadEnvFile(pathOf(file)); } catch { /* optional */ }
}
const cardsFile = pathOf(`../.demo-cards.${network}.local`);
const MIN_GAS = parseEther('0.002');
const WANT_CLAIMABLE = 2;

const cfg = readConfig(process.env);
if (!cfg || !cfg.gate) throw new Error(`packages/dashboard/.env.${network} has no deployment. Run deploy:${network} first.`);
const transport = http(cfg.rpcUrl, { retryCount: 6, retryDelay: 1500 });
const pub = createPublicClient({ transport, pollingInterval: 500 });
const key = (name: string) => (/^0x[0-9a-fA-F]{64}$/.test(process.env[name] ?? '') ? privateKeyToAccount(process.env[name] as Hex) : undefined);
const roles = { Owner: key('DEPLOYER_KEY'), Treasurer: key('TREASURER_KEY'), Auditor: key('AUDITOR_KEY'), Relayer: key('RELAYER_KEY') };
const problems: string[] = [];
const line = (ok: boolean, text: string) => { console.log(`${ok ? 'ok  ' : 'FIX '} ${text}`); if (!ok) problems.push(text); };
const readCards = (): DemoCard[] => { try { return JSON.parse(readFileSync(cardsFile, 'utf8')); } catch { return []; } };

async function send(role: 'Treasurer' | 'Auditor', to: Address, abi: readonly unknown[], functionName: string, args: unknown[]) {
  const account = roles[role];
  if (!account) throw new Error(`${role} key missing`);
  const wallet = createWalletClient({ account, transport });
  const hash = await wallet.writeContract({ address: to, abi, functionName, args, chain: null } as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
  console.log(`      sent ${functionName}  ${cfg!.explorer ?? ''}/tx/${hash}`);
}

/** Proves whatever is queued, submits the proof and relays the root, the way the Prove button does. */
async function proveQueue(s: Snapshot) {
  const { loadCircuit, proveBatch } = await import('@zkdb/core/prover');
  const ops = [...s.ops].sort((a, b) => a.id - b.id);
  const state = new ZkDbState();
  for (const o of ops.slice(0, s.head)) state.applyOp(o.op);
  const pending = ops.slice(s.head, s.head + K).map((o) => o.op);
  const batch = buildBatch(state, pending);
  const { proof } = await proveBatch(batch, loadCircuit());
  await send('Treasurer', cfg!.address, zkdbAbi, 'submitBatch', [toHex(proof), toHex(batch.newRoot, { size: 32 }), batch.ok, pending]);
  if (cfg!.icm) await send('Treasurer', cfg!.icm.relay, relayAbi, 'relay', []);
}

async function claimable(s: Snapshot, cards: DemoCard[]) {
  const perk = s.perks[0];
  const out: { card: bigint; balance: bigint; state: string }[] = [];
  for (const c of cards) {
    const secret = BigInt(c.secret);
    const row = s.rows.find((r) => r.table === PROGRAM.table && r.fields[KEY_FIELD] === cardKey(secret));
    if (!row) continue;
    const balance = row.fields[BALANCE_FIELD];
    const claimed = await pub.readContract({ address: cfg!.gate!, abi: gateAbi, functionName: 'claimed', args: [BigInt(perk.id), toHex(claimNullifier(secret, BigInt(perk.id)), { size: 32 })] });
    out.push({ card: row.fields[CARD_FIELD], balance, state: claimed ? 'claimed' : balance >= perk.minPoints ? 'CAN CLAIM' : 'too few points' });
  }
  return out;
}

type CardState = { card: bigint; balance: bigint; state: string };
const MIN_CORRECT = 300n;
/** Cards that can still claim the first perk, richest first. */
const canClaim = (list: CardState[]) => list.filter((c) => c.state === 'CAN CLAIM').sort((a, b) => (b.balance > a.balance ? 1 : -1));
/**
 * The card for act 1's live correction. A card that has already claimed is ideal (the correction cannot cost a claim);
 * otherwise a claimable card beyond the take and the spare. #0042 and #0333 carry other beats.
 */
function correctionCard(list: CardState[]) {
  const free = (c: CardState) => c.balance >= MIN_CORRECT && c.card !== 42n && c.card !== 333n;
  return list.find((c) => c.state === 'claimed' && free(c)) ?? canClaim(list).slice(WANT_CLAIMABLE).find(free);
}

async function main() {
  await initHash();
  console.log(`Pre-record check, ${cfg!.network ?? network}, ZkDB ${cfg!.address}\n`);

  for (const [name, account] of Object.entries(roles)) {
    if (!account) { line(false, `${name} key is missing from .env.${network}.local`); continue; }
    const balance = await pub.getBalance({ address: account.address });
    line(balance >= MIN_GAS, `${name} ${account.address} has ${formatEther(balance)} ${cfg!.currency ?? ''} for gas (needs ${formatEther(MIN_GAS)})`);
  }

  let s = await createReader(cfg!).snapshot();
  line(s.matches, `replay matches the contract root (${s.head} changes, ${s.batchCount} proofs)`);

  const open = s.proposals.filter((p) => p.status === 'open');
  if (open.length && restage) {
    for (const p of open) await send('Auditor', cfg!.address, zkdbAbi, 'declineChange', [BigInt(p.id), p.op]);
    s = await createReader(cfg!).snapshot();
  }
  line(s.proposals.every((p) => p.status !== 'open'), `no proposal is waiting for the auditor (${s.proposals.filter((p) => p.status === 'open').length} open)`);

  if (s.pending > 0 && restage) { await proveQueue(s); s = await createReader(cfg!).snapshot(); }
  line(s.pending === 0, `the queue is empty (${s.pending} waiting)`);

  if (cfg!.icm) {
    const last = Number(await pub.readContract({ address: cfg!.icm.relay, abi: relayAbi, functionName: 'lastRelayedBatch' }));
    line(last === s.batchCount, `the latest root (#${s.batchCount}) was sent over ICM (last sent #${last})`);
  }

  let cards = readCards();
  line(cards.length > 0, `${cards.length} demo card secrets in ${cardsFile.split('/').pop()}`);
  let list = await claimable(s, cards);
  // Two passes at most: one fresh member can fill either gap (a card to claim with, or a card to correct).
  for (let pass = 0; pass < 2 && restage && (canClaim(list).length < WANT_CLAIMABLE || !correctionCard(list)); pass++) {
    // A fresh member: a new card number, a secret made here, 600 points, proven.
    const next = s.rows.filter((r) => r.table === PROGRAM.table).reduce((m, r) => (r.fields[CARD_FIELD] > m ? r.fields[CARD_FIELD] : m), 0n) + 1n;
    const secret = newCardSecret();
    await send('Treasurer', cfg!.address, zkdbAbi, 'insert', [PROGRAM.table, [next, 0n, cardKey(secret), 0n, 0n, 0n]]);
    await send('Treasurer', cfg!.address, zkdbAbi, 'enqueue', [Number(OPCODE.ADD), BigInt(s.nextRowId), BigInt(BALANCE_FIELD), [600n, REASONS.volunteer.code, 0n, 0n, 0n, 0n]]);
    cards = [...cards, { card: next.toString(), secret: toHex(secret, { size: 32 }) }];
    writeFileSync(cardsFile, JSON.stringify(cards, null, 1) + '\n');
    await proveQueue(await createReader(cfg!).snapshot());
    s = await createReader(cfg!).snapshot();
    list = await claimable(s, cards);
  }
  const perk = s.perks[0];
  console.log(`\nDemo cards and "${perk.name}" (needs ${perk.minPoints}):`);
  for (const c of list) console.log(`      ${formatCard(c.card)}  ${String(c.balance).padStart(6)} points  ${c.state}`);
  // The richest card claims and the poorest is refused, so the live correction (on another card) changes neither.
  const can = canClaim(list);
  line(can.length >= WANT_CLAIMABLE, `${can.length} demo cards can still claim it (want ${WANT_CLAIMABLE}: one for the take, one spare)`);
  const refused = list.filter((c) => c.state === 'too few points').sort((a, b) => (a.balance > b.balance ? 1 : -1))[0];
  line(!!refused, `a demo card with too few points exists for the refused claim${refused ? ` (${formatCard(refused.card)})` : ''}`);
  const correct = correctionCard(list);
  line(!!correct, `a card with at least ${MIN_CORRECT} points is free for the live correction${correct ? ` (${formatCard(correct.card)}, ${correct.balance} points)` : ''}`);

  if (problems.length === 0) {
    const summary = `ready ${new Date().toISOString()}: correct ${formatCard(correct!.card)}, claim with ${formatCard(can[0].card)}, refused claim with ${formatCard(refused!.card)}`;
    console.log(`\nREADY. For the take: correct ${formatCard(correct!.card)} (${correct!.balance} → ${correct!.balance / 10n}); successful claim with ${formatCard(can[0].card)}; refused claim with ${formatCard(refused!.card)}.`);
    console.log(`Start the dashboard with:  ZKDB_DEMO=1 npm run ${network} -w @zkdb/dashboard`);
    appendFileSync(pathOf(`../.prerecord.${network}.local`), summary + '\n');
  } else {
    console.log(`\nNOT READY: ${problems.length} item(s) above.${restage ? '' : ' Run again with -- --restage to fix what the script can.'}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
