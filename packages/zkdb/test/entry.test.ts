import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('package entry', () => {
  it('does not reference the node-only prover', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('./prover');
  });

  it('exposes the browser-safe API', async () => {
    const m = await import('../src/index');
    expect(m.ZkTree).toBeDefined();
    expect(m.buildBatch).toBeDefined();
    expect(m.hashLeaf).toBeDefined();
  });
});
