# The main flow, run on Fuji

Run on 2026-11-20 18:30 UTC by `npm run flow:fuji -w @zkdb/dashboard` against the live deployment (ZkDB [`0x1dd3f88db29ee55e66b8db243c99c5b7fc0ea91c`](https://testnet.snowtrace.io/address/0x1dd3f88db29ee55e66b8db243c99c5b7fc0ea91c), PointsGate [`0xe68736b7dc375a90635dec5b07e09838f4fc4c33`](https://testnet.snowtrace.io/address/0xe68736b7dc375a90635dec5b07e09838f4fc4c33), RootRelay [`0x497e8189dc2d2cc07712f448f51fbe708e2e306f`](https://testnet.snowtrace.io/address/0x497e8189dc2d2cc07712f448f51fbe708e2e306f)). Three separate test accounts sign: the treasurer, the auditor and the claim relayer. Every row below is a Fuji transaction.

Card #0892 is a new member made for this run, so the seeded demo cards are untouched. Its secret was made on the machine running the script; only its Poseidon2 hash went on-chain.

| Step | What happened |
|---|---|
| Add and award | #0892 joins and gets 600 points, then 450 that should have been 45 |
| Correction | The treasurer proposes overwriting 1,050 with 645; it enters the queue only when the auditor co-signs |
| Redemptions | 100 points (co-signed, accepted) and 5,000 points (co-signed, more than the balance) |
| Proof #8 | 6 changes proven in 1.0 s with bb.js; the verifier contract accepted it and ZkDB stored the new root. The 5,000-point redemption is marked rejected in the proof (op index 5), so the balance stays 545 |
| ICM | RootRelay sent the root to Dispatch L1. Teleporter there had received it within 2 s of the send's receipt ([receive tx on Dispatch](https://subnets-test.avax.network/dispatch/tx/0x8c5e36713ee5a77c2d376566f9104257b4ebda6719c9ba2e2410b09c1fe149df)) and stored it unexecuted, because RootMirror is not deployed on Dispatch. Message ID `0x0c21fc5926c88a3aa2e0f0423333e6c2c6be75e56789a417cbc45a501b8900fd` |
| Claim | Proven in 0.2 s: "a card in this root has at least 500 points". The relayer sent it; PointsGate checked it against `ZkDB.root()`. The transaction does not contain the card number |
| Collect | The perk is handed out once, against the one-time pickup code |

| Transaction | Gas | Fee (AVAX) | Receipt after | In a block after | Proved in | Tx |
|---|---:|---:|---:|---:|---:|---|
| add member #0892 (enrol code only) | 90590 | 1.449e-11 | 2324 ms |  |  | [0x90d41d11…](https://testnet.snowtrace.io/tx/0x90d41d11bd71ae4c23205f28c785cc25a25ed3f44b3b623bab6fbb0721e9f128) |
| award 600 (volunteer) | 67514 | 1.080e-11 | 3360 ms |  |  | [0xf6f85846…](https://testnet.snowtrace.io/tx/0xf6f8584689aa1e5d4e5f1483ba0b099569568004d0400226a454c166e1dec4d2) |
| award 450 (blood) | 67514 | 1.080e-11 | 2397 ms |  |  | [0xce8b418e…](https://testnet.snowtrace.io/tx/0xce8b418e27a8002595591a9ae80dd905a8bf1e2e65c09f3bb55c3b20c318f6c1) |
| propose correction 1,050 → 645 | 89773 | 1.436e-11 | 2109 ms |  |  | [0x3e72b6cc…](https://testnet.snowtrace.io/tx/0x3e72b6ccdf5fc0de5b12652fbc342ccc55f3a14a47cabff6cb92fc26c4adf22c) |
| co-sign proposal #14 (auditor) | 73583 | 1.177e-11 | 3348 ms |  |  | [0x09f997a2…](https://testnet.snowtrace.io/tx/0x09f997a2bd2b70bf05c26b3b1046327db2993d9cbf5a115625484e99d288e232) |
| propose redeem 100 (shirt) | 89778 | 1.436e-11 | 2212 ms |  |  | [0x1502783e…](https://testnet.snowtrace.io/tx/0x1502783e24266e1d3296c4fa9b5814f9b6ab74b6c9984e4f6bd0ea5b8b897cde) |
| co-sign proposal #15 (auditor) | 73571 | 1.177e-11 | 2330 ms |  |  | [0xbe880a6b…](https://testnet.snowtrace.io/tx/0xbe880a6bbad728d10ed0332bd2a4db7c7b19735cb32fe552614b6f2c7935b9de) |
| propose redeem 5,000 (more than the balance) | 89790 | 1.437e-11 | 1781 ms |  |  | [0xae67c500…](https://testnet.snowtrace.io/tx/0xae67c500a61792df8cf22bc05fff7b7d10178bc10bb811a5bc109bbcda8bf989) |
| co-sign proposal #16 (auditor) | 73583 | 1.177e-11 | 2407 ms |  |  | [0x4fb1fd23…](https://testnet.snowtrace.io/tx/0x4fb1fd23d95bfbe96677d83b3505631dae101d8e0fae0219e1377c9c958329f1) |
| submit proof #8 (6 changes) | 1086588 | 1.739e-10 | 2315 ms |  | 994 ms | [0xcebc3545…](https://testnet.snowtrace.io/tx/0xcebc3545b2f47098ed497398b220421921279a79791491ac56de382de54aa7af) |
| send root #8 to Dispatch L1 over ICM | 144197 | 2.307e-11 | 2924 ms |  |  | [0x01eacbc9…](https://testnet.snowtrace.io/tx/0x01eacbc9ef0eedbbc82fca2b428200c37f132d70f83f9cadb24276c3348a9686) |
| claim "Priority event ticket" (ZK, card hidden) | 852488 | 1.364e-10 | 1903 ms |  | 170 ms | [0x8231674e…](https://testnet.snowtrace.io/tx/0x8231674ec8e657f119ec98d2f6a88097a7643395f6defa622204c8df8e04c814) |
| collect the perk with the pickup code | 29560 | 4.730e-12 | 2410 ms |  |  | [0xf0d6459e…](https://testnet.snowtrace.io/tx/0xf0d6459e8d324a2667736842a2afc4ad52285f54b4b0e615ef390a76ad86ccb8) |

Signers: treasurer `0x8117DF62D48DA08AB3681967b59D0f10401C48e7`, auditor `0xb7AA39Ef07cD1e38dD952311b89Cc63E21680a31`, relayer `0x05441C5f1B367b6818064f6AA2c8a88d5906Ec2d`.

Total: 13 transactions, 2,828,529 gas, 4.526e-10 AVAX on Fuji (160 wei per gas: 10 wei base fee plus a 150 wei tip). At the C-Chain mainnet base fee of 7.5 nAVAX the same gas would cost 0.0212 AVAX (calculated, not paid).

State after the run: 46 changes, 8 proofs, and the dashboard's replay matches the contract root. Check it yourself:

```bash
RPC=https://avalanche-fuji-c-chain-rpc.publicnode.com
cast call 0x1dd3f88db29ee55e66b8db243c99c5b7fc0ea91c "batchCount()(uint64)" --rpc-url $RPC   # 8 or more
cast call 0xe68736b7dc375a90635dec5b07e09838f4fc4c33 "perk(uint256)((uint256,uint64,uint64,string))" 0 --rpc-url $RPC
```
