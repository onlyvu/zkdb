import { Noir, type CompiledCircuit } from '@noir-lang/noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import { toHex } from './field';
import type { ClaimInput } from './claim';

/**
 * Proves circuits/claim. No file access, so the same code runs in a browser (the member's device) and in Node.
 * verifierTarget 'evm' is the zero-knowledge flavour of UltraHonk: the proof reveals nothing about the private
 * inputs (which row, which secret).
 */
export function toClaimInputs(c: ClaimInput): Record<string, unknown> {
  return {
    root: toHex(c.root),
    table_id: toHex(c.tableId),
    min_points: toHex(c.minPoints),
    perk_id: toHex(c.perkId),
    nullifier: toHex(c.nullifier),
    pickup: toHex(c.pickup),
    row_id: toHex(BigInt(c.rowId)),
    row: c.row.map(toHex),
    siblings: c.siblings.map(toHex),
    secret: toHex(c.secret),
  };
}

export interface ClaimProof { proof: Uint8Array; publicInputs: string[] }

async function withBackend<T>(circuit: CompiledCircuit, fn: (b: UltraHonkBackend) => Promise<T>): Promise<T> {
  const api = await Barretenberg.new();
  try {
    return await fn(new UltraHonkBackend(circuit.bytecode, api));
  } finally {
    await api.destroy();
  }
}

export async function proveClaim(c: ClaimInput, circuit: CompiledCircuit): Promise<ClaimProof> {
  const { witness } = await new Noir(circuit).execute(toClaimInputs(c) as never);
  return withBackend(circuit, (backend) => backend.generateProof(witness, { verifierTarget: 'evm' }));
}

export async function verifyClaim(p: ClaimProof, circuit: CompiledCircuit): Promise<boolean> {
  return withBackend(circuit, (backend) => backend.verifyProof(p, { verifierTarget: 'evm' }));
}
