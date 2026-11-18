/**
 * Seeds a fresh ZkDB with the points-program story: a student volunteer club (CLB Tình nguyện) runs its
 * Mùa hè xanh 2026 campaign on table 1, with a treasurer and an auditor.
 *
 *   proof #1  eight members join and earn points (a full batch of 16). Each card's secret is made here, at random,
 *             the way a member's phone would make it; only its hash goes into the row
 *   proof #2  more awards, and two redemptions the auditor co-signed; one is larger than the balance and the proof
 *             rejects it
 *   claim     card #0889 proves "at least 500 points" to PointsGate without naming itself, and collects the perk
 *             with its pickup code
 *   proof #3  the treasurer proposes cutting #0042 from 1,250 to 250, the auditor co-signs, and a 500-point
 *             redemption that follows is rejected
 *
 * Every batch and the claim are proven for real (UltraHonk via bb.js) and verified on-chain. Where a RootRelay is
 * deployed, each new root is also sent to the other L1 over ICM. The card secrets are returned to the caller, which
 * keeps them in a local file that is never committed.
 * Used by scripts/demo.ts (local anvil) and scripts/deploy.ts (Fuji).
 */
import { buildBatch, buildClaim, cardKey, initHash, OPCODE, ZkDbState, type Op } from '@zkdb/core';
import { toHex as viemHex, type Address, type Hex, type TransactionReceipt } from 'viem';
import { BALANCE_FIELD, PROGRAM, REASONS } from '../src/points';
import { newCardSecret, newPickupCode, pickupHash } from '../src/pickup';
import type { DemoCard } from '../server/app';
import type { MetaStore } from '../server/meta';

export type Role = 'owner' | 'treasurer' | 'auditor' | 'relayer';
export type Target = 'db' | 'gate' | 'relay';
export interface Sent {
  receipt: TransactionReceipt;
  /** From broadcasting the transaction to holding its receipt. */
  confirmMs: number;
  /** From sending the transaction to the millisecond timestamp of the block that included it, where the chain has one. */
  inBlockMs?: number;
}
export type Send = (role: Role, target: Target, functionName: string, args: unknown[]) => Promise<Sent>;

export interface Measured {
  what: string;
  hash: Hex;
  gasUsed: bigint;
  feeWei: bigint;
  confirmMs: number;
  inBlockMs?: number;
  provingMs?: number;
}

