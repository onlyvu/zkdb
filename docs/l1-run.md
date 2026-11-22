# The school L1: ICM both ways, run

zkDB's own Avalanche L1 `zkdb` (chainId 510102, token ZKD, blockchainID `272pDkC2CtfGT5kMktHTCNi7homXticaHaf1bJyfkgk5BLzTiU`, subnetID `23UCnnKWGoJTeAf1Uzqjo5RBvoyJ2sYQ7UMqviBcTuYqUJPL97`) talks to the Fuji C-Chain over ICM (Teleporter) in both directions. Written by `npm run flow:l1 -w @zkdb/dashboard`; the raw record is [l1-runs.json](l1-runs.json).

- Fuji → L1: RootRelay reads the root ZkDB accepted with a batch proof and sends it; Teleporter on the L1 calls RootMirror, which takes it only from that relay on the C-Chain.
- L1 → Fuji: a member's zero-knowledge claim ("a card in this root has at least N points") is checked on the L1 by PointsGate against RootMirror; ClaimForwarder sends a receipt (perk id, nullifier, pickup hash, threshold, root). Teleporter on Fuji calls ClaimRegistry, which takes it only from that forwarder on the zkdb L1 and records each nullifier once per perk. A C-Chain desk then redeems the perk once with the member's pickup code.

## Why the school has its own L1

The school runs the validator and the fee token (ZKD), so students never hold or pay AVAX: the claim relayer pays each claim in ZKD from the school's genesis allocation. Claims are checked and nullifiers spent on the school chain; only a 32-byte root comes in and a small receipt goes out over ICM, so any Avalanche chain can honour a claim without the club's data or trusting the club's server. In this deployment the ledger itself (ZkDB and its batch proofs) stays on the Fuji C-Chain as the public anchor; the L1 is where the root is used.

Since 21 Nov 2026 01:26 VN (unix 1795199165) a network upgrade turns on two precompiles: only wallets on the TxAllowList may send transactions and only the school may deploy contracts ([l1/README.md](../l1/README.md), demo in [l1-permissions.md](l1-permissions.md)). Runs from 3 on are after the upgrade; in run 3 the claim was sent by a claim relayer the school admin enabled that night.

