import type { BatchView, OpView } from './replay';

export interface SearchData {
  ops: OpView[]; batches: BatchView[]; rowCount: number; address: string; verifier: string; owner: string; writers: string[];
  /** Points program members: card number → row. */
  cards?: { card: bigint; rowId: number }[];
}
export type SearchResult = { route: string } | { error: string };

const NOT_FOUND = 'Nothing matches that. Try card 42, proof 1, change 3 or a transaction hash.';
const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const rootHex = (x: bigint) => `0x${x.toString(16).padStart(64, '0')}`;

export function resolveSearch(query: string, d: SearchData): SearchResult {
  const q = query.trim();
  if (!q) return { error: 'Type something to search for.' };

  const cardRoute = (n: bigint) => d.cards?.find((c) => c.card === n);
  const card = /^card\s*#?\s*(\d+)$/i.exec(q);
  if (card) {
    const hit = cardRoute(BigInt(card[1]));
    return hit ? { route: `member/${hit.rowId}` } : { error: `No member has card #${card[1]}.` };
  }

  const named = /^(op|change|batch|proof|row)\s*#?\s*(\d+)$/i.exec(q);
  if (named) {
    const kind = ({ change: 'op', proof: 'batch' } as Record<string, string>)[named[1].toLowerCase()] ?? named[1].toLowerCase();
    const n = Number(named[2]);
    if (kind === 'op') return d.ops.some((o) => o.id === n) ? { route: `op/${n}` } : { error: `Change #${n} does not exist.` };
    if (kind === 'batch') return d.batches.some((b) => b.batchNo === n) ? { route: `batch/${n}` } : { error: `Proof #${n} does not exist.` };
    return n < d.rowCount ? { route: `row/${n}` } : { error: `Row ${n} does not exist yet.` };
  }

  // A bare number is ambiguous: a member's card first (what people look up most), otherwise a row.
  if (/^#?\d+$/.test(q)) {
    const hit = cardRoute(BigInt(q.replace('#', '')));
    if (hit) return { route: `member/${hit.rowId}` };
    const n = Number(q.replace('#', ''));
    return n < d.rowCount ? { route: `row/${n}` } : { error: `Row ${n} does not exist yet.` };
  }

  if (/^0x[0-9a-fA-F]{64}$/.test(q)) {
    const op = d.ops.find((o) => sameHex(o.txHash, q));
    if (op) return { route: `op/${op.id}` };
    const batch = d.batches.find((b) => sameHex(b.txHash, q) || sameHex(rootHex(b.newRoot), q) || sameHex(rootHex(b.oldRoot), q));
    return batch ? { route: `batch/${batch.batchNo}` } : { error: NOT_FOUND };
  }

  if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
    const known = [d.address, d.verifier, d.owner, ...d.writers].some((a) => sameHex(a, q));
    return known ? { route: 'admin' } : { error: 'That address has no role in this contract.' };
  }

  return { error: NOT_FOUND };
}
