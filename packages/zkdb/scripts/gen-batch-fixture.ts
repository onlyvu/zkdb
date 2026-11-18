import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initHash, Row } from '../src/hash';
import { ZkDbState, buildBatch } from '../src/vm';
import { encodeInsert, encodeAdd, encodeSub, encodeSet, encodeDelete } from '../src/ops';
import { proveBatch, verifyBatch } from '../src/prover';
import { toHex } from '../src/field';

await initHash();
const r = (...xs: number[]): Row => xs.map(BigInt) as Row;
const realOps = [
  encodeInsert(0, 2n, r(7, 0xc0ffee, 0, 0, 0, 0)),
  encodeInsert(1, 1n, r(7, 4, 1_000_000, 50_000, 0, 0)),
  encodeAdd(0, 4, 1n),
  encodeSub(0, 5, 1n),   // fails: underflow
  encodeSet(1, 4, 1n),
  encodeDelete(1),
  encodeSet(1, 0, 9n),   // fails: row deleted
];
const s = new ZkDbState();
const emptyRoot = s.root;
const b = buildBatch(s, realOps);
const t0 = Date.now();
const p = await proveBatch(b);
const proveMs = Date.now() - t0;
if (!(await verifyBatch(p))) throw new Error('proof did not verify off-chain');

const fixture = {
  emptyRoot: toHex(emptyRoot),
  oldRoot: toHex(b.oldRoot),
  newRoot: toHex(b.newRoot),
  ok: b.ok.map((x) => (x ? 1 : 0)),
  nRealOps: realOps.length,
  realOpsFlat: realOps.flat().map(toHex),
  proof: '0x' + Buffer.from(p.proof).toString('hex'),
  proveMs,
};
const dir = fileURLToPath(new URL('../../../contracts/test/fixtures/', import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(dir + 'batch_1.json', JSON.stringify(fixture, null, 2));
console.log(`wrote batch_1.json (prove ${proveMs} ms, ok=${fixture.ok.join('')})`);