Limits: one validator (a team server, proof of authority, the PoA owner is a team key), a public RPC that only reads (https://zkdb-rpc.vuvietanh.com) and no block explorer, the validator's P-Chain balance needs topping up about once a day, no fee manager or native minter. A nullifier is per card and perk id, not per gate, and each gate keeps its own spent set, so the same claim can be made once per chain: a card can claim perk #0 on the Fuji gate and again on the L1 gate (same nullifier on both: the card stays hidden; the two claims are linkable). The L1 gate also accepts a claim against the last root that was relayed, which can be older than the one ZkDB holds. The dashboard's claim relayer declines to send such claims itself, which prevents nothing: anyone can call the Fuji gate directly. The contract fix is designed and not deployed ([README, Limits](../README.md#limits)). The runs below use perk #1 on the L1 for cards that claimed perk #0 on Fuji.

"Executed" means the receive transaction on the destination has Teleporter's `MessageExecuted` event for the message (not `MessageExecutionFailed`). Fuji transactions open on the explorer; L1 transactions can be read through the L1's public RPC (the dashboard's School L1 page opens them), and every L1 → Fuji receive on Fuji carries a Warp message signed by the L1 validator.

## Runs

| Run | Direction | What | Sent | Delivered | Received |
|---|---|---|---|---|---|
| 1 | Fuji → L1 | RootRelay sends root #6 | [0x5530c4ac…](https://testnet.snowtrace.io/tx/0x5530c4ace93cae3a5e22eddb9f4f4f682559f410ec700fd51b3ec90d239acd3c) | Teleporter on the L1 runs RootMirror: **executed**, within 2 s of the send's receipt | `0x05a63212958754b866837ea9ad228cc67488e8e786e090353b8de92715305750` |
| 1 | L1 → Fuji | Claim for perk #1 (at least 250) checked on the L1, receipt sent | `0xcc926e33928a8cc872df8a230351ef39a13fdc8256bf0b280f5688c631ed2f83` | Teleporter on Fuji runs ClaimRegistry: **executed**, within 6 s of the send's receipt | [0xade15d1c…](https://testnet.snowtrace.io/tx/0xade15d1cec499bd54ce83865b86498e315d93d38c16ea8d58a23d7b7cebcfcae) |
| 1 | Fuji | Perk redeemed with the one-time code | [0x9a570a9f…](https://testnet.snowtrace.io/tx/0x9a570a9fab146f0cc792e267f0f366ca8bb6e65a9cfeecf87f69d2f8d6554f06) | ClaimRegistry: pickup marked redeemed | |
| 2 | Fuji → L1 | RootRelay sends root #7 | [0x49b977f5…](https://testnet.snowtrace.io/tx/0x49b977f507ad8177944dddcc47b33660f34bafb949e973dd682aa96cf5da550f) | Teleporter on the L1 runs RootMirror: **executed**, within 1 s of the send's receipt | `0x9cb9ffd550eb14a2795a03da7c4c1c51a9ef6d659c316c67c45c0b926fd91214` |
| 2 | L1 → Fuji | Claim for perk #1 (at least 250) checked on the L1, receipt sent | `0xbaa489dab7b4084d376026d726724f5b2ee020de846baa6672847bd588d17e49` | Teleporter on Fuji runs ClaimRegistry: **executed**, within 4 s of the send's receipt | [0xb6990204…](https://testnet.snowtrace.io/tx/0xb69902046ef18bcd591b38a823805cfe90e96a6170069db94eb82e53abc8439e) |
| 2 | Fuji | Perk redeemed with the one-time code | [0x2f95848c…](https://testnet.snowtrace.io/tx/0x2f95848c329952305b4a98fbffb2425039106a4264d070ba89d3d8fcc618c0f7) | ClaimRegistry: pickup marked redeemed | |
| 3 | Fuji → L1 | RootRelay sends root #8 | [0x81d13b6c…](https://testnet.snowtrace.io/tx/0x81d13b6c4dc9f0b717279bf141fd6330723c9621be460381d6a1409a487d44fc) | Teleporter on the L1 runs RootMirror: **executed**, within 2 s of the send's receipt | `0xfd7e0c122321603ec7c3b67693431da9676d744558ce270c1acf896c34cd0b0c` |
| 3 | L1 → Fuji | Claim for perk #1 (at least 250) checked on the L1, receipt sent (relayer `0x23EE…`) | `0x4a2344dc68efe65ee016cbaf249c381f78279b5bcdc80ff984ad1c2b55cb77d5` | Teleporter on Fuji runs ClaimRegistry: **executed**, within 10 s of the send's receipt | [0x222511e3…](https://testnet.snowtrace.io/tx/0x222511e3ad45f3ff720af25122e8c94697e1bf843d94ba16b95bec275623485d) |
| 3 | Fuji | Perk redeemed with the one-time code | [0x0d7b005d…](https://testnet.snowtrace.io/tx/0x0d7b005d5fda8551610a2218d1d2b09262e63e6e5454304ff0c0e34c196aa2cc) | ClaimRegistry: pickup marked redeemed | |

After run 3 (2026-11-20 18:32 UTC): RootMirror holds batch #8, the same root as `ZkDB.root()` on Fuji; ClaimRegistry on Fuji holds 3 receipt(s).

## Contracts

| Chain | Contract | Address | Deploy tx | Gas |
|---|---|---|---|---|
| Fuji C-Chain | RootRelay (ZkDB root to the zkdb L1) | [`0x1335af7535aee69c7253f22dea3b6b214891f6e5`](https://testnet.snowtrace.io/address/0x1335af7535aee69c7253f22dea3b6b214891f6e5) | [0xe1093fc1…](https://testnet.snowtrace.io/tx/0xe1093fc1b00ee1abf1f483de1bfef35f65a70414f140c502de79450448c34156) | 383,828 |
| Fuji C-Chain | ClaimRegistry (claim receipts from the L1) | [`0xfab45908d9309ee508fa4e9a79437f47e1396d38`](https://testnet.snowtrace.io/address/0xfab45908d9309ee508fa4e9a79437f47e1396d38) | [0x4714a492…](https://testnet.snowtrace.io/tx/0x4714a4921aaea9a07c063cb34c75565ab6b3867af74c625b3ad7d5b184f386d6) | 544,180 |
| zkdb L1 | RootMirror | `0x744e2be19b816f280e35ae441e6ba51f7b5d4c78` | `0xdd279ca67374c4f6c92826e511da2352951d677d33dd8a22407f058b1d8e260b` | 257,034 |
| zkdb L1 | ClaimVerifier (UltraHonk, claim circuit) | `0xa469888cdfa2ffad68a9babbd92d29d95c577c36` | `0x3cc37378e40d964a7fa2ca4bc6044292f67be6b7af5ca020e5d31dbc806a5ed9` | 3,453,175 |
| zkdb L1 | PointsGate (reads RootMirror) | `0xcc825630337f42d757537e19250e7051cf6a0a67` | `0xe8e44c6de231309aa241aab692dc1463043ef9d0cd6484aa2fe797ceca4df116` | 852,800 |
| zkdb L1 | ClaimForwarder | `0xc1e48ee74410eab7508da2e1227d26afb8721686` | `0x4c8c7b709d259e53ed5a275962d46493260fd844fca9cba60696f6b2196a7b39` | 580,063 |

The ClaimVerifier on the L1 is the same UltraHonk verifier as on Fuji (15.7 KB of runtime code, 3.45M gas to deploy, under the L1's 30M block gas limit). A claim on the L1 costs about 1.0M gas, paid in ZKD by the claim relayer; the member pays nothing.

## Check it

```bash
RPC=https://avalanche-fuji-c-chain-rpc.publicnode.com
cast call 0xfab45908d9309ee508fa4e9a79437f47e1396d38 "count()(uint256)" --rpc-url $RPC   # receipts recorded on Fuji
cast call 0x1335af7535aee69c7253f22dea3b6b214891f6e5 "lastRelayedBatch()(uint64)" --rpc-url $RPC
# the L1 is converted, with its validator (public P-Chain API):
curl -s -X POST -H 'content-type:application/json' --data '{"jsonrpc":"2.0","id":1,"method":"platform.getSubnet","params":{"subnetID":"23UCnnKWGoJTeAf1Uzqjo5RBvoyJ2sYQ7UMqviBcTuYqUJPL97"}}' https://api.avax-test.network/ext/bc/P
# on the L1, through its public read-only RPC:
cast call 0x744e2be19b816f280e35ae441e6ba51f7b5d4c78 "batchNo()(uint64)" --rpc-url https://zkdb-rpc.vuvietanh.com
```
