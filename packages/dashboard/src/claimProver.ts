import type { CompiledCircuit } from '@noir-lang/noir_js';
import type { ClaimInput } from '@zkdb/core';

/**
 * Proves a perk claim on this device. The circuit (about 6,000 gates) and the prover are loaded on first use, so
 * people who only read the ledger never download them. The card secret goes into the witness and nowhere else.
 */
let circuit: Promise<CompiledCircuit> | undefined;

export async function proveClaimHere(input: ClaimInput): Promise<{ proof: `0x${string}`; ms: number }> {
  circuit ??= import('../../../circuits/target/claim.json').then((m) => m.default as unknown as CompiledCircuit);
  const [{ proveClaim }, compiled] = await Promise.all([import('@zkdb/core/claim-prover'), circuit]);
  const started = performance.now();
  const { proof } = await proveClaim(input, compiled);
  const hex = Array.from(proof, (b) => b.toString(16).padStart(2, '0')).join('');
  return { proof: `0x${hex}`, ms: Math.round(performance.now() - started) };
}
