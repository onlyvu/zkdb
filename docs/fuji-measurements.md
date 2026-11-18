# Measured on Avalanche Fuji

Written by `npm run deploy:fuji -w @zkdb/dashboard` on 2026-11-18.

- ZkDB [0x1dd3f88db29ee55e66b8db243c99c5b7fc0ea91c](https://testnet.snowtrace.io/address/0x1dd3f88db29ee55e66b8db243c99c5b7fc0ea91c), BatchVerifier [0xf5100724394b96775a74950452e6565f78c7ec5d](https://testnet.snowtrace.io/address/0xf5100724394b96775a74950452e6565f78c7ec5d)
- PointsGate [0xe68736b7dc375a90635dec5b07e09838f4fc4c33](https://testnet.snowtrace.io/address/0xe68736b7dc375a90635dec5b07e09838f4fc4c33), ClaimVerifier [0xa6728051568ccf503e57ee5ba579a7ae8a4ab4a5](https://testnet.snowtrace.io/address/0xa6728051568ccf503e57ee5ba579a7ae8a4ab4a5)
- RootRelay [0x497e8189dc2d2cc07712f448f51fbe708e2e306f](https://testnet.snowtrace.io/address/0x497e8189dc2d2cc07712f448f51fbe708e2e306f) (sends to `0x2f082666e799E4E999a0A9DC9Ee017179DcF8A6e` on Dispatch L1, where RootMirror is not deployed yet)

"Receipt after" is the time from broadcasting the transaction to having its receipt (polled every 250 ms).
"In a block after" is the time from sending the transaction to the millisecond timestamp of the block that included it; it compares the deploying machine's clock with the validators'.
"Proved in" is UltraHonk proof generation with bb.js on the deploying machine.
Fees are gas used × the price actually paid: 160 wei per gas, which is the Fuji base fee that day (10 wei) plus the wallet's 150 wei tip. The README prices the same gas at the C-Chain mainnet base fee.

| Transaction | Gas | Fee (AVAX) | Receipt after | In a block after | Proved in | Tx |
|---|---:|---:|---:|---:|---:|---|
| setWriter(treasurer) | 47837 | 7.654e-12 | 2926 ms | 1103 ms |  | [0x9aca7f2f…](https://testnet.snowtrace.io/tx/0x9aca7f2f26ba72866d0eede23e8182a58817ef7db85d60254fe5e7aabc645fa5) |
| setTableOwner(1) | 52271 | 8.363e-12 | 3022 ms | 1347 ms |  | [0xcc2a2877…](https://testnet.snowtrace.io/tx/0xcc2a2877fbdc7ebc8130ddf7adbd2ca1ed4983080a7a24fd5f2a58cf47eba35f) |
| setTableAuditor(1) | 50176 | 8.028e-12 | 2092 ms | 583 ms |  | [0x1588c52c…](https://testnet.snowtrace.io/tx/0x1588c52cfb22fba69c23f68792965a7adbea61ddd9d8e5e43e96de338b0a8b72) |
| addPerk(Priority event ticket, ≥500) | 114987 | 1.840e-11 | 3009 ms | 1446 ms |  | [0xc021d2f6…](https://testnet.snowtrace.io/tx/0xc021d2f608ed0880e6ab197ba38a50b9fe012daf312d3fd9786abbd525698062) |
| addPerk(Volunteer certificate, ≥250) | 97875 | 1.566e-11 | 3575 ms | 1404 ms |  | [0xbf8db6b0…](https://testnet.snowtrace.io/tx/0xbf8db6b0f95006beea167301e0fa8dd61fe3da70aea4c66afa234d0c78b38956) |
| insert card 42 | 124778 | 1.996e-11 | 2100 ms | 787 ms |  | [0x55465c56…](https://testnet.snowtrace.io/tx/0x55465c56bfd0dfc6deff1df519869f749e9f3aac22ff5b1d2f99df5cca18b20d) |
| insert card 107 | 90578 | 1.449e-11 | 2542 ms | 1439 ms |  | [0x3d326c70…](https://testnet.snowtrace.io/tx/0x3d326c70cbc6fc78460f1e4a202104c6bcb7bc642d899c50aafb549d21a8f56c) |
| insert card 215 | 90578 | 1.449e-11 | 2533 ms | 548 ms |  | [0x779e7473…](https://testnet.snowtrace.io/tx/0x779e74736b0bc48cb3e42323bfbbc7016568800171b45faef3e3b1c052b72acf) |
| insert card 333 | 90590 | 1.449e-11 | 2096 ms | 381 ms |  | [0xf4c9d5d1…](https://testnet.snowtrace.io/tx/0xf4c9d5d138f4fe1ec81674fb30f3e7ff989731111b45828bd50fe6f78dd6e37b) |
| insert card 518 | 90590 | 1.449e-11 | 2052 ms | 452 ms |  | [0x8ca31d2d…](https://testnet.snowtrace.io/tx/0x8ca31d2d4d35881be51e28a240039fae2169dec21521db080e1838b22af32195) |
| insert card 604 | 90590 | 1.449e-11 | 2964 ms | 581 ms |  | [0xad5d0002…](https://testnet.snowtrace.io/tx/0xad5d0002648197b81ab01c90834dfd2a762384ac02a4583d13f795dad25fb9ea) |
| insert card 731 | 90590 | 1.449e-11 | 2558 ms | 993 ms |  | [0x79a03453…](https://testnet.snowtrace.io/tx/0x79a03453b0a3a650b00d6690dd8dc3fc44fa64efe81383aed2d83ea302d0d2c2) |
| insert card 889 | 90590 | 1.449e-11 | 2083 ms | 400 ms |  | [0xa2565c81…](https://testnet.snowtrace.io/tx/0xa2565c8197d5683e718b008a5f8058477ce3a9fc0a37d757b072760570f8c999) |
| award 400 card 42 | 67502 | 1.080e-11 | 2924 ms | 584 ms |  | [0x76a12aeb…](https://testnet.snowtrace.io/tx/0x76a12aebd90955833afae1b2c5d5889cbbf44244d157919b0576c6b72da9a230) |
| award 300 card 107 | 67514 | 1.080e-11 | 2092 ms | 624 ms |  | [0xaa46adcc…](https://testnet.snowtrace.io/tx/0xaa46adcc1e22095f9eb5fdb4c8b38ae6a72887001aa00182b144b2ab864a977d) |
| award 600 card 215 | 67514 | 1.080e-11 | 2071 ms | 576 ms |  | [0xbd34e3e8…](https://testnet.snowtrace.io/tx/0xbd34e3e8c551134cf04b98e6404d6f1d3f98507665633edd26b4b1bcac2ff37c) |
| award 150 card 333 | 67502 | 1.080e-11 | 2544 ms | 657 ms |  | [0x46ea621c…](https://testnet.snowtrace.io/tx/0x46ea621c6b97acc63f7d3d895028bb7e1182d3cffdf347b4a2c709356528d63d) |
| award 250 card 518 | 67502 | 1.080e-11 | 2079 ms | 474 ms |  | [0x0a1fb51f…](https://testnet.snowtrace.io/tx/0x0a1fb51f657c48145de159eaefbbda6fa9edda1365b73511b19a76a9b47fa629) |
| award 500 card 604 | 67514 | 1.080e-11 | 2131 ms | 559 ms |  | [0x32e5a34e…](https://testnet.snowtrace.io/tx/0x32e5a34eaca44d4e913bd76b2e36aa7b264dc67f4db47052d9428cd9f7a6aec7) |
| award 700 card 731 | 67514 | 1.080e-11 | 2083 ms | 502 ms |  | [0x5e1bb4ea…](https://testnet.snowtrace.io/tx/0x5e1bb4eade00bc009860305aff672ac16886f1476ef536c877122bde586fd56e) |
| award 550 card 889 | 67514 | 1.080e-11 | 3012 ms | 1365 ms |  | [0xaafdf536…](https://testnet.snowtrace.io/tx/0xaafdf53647943f3ed0a15944c3cb6296373c871853974b4e718fb4520ef09bdb) |
| submitBatch #1 (16 ops) | 1176630 | 1.883e-10 | 2554 ms | 732 ms | 957 ms | [0xf54ab96c…](https://testnet.snowtrace.io/tx/0xf54ab96ce9fc38d5f4c3291a3dbd2d49749b676821d6548c8ce5972b14b54c98) |
| relay root #1 over ICM | 161297 | 2.581e-11 | 2582 ms | 595 ms |  | [0x59ec08c1…](https://testnet.snowtrace.io/tx/0x59ec08c177788f74c0c4ac6dfb15073c944e70ffcdfb62f2c0069bde10fed5e7) |
| award 450 card 42 | 67502 | 1.080e-11 | 2536 ms | 1073 ms |  | [0x18442015…](https://testnet.snowtrace.io/tx/0x18442015d0a7882f8557f4f5d67206d60c06eb7bc63fa929a8489184b2209347) |
| award 400 card 42 | 67502 | 1.080e-11 | 2077 ms | 595 ms |  | [0x37bcf557…](https://testnet.snowtrace.io/tx/0x37bcf55779e9735d8dca7397a78a3759ff24d996da50db78f8180ce6377b715f) |
| award 250 card 107 | 67502 | 1.080e-11 | 2984 ms | 677 ms |  | [0xe5ef0900…](https://testnet.snowtrace.io/tx/0xe5ef0900af12ba79e7a1700e95f320636fb8f513cded644af1e75e1896ad5990) |
| award 300 card 518 | 67514 | 1.080e-11 | 2123 ms | 543 ms |  | [0xa98b284f…](https://testnet.snowtrace.io/tx/0xa98b284f5c8442eef4dab40631445e953bc44c02c8d6b131d95b951e1623d7b5) |
| propose redeem 100 card 215 | 106878 | 1.710e-11 | 2574 ms | 995 ms |  | [0x0a1dcdaa…](https://testnet.snowtrace.io/tx/0x0a1dcdaa06f444c4101792276ec81776c468b19ae60af8e8884fd5b558d6a19d) |
| approve #0 (auditor) | 73559 | 1.177e-11 | 3026 ms | 452 ms |  | [0x85682972…](https://testnet.snowtrace.io/tx/0x85682972991256a1bd1c908f06b000f35f98115aaab53e659094794cc53e7efc) |
| propose redeem 200 card 333 | 89778 | 1.436e-11 | 2064 ms | 598 ms |  | [0x34199d0c…](https://testnet.snowtrace.io/tx/0x34199d0cf00641f1cae0c5ff52e54ed49b235eceabc29be4374df05725be631f) |
| approve #1 (auditor) | 73571 | 1.177e-11 | 2076 ms | 532 ms |  | [0xf539da04…](https://testnet.snowtrace.io/tx/0xf539da04f1f48181fce381df72fca0a4e94a2df37546310caee7a74869430cd8) |
| submitBatch #2 (6 ops) | 1086168 | 1.738e-10 | 2559 ms | 1182 ms | 913 ms | [0x91d9dea8…](https://testnet.snowtrace.io/tx/0x91d9dea8e424a7913fe12cfdbe9b31823c4d123270164b22e43cb8fef88b2655) |
| relay root #2 over ICM | 144197 | 2.307e-11 | 2542 ms | 1210 ms |  | [0xd4b59cdd…](https://testnet.snowtrace.io/tx/0xd4b59cdd39e6706bba37e4b124eb85ec6cc538cb9964a2992446515c780923e6) |
| claim "Priority event ticket" (ZK, card hidden) | 852392 | 1.364e-10 | 2049 ms | 709 ms | 230 ms | [0xbf92b577…](https://testnet.snowtrace.io/tx/0xbf92b5772f620a4c2a28a1d088965c456976a69784170e4f21617fbe504bb5be) |
| collect with the pickup code (desk) | 29560 | 4.730e-12 | 2080 ms | 577 ms |  | [0x52d9bfec…](https://testnet.snowtrace.io/tx/0x52d9bfec14f46e9c5cd1875accd07166a120ab0a2288c061dac90adcf2c7ef99) |
| propose card 42 → 250 | 89749 | 1.436e-11 | 2528 ms | 562 ms |  | [0x550a7469…](https://testnet.snowtrace.io/tx/0x550a7469a9c2af5454b0d71027235af97eafcff77d338d31e8fb0a90e4d462f2) |
| approve #2 (auditor) | 73559 | 1.177e-11 | 2558 ms | 881 ms |  | [0xa0547c84…](https://testnet.snowtrace.io/tx/0xa0547c84b5a1e03772022aa2db7e72a88e5483d07fd9cc1a51410a276a1ae2d2) |
| propose redeem 500 card 42 | 89778 | 1.436e-11 | 2080 ms | 692 ms |  | [0x1d6a4a44…](https://testnet.snowtrace.io/tx/0x1d6a4a4430339cf67397c2feaa8cd55489b41c3ebdf182af4d9b11901a863856) |
| approve #3 (auditor) | 73571 | 1.177e-11 | 3031 ms | 1390 ms |  | [0xde528c64…](https://testnet.snowtrace.io/tx/0xde528c64f509e1dd098d1471f492111b64796f0088718d60e0812df771102176) |
| submitBatch #3 (2 ops) | 1051181 | 1.682e-10 | 2988 ms | 850 ms | 1250 ms | [0x89025c76…](https://testnet.snowtrace.io/tx/0x89025c76b5ecc76f674f856b2c2b1ca20ffd109593b197339889c4f03dffe5cb) |
| relay root #3 over ICM | 144197 | 2.307e-11 | 2064 ms | 735 ms |  | [0xfb2051b1…](https://testnet.snowtrace.io/tx/0xfb2051b1c2b29a87cff8f313e7dd1a6f2f5cdddba3e6266578d86837d6224832) |
