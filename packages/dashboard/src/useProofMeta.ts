import { useEffect, useState } from 'react';

/** Proving and confirmation times kept by the dashboard server, keyed by the batch's new root (lowercase hex). */
export interface ProofMeta { provingMs?: number; confirmMs?: number; txHash?: string }
export type ProofMetaMap = Record<string, ProofMeta>;

export const META_EVENT = 'zkdb:proof-meta';

/** Reloads whenever the number of proofs changes. Without a server (static hosting) the map stays empty. */
export function useProofMeta(batchCount?: number): ProofMetaMap {
  const [meta, setMeta] = useState<ProofMetaMap>({});
  const [bump, setBump] = useState(0);
  useEffect(() => {
    const on = () => setBump((n) => n + 1);
    addEventListener(META_EVENT, on);
    return () => removeEventListener(META_EVENT, on);
  }, []);
  useEffect(() => {
    if (batchCount === undefined) return;
    let cancelled = false;
    fetch('/api/proofs/meta')
      .then((r) => (r.ok ? r.json() : {}))
      .then((m) => { if (!cancelled) setMeta(m); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [batchCount, bump]);
  return meta;
}

export const rootKey = (root: bigint) => `0x${root.toString(16).padStart(64, '0')}`;
export const formatMs = (ms?: number) => (ms === undefined ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
