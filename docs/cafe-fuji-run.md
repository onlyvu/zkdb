# Café stamp card on Fuji (second app on @zkdb/sdk)

Written by `npm run cafe -w @zkdb/example-cafe -- fuji` on 2026-11-21 22:42 UTC.

Café ledger ZkDB [`0xe0cd8ecef235219cae14ced3fea30293932b41d2`](https://testnet.snowtrace.io/address/0xe0cd8ecef235219cae14ced3fea30293932b41d2), reward gate [`0x41a0b367d1897478aae5be116a23b26b77e74eb5`](https://testnet.snowtrace.io/address/0x41a0b367d1897478aae5be116a23b26b77e74eb5). Its own contracts, separate from the club's.

| Step | Transaction |
|---|---|
| card 101 issued (Linh) | [0xf2464004…](https://testnet.snowtrace.io/tx/0xf2464004d7081f91dabc87dc9482747b7aea02040cb7bdd0985df72e03a74be8) |
| card 102 issued (Nam) | [0x6a5c1dbb…](https://testnet.snowtrace.io/tx/0x6a5c1dbb1d7f90704b7b3f837d60294eb64774f0c684a75db5f754ff5b5ff250) |
| stamps written (1/3) | [0x33385330…](https://testnet.snowtrace.io/tx/0x333853309e80ac21cc2f77ba3ad684704a30b31875d20338c95e76ed468dd260) |
| stamps written (2/3) | [0x266404b4…](https://testnet.snowtrace.io/tx/0x266404b47ae0af8168410584d3dece113b46566aa1909cd11a6b490c1c93f72b) |
| stamps written (3/3) | [0xd07a3626…](https://testnet.snowtrace.io/tx/0xd07a3626d57c0c112216db7532248ffda9b1d511f37d47cdaa1d83e361d13ae1) |
| batch proof accepted (5 changes, proved in 1175 ms, 1078135 gas) | [0x16eefbd4…](https://testnet.snowtrace.io/tx/0x16eefbd4355ba27a3dc2a1c22086a60bcf4b878be94a2bca8b7cebebcdedc292) |
| free coffee recorded (card not revealed) | [0x83cd5576…](https://testnet.snowtrace.io/tx/0x83cd5576a66f42a468c189f78d699c8017cb077d6a9897fb740e8c3dfd73e78f) |

Refused as expected (simulated, no transaction): the same card claiming again (`AlreadyClaimed`); a card with 4 stamps (no proof can be made).
