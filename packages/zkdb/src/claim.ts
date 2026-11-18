import { poseidon2, type Row } from './hash';
import type { ZkDbState } from './vm';

/** Member rows of a points table are [card number, balance, card key, 0, 0, 0]; circuits/claim reads these two. */
export const CLAIM_BALANCE_FIELD = 1;
export const CLAIM_KEY_FIELD = 2;

/** What a row stores about its card: a hash of the secret printed on the card. Mirrors card_key in circuits/claim. */
export const cardKey = (secret: bigint): bigint => poseidon2([secret]);

/** One per card and perk; it cannot be linked to the card without the secret. Mirrors nullifier_of. */
export const claimNullifier = (secret: bigint, perkId: bigint): bigint => poseidon2([secret, perkId]);

/** Inputs of circuits/claim. The first six are public; the rest never leave the prover. */
export interface ClaimInput {
  root: bigint;
  tableId: bigint;
  minPoints: bigint;
  perkId: bigint;
  nullifier: bigint;
  /** Who the claim is for: the hash of a one-time pickup code. Bound into the proof as a public input. */
  pickup: bigint;
  rowId: number;
  row: Row;
  siblings: bigint[];
  secret: bigint;
}

export type ClaimCheck =
  | { ok: true; input: ClaimInput }
  | { ok: false; reason: 'unknown_card' | 'not_enough_points'; balance?: bigint };

/**
 * Finds the card that belongs to a secret in the replayed state and builds the claim witness. Runs wherever the
 * state was replayed, so the secret can stay on the member's own device. `pickup` must be a non-zero field element;
 * PointsGate expects SHA-256(code) >> 8 for a 32-byte one-time code (see pickupHash in PointsGate.sol).
 */
export function buildClaim(state: ZkDbState, tableId: bigint, perk: { id: bigint; minPoints: bigint }, secret: bigint, pickup: bigint): ClaimCheck {
  const key = cardKey(secret);
  const row = state.listRows().find((r) => r.table === tableId && r.fields[CLAIM_KEY_FIELD] === key);
  if (!row) return { ok: false, reason: 'unknown_card' };
  const balance = row.fields[CLAIM_BALANCE_FIELD];
  if (balance < perk.minPoints) return { ok: false, reason: 'not_enough_points', balance };
  return {
    ok: true,
    input: {
      root: state.root,
      tableId,
      minPoints: perk.minPoints,
      perkId: perk.id,
      nullifier: claimNullifier(secret, perk.id),
      pickup,
      rowId: row.rowId,
      row: row.fields,
      siblings: state.tree.siblings(row.rowId),
      secret,
    },
  };
}
