# ZkDB ownership moved to a 2-of-3 governor with a timelock

Written by `scripts/fuji-admin.ts` on 2026-11-21 22:52 UTC.

ZkDB [`0x1dd3f88db29ee55e66b8db243c99c5b7fc0ea91c`](https://testnet.snowtrace.io/address/0x1dd3f88db29ee55e66b8db243c99c5b7fc0ea91c) is now owned by AdminGovernor [`0xc9578a6941a88c2b0cf00f48f2995f37e107621e`](https://testnet.snowtrace.io/address/0xc9578a6941a88c2b0cf00f48f2995f37e107621e): signers `0x8f80408202Fc7a2486D5a98834583B128B712D36`, `0x5CC8F91c2BCdE6D744ecD5eE0ED2aBc33d885E47`, `0x5F975ad809dc8f782EDD44f9eff1bEFCf51249aD`, threshold 2, delay 120 s.
Turning the auditor rule off or on, adding or removing a writer, assigning a table and handing ownership on now need two signers and the delay; any one signer can cancel during the delay.
Limit: the three signer keys were made on one team machine for this run, so they show the mechanism, not three independent people.
Not covered: the batch verifier cannot be changed by anyone (it is immutable in ZkDB), and PointsGate's admin is an immutable single key that can only add perks.

| Step | From | Gas | Transaction |
|---|---|---|---|
| fund signer 1 (0.002) | 0x6732CcE4… | 21000 | [0x59159ebb…](https://testnet.snowtrace.io/tx/0x59159ebb71b82e9027fe7cf55724993114d5c6368e65d8d7644958f21a2de49b) |
| fund signer 2 (0.002) | 0x6732CcE4… | 21000 | [0xd99a30ef…](https://testnet.snowtrace.io/tx/0xd99a30ef044e12c81d2185ce96c940efd9b514cfdfaab708993db1193b27f588) |
| deploy AdminGovernor | 0x6732CcE4… | 1442242 | [0xa6ba4c8b…](https://testnet.snowtrace.io/tx/0xa6ba4c8b20ea2d19548e8d27ea570041cc5c4fb5a97027f9deeb21422c7a5f88) |
| ZkDB.transferOwnership(governor) by the old owner key | 0x6732CcE4… | 47781 | [0x68fc7008…](https://testnet.snowtrace.io/tx/0x68fc70084e8cc959356590f72b8bad2a3c91961d4253a0f0227e586a09dcb021) |
| governor.propose(acceptOwnership) #0 by signer 1 | 0x8f804082… | 167958 | [0x799aa34e…](https://testnet.snowtrace.io/tx/0x799aa34e463a658185fb0958be1f4c907fb624b2ddeecfb0da8a6a32de4b1500) |
| execute with 1 of 2 signatures | (simulated, no transaction) | — | refused: `NotReady` |
| governor.approve #0 by signer 2 | 0x5CC8F91c… | 62717 | [0x9a8765e0…](https://testnet.snowtrace.io/tx/0x9a8765e0e14b0be41bf4317cb247a46393912291bc36786c04fca938739f9cbf) |
| execute before the delay | (simulated, no transaction) | — | refused: `NotReady` |
| governor.execute #0: ZkDB.acceptOwnership | 0x8f804082… | 55210 | [0x1f2901b8…](https://testnet.snowtrace.io/tx/0x1f2901b8348453c92eb93bb6271510118bdeb66180428fed646a3222adcbb4c2) |
| old owner key: setTableAuditor(1, 0) | (simulated, no transaction) | — | refused: `NotOwner` |
| one signer: setTableAuditor(1, 0) directly | (simulated, no transaction) | — | refused: `NotOwner` |
