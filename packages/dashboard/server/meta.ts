import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Timing facts the chain cannot hold: how long the server took to generate a proof, and how long the submitting
 * wallet waited for its transaction to be mined. Keyed by the batch's new root (0x-hex, lowercase).
 */
export interface ProofMeta {
  provingMs?: number;
  provedAt?: number;
  txHash?: string;
  confirmMs?: number;
}

export interface MetaStore {
  all(): Record<string, ProofMeta>;
  update(root: string, patch: ProofMeta): void;
}

export function memoryStore(): MetaStore {
  const data: Record<string, ProofMeta> = {};
  return {
    all: () => data,
    update: (root, patch) => { data[root.toLowerCase()] = { ...data[root.toLowerCase()], ...patch }; },
  };
}

/** A JSON file next to the server. Small, append-mostly, rewritten on each update. */
export function fileStore(path: string): MetaStore {
  let data: Record<string, ProofMeta> = {};
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // First run: no file yet.
  }
  return {
    all: () => data,
    update(root, patch) {
      data = { ...data, [root.toLowerCase()]: { ...data[root.toLowerCase()], ...patch } };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(data, null, 1) + '\n');
    },
  };
}
