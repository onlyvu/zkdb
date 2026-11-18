import { beforeAll, describe, expect, it } from 'vitest';
import { initHash, Row } from '../src/hash';
import { ZkDbState, buildBatch } from '../src/vm';
import { encodeInsert, encodeAdd, encodeSub } from '../src/ops';
import { proveBatch, verifyBatch, loadCircuit } from '../src/prover';

const r = (...xs: number[]): Row => xs.map(BigInt) as Row;
beforeAll(async () => { await initHash(); });

describe('batch prover (slow)', () => {
  it('proves and verifies a mixed batch including a failing op', async () => {
    const s = new ZkDbState();
    const b = buildBatch(s, [
      encodeInsert(0, 2n, r(7, 0, 0, 0, 0, 0)),
      encodeAdd(0, 0, 3n),
      encodeSub(0, 1, 1n), // fails: 0 - 1
    ]);
    expect(b.ok.slice(0, 3)).toEqual([true, true, false]);
    const circuit = loadCircuit();
    const p = await proveBatch(b, circuit);
    expect(p.publicInputs).toHaveLength(2 + 16 + 16 * 9);
    expect(BigInt(p.publicInputs[1])).toBe(b.newRoot);
    expect(await verifyBatch(p, circuit)).toBe(true);
  }, 600_000);

  it('refuses to execute when ok flags are tampered', async () => {
    const s = new ZkDbState();
    const b = buildBatch(s, [encodeInsert(0, 2n, r(1, 0, 0, 0, 0, 0))]);
    b.ok[0] = false;
    await expect(proveBatch(b, loadCircuit())).rejects.toThrow();
  }, 600_000);
});
