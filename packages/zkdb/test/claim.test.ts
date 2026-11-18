import { beforeAll, describe, expect, it } from 'vitest';
import { initHash, type Row } from '../src/hash';
import { ZkDbState } from '../src/vm';
import { encodeAdd, encodeInsert, encodeSet } from '../src/ops';
import { buildClaim, cardKey, claimNullifier } from '../src/claim';
import { proveClaim, verifyClaim } from '../src/claim-prover';
import { loadClaimCircuit } from '../src/prover';

const TABLE = 1n;
const PERK = { id: 3n, minPoints: 500n };
const SECRET = 0xa11cen;
const PICKUP = 0x7069636b7570n;

beforeAll(async () => { await initHash(); });

function ledger(points: bigint): ZkDbState {
  const s = new ZkDbState();
  s.applyOp(encodeInsert(0, TABLE, [7n, 900n, cardKey(0xb0bn), 0n, 0n, 0n] as Row));
  s.applyOp(encodeInsert(1, TABLE, [42n, points, cardKey(SECRET), 0n, 0n, 0n] as Row));
  s.applyOp(encodeInsert(2, 2n, [42n, 9999n, cardKey(0xdeadn), 0n, 0n, 0n] as Row));
  return s;
}

describe('claim witness', () => {
  it('finds the card by its secret and opens it against the current root', () => {
    const s = ledger(1250n);
    const c = buildClaim(s, TABLE, PERK, SECRET, PICKUP);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.input.rowId).toBe(1);
    expect(c.input.root).toBe(s.root);
    expect(c.input.nullifier).toBe(claimNullifier(SECRET, PERK.id));
    expect(c.input.pickup).toBe(PICKUP);
    expect(c.input.siblings).toHaveLength(20);
  });

  it('refuses a card below the threshold and reports its balance', () => {
    expect(buildClaim(ledger(250n), TABLE, PERK, SECRET, PICKUP)).toEqual({ ok: false, reason: 'not_enough_points', balance: 250n });
  });

  it('does not know a secret from another table or no table', () => {
    expect(buildClaim(ledger(1250n), TABLE, PERK, 0xdeadn, PICKUP)).toEqual({ ok: false, reason: 'unknown_card' });
    expect(buildClaim(ledger(1250n), TABLE, PERK, 1n, PICKUP)).toEqual({ ok: false, reason: 'unknown_card' });
  });

  it('gives one nullifier per perk, unrelated to the card key', () => {
    expect(claimNullifier(SECRET, 1n)).not.toBe(claimNullifier(SECRET, 2n));
    expect(claimNullifier(SECRET, 0n)).not.toBe(cardKey(SECRET));
  });
});

describe('claim prover (slow)', () => {
  it('proves a claim whose only public inputs are root, table, threshold, perk, nullifier and pickup hash', async () => {
    const s = ledger(1250n);
    const c = buildClaim(s, TABLE, PERK, SECRET, PICKUP);
    if (!c.ok) throw new Error(c.reason);
    const circuit = loadClaimCircuit();
    const p = await proveClaim(c.input, circuit);
    expect(p.publicInputs.map(BigInt)).toEqual([s.root, TABLE, PERK.minPoints, PERK.id, c.input.nullifier, PICKUP]);
    expect(await verifyClaim(p, circuit)).toBe(true);
    // the same proof does not hold for another nullifier, or for another pickup hash (someone else's claim)
    expect(await verifyClaim({ ...p, publicInputs: [...p.publicInputs.slice(0, 4), p.publicInputs[3], p.publicInputs[5]] }, circuit).catch(() => false)).toBe(false);
    expect(await verifyClaim({ ...p, publicInputs: [...p.publicInputs.slice(0, 5), p.publicInputs[4]] }, circuit).catch(() => false)).toBe(false);
  }, 600_000);

  it('cannot be proven after a correction takes the balance below the threshold', async () => {
    const s = ledger(1250n);
    const before = buildClaim(s, TABLE, PERK, SECRET, PICKUP);
    if (!before.ok) throw new Error(before.reason);
    s.applyOp(encodeSet(1, 1, 250n));
    expect(buildClaim(s, TABLE, PERK, SECRET, PICKUP)).toMatchObject({ ok: false, reason: 'not_enough_points' });
    // forcing the old witness onto the new root fails inside the circuit
    await expect(proveClaim({ ...before.input, root: s.root }, loadClaimCircuit())).rejects.toThrow();
    // and a wrong threshold in the witness fails too
    s.applyOp(encodeAdd(1, 1, 100n));
    await expect(proveClaim({ ...before.input, row: [42n, 350n, cardKey(SECRET), 0n, 0n, 0n], root: s.root, siblings: s.tree.siblings(1) }, loadClaimCircuit()))
      .rejects.toThrow(/not enough points/);
    // a claim made out to nobody is refused inside the circuit
    await expect(proveClaim({ ...before.input, pickup: 0n }, loadClaimCircuit())).rejects.toThrow();
  }, 600_000);
});
