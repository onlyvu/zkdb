# Who may write to the school L1

Run on 2026-11-20 18:30 UTC by `npm run perms:l1 -w @zkdb/dashboard` against the zkdb L1 (chainId 510102). Why the L1 has these lists and how to check them: [l1/README.md](../l1/README.md). Raw record: [l1-permissions.json](l1-permissions.json).

School admin `0x6732CcE43f5a68Ab29ee75F1e8eF9eD939C865Ab` (admin on both lists). Outsider `0x2cC649f2d93bF4b7d8Fb031D00B155171e99a77E` (holds 1 ZKD, on neither list). New school deployer `0xab491c9A89D89e97939A286b41C8DFFdf06Ec8c2` and new claim relayer `0x23EE128A4b37D06124E7c7625d2267604236F7Cc`, made by this run. The new deployer's perk gate for a second club: `0xa48b6bcf320514f3e355d92aae0d58ed33302bca`.

Refusals come from the L1 node. A transfer or deploy from a wallet not on the TxAllowList is rejected when it reaches the mempool, so it never gets a hash. A deploy from a wallet that may send but not deploy is rejected before mining (the node's `eth_estimateGas` answer is shown).

| # | Step | Signer | Result | L1 tx or node error |
|---|---|---|---|---|
| 1 | outsider sends 1 wei of ZKD | `0x2cC6…a77E` | **refused** | cannot issue transaction from non-allow listed address: 0x2cC649f2d93bF4b7d8Fb031D00B155171e99a77E |
| 2 | outsider deploys a PointsGate | `0x2cC6…a77E` | **refused** | cannot issue transaction from non-allow listed address: 0x2cC649f2d93bF4b7d8Fb031D00B155171e99a77E |
| 3 | claim relayer (tx-enabled) deploys a PointsGate | `0x0544…Ec2d` | **refused** | tx.origin 0x05441C5f1B367b6818064f6AA2c8a88d5906Ec2d is not authorized to deploy a contract |
| 4 | admin sends 20 ZKD to the new school deployer | `0x6732…65Ab` | ok | `0x58207b65edcd7a17f264b6c813a5ae6c9e4068809b83b60ffa92a25094556075` |
| 5 | admin sends 20 ZKD to the new claim relayer | `0x6732…65Ab` | ok | `0x6193b4e695347f895d8c8fa5ddbbe8e2dd70eb4a203a2fe803e9d8ca5496c2db` |
| 6 | new claim relayer sends before it is enabled | `0x23EE…F7Cc` | **refused** | cannot issue transaction from non-allow listed address: 0x23EE128A4b37D06124E7c7625d2267604236F7Cc |
| 7 | admin: TxAllowList.setEnabled(new school deployer) | `0x6732…65Ab` | ok | `0x217a99e6136acc91c9b1f784ac616cab8d92de0e0605711b4888b7607a9eeaeb` |
| 8 | admin: ContractDeployerAllowList.setEnabled(new school deployer) | `0x6732…65Ab` | ok | `0x3f3d0a1827e63fadba072a5d9d151f5f6a8ac6dd92a539e8d50f5a76a8d865f2` |
| 9 | admin: TxAllowList.setEnabled(new claim relayer) | `0x6732…65Ab` | ok | `0x91f0179a5650c00cd9a150c380df6413110233870255a44cc49de3cd7bcde944` |
| 10 | new school deployer deploys a PointsGate (club #2) | `0xab49…c8c2` | ok | `0x75261f834725d6e1708daaf270be5ae6aa43d51ebc805b97c490075da7d9f775` |
| 11 | new school deployer adds a perk (at least 300 points) | `0xab49…c8c2` | ok | `0x35e1835e0cb7bfbd5b2063bac37d262e2156950952bbbf0d48c84320241dddce` |
| 12 | new claim relayer sends a transaction | `0x23EE…F7Cc` | ok | `0x5e789fc919579506f6e5bf93808a573fbbf9325bd39c6b36c0a499269eb2ec22` |
| 13 | admin: ContractDeployerAllowList.setNone(new school deployer) | `0x6732…65Ab` | ok | `0xabc8b72efebf2cdc77f921bb2749a46ce1992d44af2d9e2f7f535d8ca96e2391` |
| 14 | new school deployer deploys again | `0xab49…c8c2` | **refused** | tx.origin 0xab491c9A89D89e97939A286b41C8DFFdf06Ec8c2 is not authorized to deploy a contract |

The new claim relayer then forwarded a real zero-knowledge claim to Fuji over ICM: see the latest run in [l1-run.md](l1-run.md).
