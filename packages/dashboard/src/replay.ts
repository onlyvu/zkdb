import { K, ZkDbState, type Op, type Row } from '@zkdb/core';

export interface QueuedOp {
  id: number;
  op: Op;
  /** The account that asked for the change (from the OpQueued event). */
  by?: string;
  txHash: string;
  timestamp?: number;
}

export interface BatchEvent {
  batchNo: number;
  oldRoot: bigint;
  newRoot: bigint;
  fromOp: number;
  toOp: number;
  /** All K flags from the event; only the first toOp - fromOp belong to real ops. */
  ok: boolean[];
  txHash: string;
  gasUsed?: bigint;
  /** gasUsed × effective gas price, in wei of the native coin. */
  fee?: bigint;
  timestamp?: number;
}

export type OpStatus = 'applied' | 'failed' | 'pending';
export interface OpView extends QueuedOp { status: OpStatus; batchNo?: number }
export interface BatchView extends BatchEvent { applied: number; failed: number }
export interface RowView { rowId: number; table: bigint; fields: Row }

export interface ReplayResult {
  ops: OpView[];
  batches: BatchView[];
  rows: RowView[];
  /** The rebuilt database, with its Merkle tree: what a member opens their own row against. */
  state: ZkDbState;
  replayRoot: bigint;
  /** Replay reached the same root as the contract and agreed with every batch. */
  matches: boolean;
  issues: string[];
}

const short = (x: bigint) => {
  const hex = x.toString(16).padStart(64, '0');
  return `0x${hex.slice(0, 6)}…${hex.slice(-4)}`;
};

/**
 * Re-executes the on-chain op log with the off-chain VM and compares each batch with what the contract accepted.
 * Op status always comes from the proven `ok` flags in the event; replay only checks them, never overrides them.
 */
export function replay(ops: QueuedOp[], batches: BatchEvent[], chainRoot: bigint): ReplayResult {
  const issues: string[] = [];
  const sorted = [...ops].sort((a, b) => a.id - b.id);
  sorted.forEach((op, i) => {
    if (op.id !== i && !issues.length) issues.push(`Op log has a gap: expected op #${i}, found op #${op.id}.`);
  });

  const views = new Map<number, OpView>(sorted.map((op) => [op.id, { ...op, status: 'pending' as OpStatus }]));
  const state = new ZkDbState();
  let halted = false;
  const batchViews: BatchView[] = [];

  for (const b of [...batches].sort((x, y) => x.batchNo - y.batchNo)) {
    const n = b.toOp - b.fromOp;
    const flags = b.ok.slice(0, n);
    for (let i = 0; i < n; i++) {
      const v = views.get(b.fromOp + i);
      if (v) { v.status = flags[i] ? 'applied' : 'failed'; v.batchNo = b.batchNo; }
    }
    batchViews.push({ ...b, applied: flags.filter(Boolean).length, failed: flags.filter((f) => !f).length });
    if (halted) continue;

    if (state.root !== b.oldRoot) {
      issues.push(`Batch #${b.batchNo}: on-chain oldRoot ${short(b.oldRoot)} differs from replay ${short(state.root)}.`);
    }
    for (let i = 0; i < n && !halted; i++) {
      const id = b.fromOp + i;
      const v = views.get(id);
      if (!v) {
        issues.push(`Batch #${b.batchNo}: op #${id} is missing from the log, replay stopped.`);
        halted = true;
        break;
      }
      try {
        const { ok } = state.applyOp(v.op);
        if (ok !== flags[i]) issues.push(`Batch #${b.batchNo}, op #${id}: on-chain ok=${flags[i]}, replay ok=${ok}.`);
      } catch (e) {
        issues.push(`Batch #${b.batchNo}, op #${id}: could not be replayed (${(e as Error).message}), replay stopped.`);
        halted = true;
      }
    }
    if (!halted && state.root !== b.newRoot) {
      issues.push(`Batch #${b.batchNo}: on-chain newRoot ${short(b.newRoot)} differs from replay ${short(state.root)}.`);
    }
  }

  return {
    ops: [...views.values()],
    batches: batchViews,
    rows: state.listRows(),
    state,
    replayRoot: state.root,
    matches: issues.length === 0 && state.root === chainRoot,
    issues,
  };
}


export type SlotKind = 'ok' | 'fail' | 'pending' | 'noop' | 'empty';
export interface Slot { kind: SlotKind; op?: OpView }

/** The K slots a proven batch occupied: its real ops in order, then NOOP padding. */
export function batchSlots(b: BatchEvent, ops: OpView[]): Slot[] {
  const n = b.toOp - b.fromOp;
  return Array.from({ length: K }, (_, i) => {
    if (i >= n) return { kind: 'noop' as const };
    return { kind: b.ok[i] ? ('ok' as const) : ('fail' as const), op: ops.find((o) => o.id === b.fromOp + i) };
  });
}

/** The K slots of the next batch, filled from the front of the queue. */
export function nextBatchSlots(ops: OpView[]): Slot[] {
  const queued = ops.filter((o) => o.status === 'pending').sort((a, b) => a.id - b.id);
  return Array.from({ length: K }, (_, i) => (queued[i] ? { kind: 'pending' as const, op: queued[i] } : { kind: 'empty' as const }));
}
