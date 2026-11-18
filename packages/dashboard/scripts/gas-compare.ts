/**
 * Measures the question "why a proof and not a plain contract" in gas: the same 16 changes (6 members join, 10 awards
 * and redemptions, one of them above the balance) sent to an ordinary-storage ledger (contracts/test/baseline/
 * PlainLedger.sol) and to zkDB, on a throwaway anvil chain. Every number is the gasUsed of a real receipt; the zkDB
 * batch carries a real UltraHonk proof. Writes docs/gas-comparison.md.
 *
 * Usage: npm run gas:compare -w @zkdb/dashboard
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { buildBatch, cardKey, initHash, OPCODE, ZkDbState, type Op } from '@zkdb/core';
import { loadCircuit, proveBatch } from '@zkdb/core/prover';

const PORT = Number(process.env.ZKDB_GAS_PORT ?? 8561);
const RPC = `http://127.0.0.1:${PORT}`;
const pathOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const CONTRACTS = pathOf('../../../contracts');
const env = { ...process.env, PATH: `${homedir()}/.foundry/bin:${process.env.PATH}` };
const transport = http(RPC);
const pub = createPublicClient({ chain: foundry, transport, pollingInterval: 50 });
const wallet = createWalletClient({ chain: foundry, transport });
const artifact = (name: string): { abi: Abi; bytecode: Hex } => {
  const a = JSON.parse(readFileSync(`${CONTRACTS}/out/${name}.sol/${name}.json`, 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object };
};

type Step = { kind: 'join'; card: bigint } | { kind: 'award' | 'redeem'; row: bigint; points: bigint; reason: bigint };
const STEPS: Step[] = [
  ...[42n, 107n, 215n, 333n, 518n, 604n].map((card) => ({ kind: 'join' as const, card })),
  { kind: 'award', row: 0n, points: 400n, reason: 1n },
  { kind: 'award', row: 1n, points: 300n, reason: 1n },
  { kind: 'award', row: 2n, points: 200n, reason: 3n },
  { kind: 'award', row: 3n, points: 150n, reason: 3n },
  { kind: 'award', row: 4n, points: 250n, reason: 2n },
  { kind: 'award', row: 0n, points: 450n, reason: 2n },
  { kind: 'award', row: 5n, points: 100n, reason: 3n },
  { kind: 'redeem', row: 2n, points: 150n, reason: 10n },
  { kind: 'redeem', row: 3n, points: 200n, reason: 11n }, // 150 < 200: rejected in both ledgers
  { kind: 'redeem', row: 1n, points: 100n, reason: 11n },
];

/** A row of docs/fuji-measurements.md, so the Fuji numbers quoted below are always the ones measured there. */
function fuji(what: RegExp): { gas: number; url: string } {
  const row = readFileSync(pathOf('../../../docs/fuji-measurements.md'), 'utf8').split('\n').find((l) => l.startsWith('| ') && what.test(l));
  const cells = row?.split('|').map((c) => c.trim()) ?? [];
  const url = /\((https:[^)]+)\)/.exec(row ?? '')?.[1];
  if (!row || !url) throw new Error(`docs/fuji-measurements.md has no row matching ${what}`);
  return { gas: Number(cells[2].replace(/,/g, '')), url };
}

