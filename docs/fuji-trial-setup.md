# Try-it mode set up on Fuji

Written by `scripts/fuji-admin.ts` on 2026-11-21 22:41 UTC.

Trial key [`0x54e6d810C0f5d0B2B161C864C290cf251F70c372`](https://testnet.snowtrace.io/address/0x54e6d810C0f5d0B2B161C864C290cf251F70c372) writes table 900 of ZkDB [`0x1dd3f88db29ee55e66b8db243c99c5b7fc0ea91c`](https://testnet.snowtrace.io/address/0x1dd3f88db29ee55e66b8db243c99c5b7fc0ea91c); perk #2 on PointsGate [`0xe68736b7dc375a90635dec5b07e09838f4fc4c33`](https://testnet.snowtrace.io/address/0xe68736b7dc375a90635dec5b07e09838f4fc4c33) needs 100 points on that table.
The club table (1) is untouched: the trial key owns no other table, and the server refuses a trial table equal to the club table.

| Step | From | Gas | Transaction |
|---|---|---|---|
| fund trial key (0.004) | 0x6732CcE4… | 21000 | [0xad420276…](https://testnet.snowtrace.io/tx/0xad420276a1bcd7c1de70b8e3c33c4c80ba892b30b6396aa3135eb7787ac6996b) |
| setWriter(trial key) | 0x6732CcE4… | 47837 | [0xb665312c…](https://testnet.snowtrace.io/tx/0xb665312cd18b32f2946a94b76ad431ba52a2a261333571c51939001ec16f1b06) |
| setTableOwner(900, trial key) | 0x6732CcE4… | 52283 | [0x9a035117…](https://testnet.snowtrace.io/tx/0x9a0351172a70a6466423c61ff7600dcb0bf105f665744abf47d77f354ea389ed) |
| addPerk(table 900, ≥100) | 0x6732CcE4… | 97947 | [0xb036b2f9…](https://testnet.snowtrace.io/tx/0xb036b2f96495c6d16742c3b75971df448e668adcb9b36307b1036dc618c4794c) |
