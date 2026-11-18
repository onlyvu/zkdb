/**
 * Writes contracts/test/fixtures/claim_1.json: three members join in one proven batch, then two real claim proofs
 * against the resulting root (two different cards, same perk) for the PointsGate tests.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initHash, type Row } from '../src/hash';
import { ZkDbState, buildBatch } from '../src/vm';
import { encodeInsert } from '../src/ops';
import { buildClaim, cardKey } from '../src/claim';
import { proveClaim, verifyClaim } from '../src/claim-prover';
import { loadClaimCircuit, proveBatch, verifyBatch } from '../src/prover';
import { toHex } from '../src/field';

await initHash();
const TABLE = 1n;
const PERK = { id: 0n, minPoints: 500n };
/** PointsGate.pickupHash: SHA-256 of the 32-byte code, cut to 248 bits. */
const pickupHash = (code: bigint) => BigInt('0x' + createHash('sha256').update(Buffer.from(code.toString(16).padStart(64, '0'), 'hex')).digest('hex')) >> 8n;
const cards: { card: bigint; points: bigint; secret: bigint }[] = [
  { card: 42n, points: 1250n, secret: 0xa11ce0042n },
  { card: 107n, points: 550n, secret: 0xb0b0107n },
  { card: 215n, points: 250n, secret: 0xca7215n },
];

// The three members join in one proven batch, so the tests can take the root from ZkDB itself.
const state = new ZkDbState();
const emptyRoot = state.root;
const ops = cards.map((c, i) => encodeInsert(i, TABLE, [c.card, c.points, cardKey(c.secret), 0n, 0n, 0n] as Row));
const batch = buildBatch(state, ops);
const batchProof = await proveBatch(batch);
if (!(await verifyBatch(batchProof))) throw new Error('batch proof did not verify off-chain');

const circuit = loadClaimCircuit();
const claims = [];
for (const [i, c] of cards.slice(0, 2).entries()) {
  const pickupCode = 0xc0de0000n + BigInt(i);
  const built = buildClaim(state, TABLE, PERK, c.secret, pickupHash(pickupCode));
  if (!built.ok) throw new Error(built.reason);
  const t0 = Date.now();
  const p = await proveClaim(built.input, circuit);
  const proveMs = Date.now() - t0;
  if (!(await verifyClaim(p, circuit))) throw new Error('claim proof did not verify off-chain');
  claims.push({ nullifier: toHex(built.input.nullifier), pickupCode: toHex(pickupCode), pickup: toHex(built.input.pickup), proof: '0x' + Buffer.from(p.proof).toString('hex'), proveMs });
}
const poor = buildClaim(state, TABLE, PERK, cards[2].secret, 1n);
if (poor.ok || poor.reason !== 'not_enough_points') throw new Error('the 250-point card must not be able to claim');

const fixture = {
  emptyRoot: toHex(emptyRoot),
  root: toHex(state.root),
  tableId: Number(TABLE),
  minPoints: Number(PERK.minPoints),
  perkId: Number(PERK.id),
  opsFlat: ops.flat().map(toHex),
  batchProof: '0x' + Buffer.from(batchProof.proof).toString('hex'),
  claims,
};
const dir = fileURLToPath(new URL('../../../contracts/test/fixtures/', import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(dir + 'claim_1.json', JSON.stringify(fixture, null, 2));
console.log(`wrote claim_1.json (prove ${claims.map((c) => c.proveMs).join(' / ')} ms, proof ${(claims[0].proof.length - 2) / 2} bytes)`);
