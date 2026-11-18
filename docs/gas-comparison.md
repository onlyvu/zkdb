# Gas: a plain contract against zkDB

Written by `npm run gas:compare -w @zkdb/dashboard`. It starts a throwaway anvil chain, sends the same 16 changes
to both ledgers and reads `gasUsed` from every receipt. The zkDB batch carries a real UltraHonk proof.

- Plain: [`contracts/test/baseline/PlainLedger.sol`](../contracts/test/baseline/PlainLedger.sol). Balances in contract storage, one event per change with who, what, why and the balance after. A redemption above the balance is recorded as rejected.
- zkDB: [`contracts/src/ZkDB.sol`](../contracts/src/ZkDB.sol). Each change is queued in its own transaction, then one proof covers the batch.
- The 16 changes: 6 members join, 7 awards, 3 redemptions (one above the balance).

| | Plain contract | zkDB |
|---|---:|---:|
| join, average per change | 54,006 | 96,284 (queue only) |
| award, average per change | 47,341 | 67,503 (queue only) |
| redeem, average per change | 31,637 | 69,873 (queue only) |
| 16 changes | 750,342 | 1,259,849 (queue) |
| One proof for the batch (`submitBatch`) | 0 | 1,183,860 |
| **Total for 16 changes** | **750,342** | **2,443,709** |
| **Per change** | **46,896** | **152,731** |

So at 16 changes zkDB costs 3.3 times the gas of the plain contract.

## Does a bigger batch change the answer?

Not in this design. Queueing a change costs about 78,740 gas on its own, which is already more than the 46,896 the plain contract needs to apply it. The proof only adds to that, whatever the batch size.

The queue is expensive because every change is its own transaction (21,000 gas before anything runs) and stores a hash. A design that posts the changes only once, inside `submitBatch`, would pay per change roughly what `submitBatch` already pays for each extra one:

| Measured on Fuji ([fuji-measurements.md](fuji-measurements.md)) | Gas |
|---|---:|
| `submitBatch` with 2 changes ([tx](https://testnet.snowtrace.io/tx/0x89025c76b5ecc76f674f856b2c2b1ca20ffd109593b197339889c4f03dffe5cb)) | 1,051,181 |
| `submitBatch` with 16 changes ([tx](https://testnet.snowtrace.io/tx/0xf54ab96ce9fc38d5f4c3291a3dbd2d49749b676821d6548c8ce5972b14b54c98)) | 1,176,630 |
| Each extra change inside a batch: (1,176,630 − 1,051,181) / 14 | about 9,000 |
| Fixed cost of one proof: 1,051,181 − 2 × 9,000 | about 1,033,000 |

With those numbers a batch-only design would cost about 1,033,000 / n + 9,000 gas per change. That drops below the plain contract's 46,896 at about 28 changes per batch. The circuit here takes 16, so this is a calculation, not something we built or measured.

One more cost on the real ledger: the points table has an auditor, so a redemption or a correction there is two transactions (propose, then approve), about 163,000 gas before the proof. A plain contract with the same two-signer rule would pay for two transactions as well; the comparison above uses one signer on both sides.

## What the proof buys instead

Gas is not the reason for the proof. These three are:

1. A member can prove "a card in this ledger has at least N points" without showing which card ([`PointsGate.sol`](../contracts/src/PointsGate.sol), [`circuits/claim`](../circuits/claim/src/main.nr); 852,392 gas per claim, [tx](https://testnet.snowtrace.io/tx/0xbf92b5772f620a4c2a28a1d088965c456976a69784170e4f21617fbe504bb5be)). A plain contract can check a balance, but only by being told whose balance. The claim needs the state as a Merkle root that a circuit can open cheaply, which means a Poseidon2 tree.
2. Keeping that Poseidon2 root up to date by hand in the EVM would cost far more than the proof. One change needs the old path and the new path: 2 × 20 hashes. The cheapest public EVM implementation we know, [zemse/poseidon2-evm](https://github.com/zemse/poseidon2-evm), reports 20,304 gas per hash, so about 812,000 gas per change before leaf hashing and storage. This figure is calculated from that project's published gas report; we did not run it.
3. The root is 32 bytes for every balance at once. [`RootRelay.sol`](../contracts/src/icm/RootRelay.sol) sends it towards another Avalanche L1 over ICM for 144,197 gas per proof ([tx](https://testnet.snowtrace.io/tx/0xd4b59cdd39e6706bba37e4b124eb85ec6cc538cb9964a2992446515c780923e6)), and a gate there could check the same claims with no copy of the ledger. Today only the sending half exists on-chain: Teleporter on Dispatch receives each message and cannot execute it, because the receiving contract is not deployed (see the README).

If none of the three matters to a club, the plain contract is the better choice, and cheaper.
