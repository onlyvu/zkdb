import { hashLeaf, Row } from './hash';
import { ZkTree, DEPTH } from './tree';
import { NOOP_OP, Op, OPCODE, ROW_WIDTH } from './ops';

export const K = 16;
const U64_MAX = (1n << 64n) - 1n;
const isU64 = (x: bigint) => x >= 0n && x <= U64_MAX;
const ZERO_ROW: Row = [0n, 0n, 0n, 0n, 0n, 0n];

export interface OpWitness { is_empty: boolean; table_id: bigint; row: Row; siblings: bigint[] }
interface StoredRow { table: bigint; fields: Row }

export interface BatchInput {
  oldRoot: bigint; newRoot: bigint; ok: boolean[]; ops: Op[]; witnesses: OpWitness[]; consumed: number;
}

/** Off-chain mirror of circuits/zkdb/src/ops.nr. Must stay semantically identical. */
export class ZkDbState {
  readonly tree = new ZkTree(DEPTH);
  private readonly rows = new Map<number, StoredRow>();

  get root(): bigint { return this.tree.root; }

  /** Live rows sorted by id; the tree only stores hashes, so readers replaying the log need this. */
  listRows(): { rowId: number; table: bigint; fields: Row }[] {
    return [...this.rows.entries()]
      .sort(([a], [b]) => a - b)
      .map(([rowId, r]) => ({ rowId, table: r.table, fields: [...r.fields] as Row }));
  }

  applyOp(op: Op): { ok: boolean; witness: OpWitness } {
    const [opcode, rowIdBig, a, v0] = op;
    if (opcode === OPCODE.NOOP) {
      return { ok: true, witness: { is_empty: true, table_id: 0n, row: [...ZERO_ROW] as Row, siblings: this.tree.siblings(0) } };
    }
    const rowId = Number(rowIdBig);
    const cur = this.rows.get(rowId);
    const witness: OpWitness = {
      is_empty: !cur,
      table_id: cur?.table ?? 0n,
      row: [...(cur?.fields ?? ZERO_ROW)] as Row,
      siblings: this.tree.siblings(rowId),
    };
    const idx = Number(a);
    const found = a < BigInt(ROW_WIDTH);
    const field = found && cur ? cur.fields[idx] : 0n;

    let next: StoredRow | undefined = cur;
    let ok = false;
    switch (opcode) {
      case OPCODE.INSERT:
        ok = !cur;
        next = { table: a, fields: op.slice(3, 9) as Row };
        break;
      case OPCODE.SET:
        ok = !!cur && found;
        if (ok) next = { table: cur!.table, fields: withField(cur!.fields, idx, v0) };
        break;
      case OPCODE.ADD:
        ok = !!cur && found && isU64(field) && isU64(v0) && isU64(field + v0);
        if (ok) next = { table: cur!.table, fields: withField(cur!.fields, idx, field + v0) };
        break;
      case OPCODE.SUB:
        ok = !!cur && found && isU64(field) && isU64(v0) && field >= v0;
        if (ok) next = { table: cur!.table, fields: withField(cur!.fields, idx, field - v0) };
        break;
      case OPCODE.DELETE:
        ok = !!cur;
        next = undefined;
        break;
      default:
        ok = false;
    }
    if (ok) {
      if (next) this.rows.set(rowId, next); else this.rows.delete(rowId);
      this.tree.setLeaf(rowId, next ? hashLeaf(next.table, next.fields) : 0n);
    }
    return { ok, witness };
  }
}

function withField(fields: Row, idx: number, value: bigint): Row {
  const out = [...fields] as Row;
  out[idx] = value;
  return out;
}

/** Apply up to k pending ops (padding with NOOP) and return the circuit inputs. Mutates state. */
export function buildBatch(state: ZkDbState, pending: Op[], k = K): BatchInput {
  if (pending.length === 0) throw new Error('empty batch');
  const take = pending.slice(0, k);
  const ops = [...take, ...Array(k - take.length).fill(NOOP_OP)];
  const oldRoot = state.root;
  const ok: boolean[] = [];
  const witnesses: OpWitness[] = [];
  for (const op of ops) {
    const res = state.applyOp(op);
    ok.push(res.ok);
    witnesses.push(res.witness);
  }
  return { oldRoot, newRoot: state.root, ok, ops, witnesses, consumed: take.length };
}