const toHex = (x: bigint) => `0x${x.toString(16).padStart(64, '0')}` as Hex;
const bytes = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}` as Hex;

const CARDS = [42n, 107n, 215n, 333n, 518n, 604n, 731n, 889n];

/** Perks the gate offers on the points table. */
export const PERKS = [
  { minPoints: 500n, name: 'Priority event ticket' },
  { minPoints: 250n, name: 'Volunteer certificate' },
] as const;

type Step =
  | { kind: 'join'; card: bigint }
  | { kind: 'award' | 'redeem'; card: bigint; points: bigint; reason: keyof typeof REASONS }
  | { kind: 'correct'; card: bigint; points: bigint };

const BATCHES: Step[][] = [
  [
    ...CARDS.map((card) => ({ kind: 'join' as const, card })),
    { kind: 'award', card: 42n, points: 400n, reason: 'volunteer' },
    { kind: 'award', card: 107n, points: 300n, reason: 'volunteer' },
    { kind: 'award', card: 215n, points: 600n, reason: 'crew' },
    { kind: 'award', card: 333n, points: 150n, reason: 'workshop' },
    { kind: 'award', card: 518n, points: 250n, reason: 'blood' },
    { kind: 'award', card: 604n, points: 500n, reason: 'volunteer' },
    { kind: 'award', card: 731n, points: 700n, reason: 'crew' },
    { kind: 'award', card: 889n, points: 550n, reason: 'volunteer' },
  ],
  [
    { kind: 'award', card: 42n, points: 450n, reason: 'blood' },
    { kind: 'award', card: 42n, points: 400n, reason: 'volunteer' },
    { kind: 'award', card: 107n, points: 250n, reason: 'crew' },
    { kind: 'award', card: 518n, points: 300n, reason: 'volunteer' },
    { kind: 'redeem', card: 215n, points: 100n, reason: 'shirt' },
    { kind: 'redeem', card: 333n, points: 200n, reason: 'ticket' },
  ],
  [
    { kind: 'correct', card: 42n, points: 250n },
    { kind: 'redeem', card: 42n, points: 500n, reason: 'shirt' },
  ],
];
/** The claim is made on the root of this batch (index into BATCHES), by this card, for perk 0. */
const CLAIM = { afterBatch: 1, card: 889n, perk: 0 };

export interface SeedOptions {
  send: Send;
  owner: Address;
  treasurer: Address;
  auditor: Address;
  /** PointsGate is deployed: add the perks and make one claim. */
  gate?: boolean;
  /** RootRelay is deployed: send every new root over ICM. */
  relay?: boolean;
  meta?: MetaStore;
  log?: (line: string) => void;
}

/**
 * Runs the whole story against a freshly deployed contract (nextRowId must be 0). Returns every measured tx and the
 * secrets of the cards it created.
 */
export async function seedPoints({ send, treasurer, auditor, gate, relay, meta, log = console.log }: SeedOptions): Promise<{ measured: Measured[]; cards: DemoCard[] }> {
  await initHash();
  const { loadCircuit, loadClaimCircuit, proveBatch, verifyBatch } = await import('@zkdb/core/prover');
  const { proveClaim, verifyClaim } = await import('@zkdb/core/claim-prover');
  const circuit = loadCircuit();
  const measured: Measured[] = [];
  const record = (what: string, s: Sent, provingMs?: number) => {
    const m = {
      what,
      hash: s.receipt.transactionHash,
      gasUsed: s.receipt.gasUsed,
      feeWei: s.receipt.gasUsed * s.receipt.effectiveGasPrice,
      confirmMs: s.confirmMs,
      inBlockMs: s.inBlockMs,
      provingMs,
    };
    measured.push(m);
    log(`  ${what.padEnd(34)} gas ${String(m.gasUsed).padStart(8)}  confirmed in ${m.confirmMs} ms  ${m.hash}`);
    return m;
  };

  record('setWriter(treasurer)', await send('owner', 'db', 'setWriter', [treasurer, true]));
  record(`setTableOwner(${PROGRAM.table})`, await send('owner', 'db', 'setTableOwner', [PROGRAM.table, treasurer]));
  record(`setTableAuditor(${PROGRAM.table})`, await send('owner', 'db', 'setTableAuditor', [PROGRAM.table, auditor]));
  if (gate) {
    for (const p of PERKS) record(`addPerk(${p.name}, ≥${p.minPoints})`, await send('owner', 'gate', 'addPerk', [PROGRAM.table, p.minPoints, p.name]));
  }

  const state = new ZkDbState();
  const rowOf = new Map<bigint, bigint>();
  const secrets = new Map<bigint, bigint>();
  let nextRow = 0n;
  let nextProposal = 0n;
  /** Two signatures: the treasurer proposes, the auditor puts the same op into the queue. */
  const coSigned = async (what: string, opcode: bigint, row: bigint, v: bigint[]): Promise<Op> => {
    const op: Op = [opcode, row, BigInt(BALANCE_FIELD), ...v];
    record(`propose ${what}`, await send('treasurer', 'db', 'proposeChange', [Number(opcode), row, BigInt(BALANCE_FIELD), v]));
    record(`approve #${nextProposal} (auditor)`, await send('auditor', 'db', 'approveChange', [nextProposal, op]));
    nextProposal++;
    return op;
  };

  for (const [i, steps] of BATCHES.entries()) {
    const queued: Op[] = [];
    for (const step of steps) {
      if (step.kind === 'join') {
        const secret = newCardSecret();
        secrets.set(step.card, secret);
        const fields = [step.card, 0n, cardKey(secret), 0n, 0n, 0n];
        record(`insert card ${step.card}`, await send('treasurer', 'db', 'insert', [PROGRAM.table, fields]));
        rowOf.set(step.card, nextRow);
        queued.push([OPCODE.INSERT, nextRow, PROGRAM.table, ...fields]);
        nextRow++;
        continue;
      }
      const row = rowOf.get(step.card)!;
      if (step.kind === 'correct') {
        queued.push(await coSigned(`card ${step.card} → ${step.points}`, OPCODE.SET, row, [step.points, REASONS.correction.code, 0n, 0n, 0n, 0n]));
        continue;
      }
      const v = [step.points, REASONS[step.reason].code, 0n, 0n, 0n, 0n];
      if (step.kind === 'redeem') {
        // Taking points away needs the auditor too.
        queued.push(await coSigned(`redeem ${step.points} card ${step.card}`, OPCODE.SUB, row, v));
        continue;
      }
      record(`award ${step.points} card ${step.card}`, await send('treasurer', 'db', 'enqueue', [3, row, BigInt(BALANCE_FIELD), v]));
      queued.push([OPCODE.ADD, row, BigInt(BALANCE_FIELD), ...v]);
    }
    const batch = buildBatch(state, queued);
    const started = performance.now();
    const proof = await proveBatch(batch, circuit);
    const provingMs = Math.round(performance.now() - started);
    if (!(await verifyBatch(proof, circuit))) throw new Error('generated proof did not verify');
    const sent = await send('treasurer', 'db', 'submitBatch', [bytes(proof.proof), toHex(batch.newRoot), batch.ok, queued]);
    const m = record(`submitBatch #${i + 1} (${queued.length} ops)`, sent, provingMs);
    meta?.update(toHex(batch.newRoot), { provingMs, provedAt: Date.now(), txHash: m.hash.toLowerCase(), confirmMs: m.confirmMs });
    log(`  proof #${i + 1}: proved in ${provingMs} ms, ${batch.ok.slice(0, queued.length).filter((x) => !x).length} rejected`);
    if (relay) record(`relay root #${i + 1} over ICM`, await send('treasurer', 'relay', 'relay', []));

    if (gate && i === CLAIM.afterBatch) {
      const perk = { id: BigInt(CLAIM.perk), minPoints: PERKS[CLAIM.perk].minPoints };
      const code = newPickupCode();
      const claim = buildClaim(state, PROGRAM.table, perk, secrets.get(CLAIM.card)!, pickupHash(code));
      if (!claim.ok) throw new Error(`seed claim failed: ${claim.reason}`);
      const claimCircuit = loadClaimCircuit();
      const t0 = performance.now();
      const claimProof = await proveClaim(claim.input, claimCircuit);
      const claimMs = Math.round(performance.now() - t0);
      if (!(await verifyClaim(claimProof, claimCircuit))) throw new Error('generated claim proof did not verify');
      record(`claim "${PERKS[CLAIM.perk].name}" (ZK, card hidden)`, await send('relayer', 'gate', 'claim', [bytes(claimProof.proof), perk.id, toHex(claim.input.nullifier), toHex(claim.input.pickup)]), claimMs);
      record('collect with the pickup code (desk)', await send('treasurer', 'gate', 'collect', [perk.id, code]));
    }
  }
  return { measured, cards: [...secrets].map(([card, secret]) => ({ card: card.toString(), secret: viemHex(secret, { size: 32 }) })) };
}

/** Markdown table of measured costs and times, for docs/fuji-measurements.md. */
export function measurementsTable(rows: Measured[], symbol: string, explorer?: string): string {
  const coin = (wei: bigint) => (Number(wei) / 1e18).toExponential(3);
  const lines = [
    `| Transaction | Gas | Fee (${symbol}) | Receipt after | In a block after | Proved in | Tx |`,
    '|---|---:|---:|---:|---:|---:|---|',
    ...rows.map((r) => `| ${r.what} | ${r.gasUsed} | ${coin(r.feeWei)} | ${r.confirmMs} ms | ${r.inBlockMs === undefined ? '' : `${r.inBlockMs} ms`} | ${r.provingMs === undefined ? '' : `${r.provingMs} ms`} | ${explorer ? `[${r.hash.slice(0, 10)}…](${explorer}/tx/${r.hash})` : r.hash} |`),
  ];
  return lines.join('\n');
}
