import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, http } from 'viem';
import { foundry } from 'viem/chains';
import { createLedger, newSecret, ready, rowOf, BALANCE_FIELD, type Ledger } from '../src/index';

// anvil's first dev account, unlocked on anvil: the node signs, no key in this repo.
const ANVIL_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const PORT = 8553;
const env = { ...process.env, PATH: `${homedir()}/.foundry/bin:${process.env.PATH}` };
const hasTools = spawnSync('anvil', ['--version'], { env }).status === 0;
const transport = http(`http://127.0.0.1:${PORT}`);
const pub = createPublicClient({ chain: foundry, transport, pollingInterval: 50 });
const wallet = createWalletClient({ chain: foundry, transport, account: ANVIL_ACCOUNT });

let anvil: ChildProcess;
let ledger: Ledger;

describe.skipIf(!hasTools)('@zkdb/sdk on anvil, real provers', () => {
  beforeAll(async () => {
    spawnSync('forge', ['build'], { cwd: fileURLToPath(new URL('../../../contracts', import.meta.url)), env });
    anvil = spawn('anvil', ['--port', String(PORT), '--silent', '--code-size-limit', '100000'], { env, stdio: 'ignore' });
    for (let i = 0; i < 100 && !(await pub.getBlockNumber().then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
    await ready();
  }, 120_000);
  afterAll(() => anvil?.kill());

  const alice = newSecret();
  const bob = newSecret();

  it('job 1: creates a ledger', async () => {
    ledger = await createLedger({ pub, wallet, table: 7n });
    expect(ledger.address).toMatch(/^0x/);
  }, 120_000);

  it('job 2: writes a batch with a proof; a rule-breaking change is rejected inside the batch', async () => {
    const { queued, batches } = await ledger.writeBatch([
      { insert: { table: 7n, fields: rowOf(1n, 0n, alice) } },
      { insert: { table: 7n, fields: rowOf(2n, 0n, bob) } },
    ]);
    const [a, b] = queued.rowIds as [bigint, bigint];
    const second = await ledger.writeBatch([
      { add: { row: a, field: BALANCE_FIELD, amount: 120n } },
      { add: { row: b, field: BALANCE_FIELD, amount: 30n } },
      { sub: { row: b, field: BALANCE_FIELD, amount: 50n } }, // below zero: rejected by the circuit's rules
    ]);
    expect(batches).toHaveLength(1);
    expect(second.batches[0].ok).toEqual([true, true, false]);
    const { state } = await ledger.replay();
    const balances = Object.fromEntries(state.listRows().map((r) => [r.rowId, r.fields[BALANCE_FIELD]]));
    expect(balances).toEqual({ [Number(a)]: 120n, [Number(b)]: 30n });
  }, 300_000);

  it('job 3: proves a threshold in zero knowledge, checks it for free, records it once', async () => {
    const t = await ledger.addThreshold(7n, 100n, 'at least 100');
    const claim = await ledger.proveThreshold(t, alice);
    expect(await ledger.checkThreshold(claim)).toEqual({ valid: true });
    const { txHash } = await ledger.submitThreshold(claim);
    expect(txHash).toMatch(/^0x/);
    expect(await ledger.checkThreshold(claim)).toEqual({ valid: false, reason: 'AlreadyClaimed' });
    await expect(ledger.proveThreshold(t, bob)).rejects.toThrow(/below 100/);
  }, 300_000);
});
