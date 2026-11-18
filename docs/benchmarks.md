# zkDB benchmarks

Machine: arm64, Apple M2 Max, 12 cores, 64 GiB RAM. Toolchain: nargo 1.0.0-rc.5, bb 5.0.0, solc 0.8.30 (optimizer 200 runs, `via_ir = false`, see the note), forge 1.8.5. On-chain gas is from Fuji receipts, linked in [fuji-measurements.md](fuji-measurements.md).

## Circuits

| | Batch (`circuits/batch`, K = 16) | Claim (`circuits/claim`) |
|---|---:|---:|
| ACIR opcodes (`bb gates -b circuits/target/<name>.json`) | 5,952 | 125 |
| Gates (`circuit_size`) | 110,200 (padded to 2^17) | 6,256 (padded to 2^13), measured before the pickup input was added |
| Public inputs | 162 | 6 (the pickup hash added on 19 Nov) |
| Proof size | 9,152 bytes | 7,616 bytes |
| Prove time, bb.js in Node | about 0.9 to 1.5 s (server, Fuji runs) | about 0.17 s (`npm run gen:fixture -w @zkdb/core`) |
| Prove time, bb.js in a browser | not used | 3.5 to 4.0 s on first use, measured in headless Chromium, including loading the prover |

## Contracts

| Contract | Runtime bytes (limit 24,576) | Initcode bytes |
|---|---:|---:|
| `ZkDB` | 7,013 | 7,209 |
| `BatchVerifier` | 16,572 | 16,600 |
| `PointsGate` | 3,689 | 3,904 |
| `ClaimVerifier` | 15,727 | 15,755 |
| `RootRelay` | 1,517 | 1,784 |
| `RootMirror` | 931 | 1,151 |

`cd contracts && forge build --sizes` prints these.

## Gas on Fuji

| Call | Gas |
|---|---:|
| `insert` (a member joins) | 90,578 to 90,590; 124,778 for the first row |
| `enqueue` (award) | 67,502 to 67,514 |
| `proposeChange` (redemption or correction) | 89,749 to 106,878 |
| `approveChange` | 73,559 to 73,571 |
| `submitBatch`, 2 ops | 1,051,097 to 1,051,181 |
| `submitBatch`, 6 ops | 1,086,168 |
| `submitBatch`, 16 ops | 1,176,630 |
| `PointsGate.claim` | 852,392 |
| `PointsGate.collect` (desk) | 29,560 |
| `RootRelay.relay` | 144,197; 161,297 the first time |

The same 16 changes on an ordinary-storage contract: [gas-comparison.md](gas-comparison.md).

## Notes

- `bb write_solidity_verifier --optimized` produces one contract per circuit with no libraries to link. The files are renamed `BatchVerifier` and `ClaimVerifier` by `scripts/build-circuits.sh` and are otherwise untouched.
- With `via_ir = true`, solc 0.8.30 fails on the optimized verifier with "Could not create stack layout after 1000 iterations". `via_ir = false` compiles it, so `contracts/foundry.toml` uses that.
- `submitBatch` grows by about 9,000 gas per real op (calldata, one keccak, one storage read). The rest is the verifier, which does the same work for any batch of this circuit.
- K = 16 was chosen because every contract stays under 24,576 bytes, `submitBatch` stays near 1.1 M gas, and proving takes about a second.
