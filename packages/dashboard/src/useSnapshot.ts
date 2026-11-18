import { useCallback, useEffect, useRef, useState } from 'react';
import { initHash } from '@zkdb/core';
import { createReader, type ChainConfig, type Snapshot } from './chain';

const POLL_MS = 3000;

export interface SnapshotState {
  snapshot?: Snapshot;
  error?: string;
  checkedAt?: Date;
  refresh: () => void;
  /** Reads the chain and replays the whole log again, even if no new block arrived. Resolves with the time it took. */
  recheck: () => Promise<number>;
}

const describe = (e: unknown) => {
  const err = e as { shortMessage?: string; message?: string };
  return err.shortMessage ?? err.message ?? String(e);
};

/** Polls the chain, and only re-reads and re-replays the log when a new block appears. */
export function useSnapshot(cfg: ChainConfig): SnapshotState {
  const [state, setState] = useState<Omit<SnapshotState, 'refresh' | 'recheck'>>({});
  const tickRef = useRef<() => void>(() => {});
  const recheckRef = useRef<() => Promise<number>>(async () => 0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let lastBlock: bigint | undefined;
    const reader = createReader(cfg);

    let running = false;
    let again = false;

    // One read at a time: an older read finishing late must never replace a newer one.
    const tick = async () => {
      if (running) { again = true; return; }
      running = true;
      clearTimeout(timer);
      try {
        await initHash();
        const block = await reader.blockNumber();
        if (block === lastBlock) {
          if (!cancelled) setState((s) => ({ ...s, error: undefined, checkedAt: new Date() }));
        } else {
          const snapshot = await reader.snapshot(block);
          lastBlock = block;
          if (!cancelled) setState({ snapshot, checkedAt: new Date() });
        }
      } catch (e) {
        // Keep the last snapshot on screen; the UI marks it as stale.
        if (!cancelled) setState((s) => ({ ...s, error: describe(e) }));
      }
      running = false;
      if (cancelled) return;
      if (again) { again = false; void tick(); } else timer = setTimeout(tick, POLL_MS);
    };
    tickRef.current = () => { void tick(); };
    recheckRef.current = async () => {
      const started = performance.now();
      // A fresh reader has no kept logs, so this is a full read and a full replay.
      const snapshot = await createReader(cfg).snapshot();
      if (!cancelled) setState({ snapshot, checkedAt: new Date() });
      lastBlock = snapshot.block;
      return Math.round(performance.now() - started);
    };
    void tick();

    return () => { cancelled = true; clearTimeout(timer); };
  }, [cfg]);

  const refresh = useCallback(() => tickRef.current(), []);
  const recheck = useCallback(() => recheckRef.current(), []);
  return { ...state, refresh, recheck };
}