async function main() {
  const built = spawnSync('forge', ['build'], { cwd: CONTRACTS, env, encoding: 'utf8' });
  if (built.status !== 0) throw new Error(`forge build failed\n${built.stderr ?? built.error}`);
  const anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !(await pub.getBlockNumber().then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
    const [owner, treasurer] = (await wallet.getAddresses()) as [Address, Address];
    const gasOf = async (hash: Hex) => {
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error('a measured transaction reverted');
      return r.gasUsed;
    };
    const deploy = async (name: string, args: unknown[]) => {
      const { abi, bytecode } = artifact(name);
      const r = await pub.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi, bytecode, args, account: owner }) });
      return r.contractAddress!;
    };
    await initHash();

    // Plain ledger
    const plain = { address: await deploy('PlainLedger', []), abi: artifact('PlainLedger').abi };
    await gasOf(await wallet.writeContract({ ...plain, functionName: 'setTreasurer', args: [treasurer], account: owner }));
    const plainGas: bigint[] = [];
    for (const s of STEPS) {
      const call = s.kind === 'join' ? { functionName: 'join', args: [s.card, 0n] } : { functionName: s.kind, args: [s.row, s.points, s.reason] };
      plainGas.push(await gasOf(await wallet.writeContract({ ...plain, ...call, account: treasurer })));
    }

    // zkDB
    const db = { address: await deploy('ZkDB', [await deploy('BatchVerifier', []), `0x${new ZkDbState().root.toString(16).padStart(64, '0')}`]), abi: artifact('ZkDB').abi };
    await gasOf(await wallet.writeContract({ ...db, functionName: 'setWriter', args: [treasurer, true], account: owner }));
    await gasOf(await wallet.writeContract({ ...db, functionName: 'setTableOwner', args: [1n, treasurer], account: owner }));
    const queueGas: bigint[] = [];
    const ops: Op[] = [];
    let nextRow = 0n;
    for (const s of STEPS) {
      if (s.kind === 'join') {
        const fields = [s.card, 0n, cardKey(s.card + 1000n), 0n, 0n, 0n];
        queueGas.push(await gasOf(await wallet.writeContract({ ...db, functionName: 'insert', args: [1n, fields], account: treasurer })));
        ops.push([OPCODE.INSERT, nextRow++, 1n, ...fields]);
      } else {
        const code = s.kind === 'award' ? 3 : 4;
        const v = [s.points, s.reason, 0n, 0n, 0n, 0n];
        queueGas.push(await gasOf(await wallet.writeContract({ ...db, functionName: 'enqueue', args: [code, s.row, 1n, v], account: treasurer })));
        ops.push([BigInt(code), s.row, 1n, ...v]);
      }
    }
    const batch = buildBatch(new ZkDbState(), ops);
    const proof = await proveBatch(batch, loadCircuit());
    const proofGas = await gasOf(await wallet.writeContract({
      ...db, functionName: 'submitBatch', account: treasurer,
      args: [`0x${Buffer.from(proof.proof).toString('hex')}`, `0x${batch.newRoot.toString(16).padStart(64, '0')}`, batch.ok, ops],
    }));
    if (batch.ok.slice(0, 16).filter((x) => !x).length !== 1) throw new Error('expected exactly one rejected redemption');

    const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
    const small = { n: 2, ...fuji(/submitBatch #\d+ \(2 ops\)/) };
    const big = { n: 16, ...fuji(/submitBatch #\d+ \(16 ops\)/) };
    const perExtra = Math.round((big.gas - small.gas) / (big.n - small.n) / 100) * 100;
    const fixed = Math.round((small.gas - small.n * perExtra) / 1000) * 1000;
    const claim = fuji(/^\| claim /);
    const relay = fuji(/relay root #2/);
    const n = BigInt(STEPS.length);
    const fmt = (g: bigint) => g.toLocaleString('en-US');
    const kinds = ['join', 'award', 'redeem'] as const;
    const avg = (xs: bigint[], kind: string) => {
      const picked = xs.filter((_, i) => STEPS[i].kind === kind);
      return sum(picked) / BigInt(picked.length);
    };
    const plainTotal = sum(plainGas);
    const queueTotal = sum(queueGas);
    const zkTotal = queueTotal + proofGas;
    const md = [
      '# Gas: a plain contract against zkDB',
      '',
      'Written by `npm run gas:compare -w @zkdb/dashboard`. It starts a throwaway anvil chain, sends the same 16 changes',
      'to both ledgers and reads `gasUsed` from every receipt. The zkDB batch carries a real UltraHonk proof.',
      '',
      '- Plain: [`contracts/test/baseline/PlainLedger.sol`](../contracts/test/baseline/PlainLedger.sol). Balances in contract storage, one event per change with who, what, why and the balance after. A redemption above the balance is recorded as rejected.',
      '- zkDB: [`contracts/src/ZkDB.sol`](../contracts/src/ZkDB.sol). Each change is queued in its own transaction, then one proof covers the batch.',
      '- The 16 changes: 6 members join, 7 awards, 3 redemptions (one above the balance).',
      '',
      '| | Plain contract | zkDB |',
      '|---|---:|---:|',
      ...kinds.map((k) => `| ${k}, average per change | ${fmt(avg(plainGas, k))} | ${fmt(avg(queueGas, k))} (queue only) |`),
      `| 16 changes | ${fmt(plainTotal)} | ${fmt(queueTotal)} (queue) |`,
      `| One proof for the batch (\`submitBatch\`) | 0 | ${fmt(proofGas)} |`,
      `| **Total for 16 changes** | **${fmt(plainTotal)}** | **${fmt(zkTotal)}** |`,
      `| **Per change** | **${fmt(plainTotal / n)}** | **${fmt(zkTotal / n)}** |`,
      '',
      `So at 16 changes zkDB costs ${(Number(zkTotal) / Number(plainTotal)).toFixed(1)} times the gas of the plain contract.`,
      '',
      '## Does a bigger batch change the answer?',
      '',
      `Not in this design. Queueing a change costs about ${fmt(queueTotal / n)} gas on its own, which is already more than the ${fmt(plainTotal / n)} the plain contract needs to apply it. The proof only adds to that, whatever the batch size.`,
      '',
      'The queue is expensive because every change is its own transaction (21,000 gas before anything runs) and stores a hash. A design that posts the changes only once, inside `submitBatch`, would pay per change roughly what `submitBatch` already pays for each extra one:',
      '',
      '| Measured on Fuji ([fuji-measurements.md](fuji-measurements.md)) | Gas |',
      '|---|---:|',
      `| \`submitBatch\` with ${small.n} changes ([tx](${small.url})) | ${fmt(BigInt(small.gas))} |`,
      `| \`submitBatch\` with ${big.n} changes ([tx](${big.url})) | ${fmt(BigInt(big.gas))} |`,
      `| Each extra change inside a batch: (${fmt(BigInt(big.gas))} − ${fmt(BigInt(small.gas))}) / ${big.n - small.n} | about ${fmt(BigInt(perExtra))} |`,
      `| Fixed cost of one proof: ${fmt(BigInt(small.gas))} − ${small.n} × ${fmt(BigInt(perExtra))} | about ${fmt(BigInt(fixed))} |`,
      '',
      `With those numbers a batch-only design would cost about ${fmt(BigInt(fixed))} / n + ${fmt(BigInt(perExtra))} gas per change. That drops below the plain contract's ${fmt(plainTotal / n)} at about ${Math.ceil(fixed / (Number(plainTotal / n) - perExtra))} changes per batch. The circuit here takes 16, so this is a calculation, not something we built or measured.`,
      '',
      'One more cost on the real ledger: the points table has an auditor, so a redemption or a correction there is two transactions (propose, then approve), about 163,000 gas before the proof. A plain contract with the same two-signer rule would pay for two transactions as well; the comparison above uses one signer on both sides.',
      '',
      '## What the proof buys instead',
      '',
      'Gas is not the reason for the proof. These three are:',
      '',
      `1. A member can prove "a card in this ledger has at least N points" without showing which card ([\`PointsGate.sol\`](../contracts/src/PointsGate.sol), [\`circuits/claim\`](../circuits/claim/src/main.nr); ${fmt(BigInt(claim.gas))} gas per claim, [tx](${claim.url})). A plain contract can check a balance, but only by being told whose balance. The claim needs the state as a Merkle root that a circuit can open cheaply, which means a Poseidon2 tree.`,
      '2. Keeping that Poseidon2 root up to date by hand in the EVM would cost far more than the proof. One change needs the old path and the new path: 2 × 20 hashes. The cheapest public EVM implementation we know, [zemse/poseidon2-evm](https://github.com/zemse/poseidon2-evm), reports 20,304 gas per hash, so about 812,000 gas per change before leaf hashing and storage. This figure is calculated from that project\'s published gas report; we did not run it.',
      `3. The root is 32 bytes for every balance at once. [\`RootRelay.sol\`](../contracts/src/icm/RootRelay.sol) sends it towards another Avalanche L1 over ICM for ${fmt(BigInt(relay.gas))} gas per proof ([tx](${relay.url})), and a gate there could check the same claims with no copy of the ledger. Today only the sending half exists on-chain: Teleporter on Dispatch receives each message and cannot execute it, because the receiving contract is not deployed (see the README).`,
      '',
      'If none of the three matters to a club, the plain contract is the better choice, and cheaper.',
      '',
    ].join('\n');
    writeFileSync(pathOf('../../../docs/gas-comparison.md'), md);
    console.log(md);
  } finally {
    anvil.kill();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
