import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Noir, type CompiledCircuit } from '@noir-lang/noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import { toHex } from './field';
import type { BatchInput } from './vm';

export function loadCircuit(path?: string): CompiledCircuit {
  path ??= fileURLToPath(new URL('../../../circuits/target/batch.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as CompiledCircuit;
}

/** The compiled claim circuit (circuits/claim): "a card in this root has at least N points". */
export const loadClaimCircuit = (): CompiledCircuit =>
  loadCircuit(fileURLToPath(new URL('../../../circuits/target/claim.json', import.meta.url)));

export function toNoirInputs(b: BatchInput): Record<string, unknown> {
  return {
    old_root: toHex(b.oldRoot),
    new_root: toHex(b.newRoot),
    ok: b.ok,
    ops: b.ops.map((op) => op.map(toHex)),
    witnesses: b.witnesses.map((w) => ({
      is_empty: w.is_empty,
      table_id: toHex(w.table_id),
      row: w.row.map(toHex),
      siblings: w.siblings.map(toHex),
    })),
  };
}

async function withBackend<T>(circuit: CompiledCircuit, fn: (b: UltraHonkBackend) => Promise<T>): Promise<T> {
  const api = await Barretenberg.new();
  try {
    return await fn(new UltraHonkBackend(circuit.bytecode, api));
  } finally {
    await api.destroy();
  }
}

export async function proveBatch(b: BatchInput, circuit = loadCircuit()): Promise<{ proof: Uint8Array; publicInputs: string[] }> {
  const { witness } = await new Noir(circuit).execute(toNoirInputs(b) as any);
  return withBackend(circuit, (backend) => backend.generateProof(witness, { verifierTarget: 'evm' }));
}

export async function verifyBatch(p: { proof: Uint8Array; publicInputs: string[] }, circuit = loadCircuit()): Promise<boolean> {
  return withBackend(circuit, (backend) => backend.verifyProof(p, { verifierTarget: 'evm' }));
}
