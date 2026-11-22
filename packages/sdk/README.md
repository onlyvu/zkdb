# @zkdb/sdk

A ledger whose every batch of writes is proven, plus "at least N" claims proven in zero knowledge. No club, points or perks in it: those live in the dashboard app. The café stamp card in [`packages/example-cafe`](../example-cafe/cafe.ts) is a second app built only on this package.

Three jobs:

| Job | Call | What happens on-chain |
|---|---|---|
| Create a ledger | `createLedger({ pub, wallet, table })` | Deploys ZkDB + BatchVerifier and the threshold gate + ClaimVerifier (4 contracts), makes `wallet` the writer of `table` |
| Write a batch | `ledger.writeBatch(changes)` | Queues each change (one tx each), proves up to 16 with the batch circuit (UltraHonk) and calls `submitBatch`; ZkDB takes the new root only if the verifier accepts. A change that breaks the rules (subtract below zero, add overflow, set on a missing row) is marked rejected inside the proof and the rest lands |
| Prove a threshold | `ledger.addThreshold(table, min, name)` then `proveThreshold(id, secret)`, `checkThreshold(claim)`, `submitThreshold(claim)` | The proof says "a row of this table whose key is Poseidon2(secret) has at least `min`" without saying which row. `checkThreshold` is a free `eth_call` against the verifier; `submitThreshold` records the claim's nullifier so the same row cannot claim the same threshold twice |

## Quickstart (about 5 minutes)

Needs Node 20+ and [Foundry](https://getfoundry.sh). The compiled circuits and verifiers are in the repo; no Noir toolchain needed.

```bash
git clone <this repository> zkdb && cd zkdb
git submodule update --init && npm ci
npm run quickstart -w @zkdb/sdk
```

It starts its own anvil, runs [`examples/quickstart.ts`](examples/quickstart.ts) and prints something like:

```
1. ledger ZkDB 0xe7f1…, gate 0xcf7e…
2. batch proven in 2062 ms, accepted on-chain: 0x621a…; per change ok = true,true,false
3. claim proven in 231 ms; on-chain check: {"valid":true}
   recorded: 0x6e63…; a second use is refused: {"valid":false,"reason":"AlreadyClaimed"}
   Bob cannot prove it: Balance 40 is below 100.
```

On Avalanche Fuji instead of anvil: `RPC_URL=https://avalanche-fuji-c-chain-rpc.publicnode.com PRIVATE_KEY=0x… npm run quickstart -w @zkdb/sdk` (the key needs about 0.1 test AVAX; never commit it).

## The code

```ts
import { createLedger, newSecret, ready, rowOf, BALANCE_FIELD } from '@zkdb/sdk';

await ready();                                            // loads Poseidon2
const ledger = await createLedger({ pub, wallet, table: 1n });

const alice = newSecret();                                // stays with Alice; the ledger stores Poseidon2(alice)
const { queued } = await ledger.writeBatch([{ insert: { table: 1n, fields: rowOf(1n, 0n, alice) } }]);
const row = queued.rowIds[0]!;
await ledger.writeBatch([{ add: { row, field: BALANCE_FIELD, amount: 120n } }]);

const t = await ledger.addThreshold(1n, 100n, 'at least 100');
const claim = await ledger.proveThreshold(t, alice);      // local, zero-knowledge
await ledger.checkThreshold(claim);                       // { valid: true }, free
await ledger.submitThreshold(claim);                      // recorded once
```

Open an existing ledger with `attachLedger({ pub, wallet, address, gate, fromBlock })`. Anyone can call `proveAndSubmit()`: the proof is the permission.

## Limits (true today)

- Row layout for thresholds is fixed by the claim circuit: `[id, balance, key, x, x, x]`, with `key = Poseidon2(secret)`. Other fields are free for your app; the threshold only reads field 1.
- One kind of private query: "at least N" on one row. No proven sums, ranges, counts or top-N yet. Everything written is public.
- Rows are 6 field elements; a ledger holds up to 2^20 rows; a batch holds 16 changes.
- `writeBatch` sends one transaction per change, then one per batch proof. On an audited table, SET/SUB/DELETE need the auditor (`proposeChange` / `approveChange` on ZkDB); the SDK does not wrap that yet.
- Proving runs in the same Node process (bb.js). A batch took about 2 s and a claim about 0.2 s on an M-series laptop.
- `loadArtifacts()` reads `contracts/out`, so the package is used from this repo; it is not published to npm.
- The contracts are the same ones the club app uses (`ZkDB.sol`, `PointsGate.sol`); the gate's names (perk, minPoints) are the club's words for "threshold".
