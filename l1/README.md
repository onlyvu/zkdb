# The zkdb L1: genesis, upgrade and who may write

`zkdb` is zkDB's own Avalanche L1 (Subnet-EVM v1.15.3, chainId 510102, token ZKD, blockchainID `272pDkC2CtfGT5kMktHTCNi7homXticaHaf1bJyfkgk5BLzTiU`, subnetID `23UCnnKWGoJTeAf1Uzqjo5RBvoyJ2sYQ7UMqviBcTuYqUJPL97`), converted to a sovereign L1 on Fuji on 21 Nov 2026.

- [genesis.json](genesis.json): the genesis the chain was created with (fee config, Warp, the PoA validator manager at `0x0feedc0de…`).
- [upgrade.json](upgrade.json): the Subnet-EVM network upgrade that turned on two precompiles at unix time 1795199165 (21 Nov 2026 01:26 VN).

## What the precompiles enforce, and why

| Precompile | Address | Admin | Enabled | Effect |
|---|---|---|---|---|
| TxAllowList | `0x0200…0002` | school admin `0x6732…65Ab`, team ops `0x7855…47F9` | claim relayer `0x0544…Ec2d`, ICM relayer `0x4740…F1DC`, `0xba3a…9ea4`, treasurer `0x8117…48e7`, plus members the admin adds | Any other wallet's transaction is rejected by the node: `cannot issue transaction from non-allow listed address` |
| ContractDeployerAllowList | `0x0200…0000` | school admin, team ops | members the admin adds | Any other wallet's deploy fails: `tx.origin … is not authorized to deploy a contract` |

Why for zkDB: ZKD gas is free to students because the school's claim relayer pays it, so the chain must not be open. A stranger who got a few ZKD could spend the relayer's block space or put up a fake perk gate that looks like the school's. With these lists only wallets the school enabled can send on the L1, and only the school deploys the contracts members claim against (RootMirror, PointsGate, ClaimForwarder). A Fuji C-Chain contract cannot do this: anyone can send and deploy there. Admins add or remove members with `setEnabled` / `setNone`; `readAllowList(address)` returns 0 none, 1 enabled, 2 admin, 3 manager. The live run (outsider refused, a new deployer and claim relayer enabled and used, the deployer offboarded) is in [docs/l1-permissions.md](../docs/l1-permissions.md); repeat it with `npm run perms:l1 -w @zkdb/dashboard`.

## Check it

From anywhere (public P-Chain API):

```bash
P=https://api.avax-test.network/ext/bc/P
post() { curl -s -X POST -H 'content-type:application/json' --data "$1" $P; }
# converted to an L1: conversionID set, managerChainID = this blockchain, managerAddress = the PoA validator manager
post '{"jsonrpc":"2.0","id":1,"method":"platform.getSubnet","params":{"subnetID":"23UCnnKWGoJTeAf1Uzqjo5RBvoyJ2sYQ7UMqviBcTuYqUJPL97"}}'
# its validator (one node, NodeID-QLF4neeFGhSaD3KNtzB6poha5KNTLU3iL)
post '{"jsonrpc":"2.0","id":1,"method":"platform.getCurrentValidators","params":{"subnetID":"23UCnnKWGoJTeAf1Uzqjo5RBvoyJ2sYQ7UMqviBcTuYqUJPL97"}}'
# the CreateChainTx (its ID is the blockchainID): genesisData is genesis.json in base64
post '{"jsonrpc":"2.0","id":1,"method":"platform.getTx","params":{"txID":"272pDkC2CtfGT5kMktHTCNi7homXticaHaf1bJyfkgk5BLzTiU","encoding":"json"}}' \
  | python3 -c "import json,sys,base64; print(json.loads(base64.b64decode(json.load(sys.stdin)['result']['tx']['unsignedTx']['genesisData'])) == json.load(open('l1/genesis.json')))"
```

The last line prints `True` from the repo root. The upgrade is not on the P-Chain: each validator reads it from `configs/chains/<blockchainID>/upgrade.json`, and the file must be identical on every validator or they fork. With one validator it is the copy here. The lists themselves can be read from anywhere through the L1's public RPC:

```bash
RPC=https://zkdb-rpc.vuvietanh.com   # public, read-only; on the validator itself: http://127.0.0.1:9650/ext/bc/272pDkC2CtfGT5kMktHTCNi7homXticaHaf1bJyfkgk5BLzTiU/rpc
cast call 0x0200000000000000000000000000000000000002 "readAllowList(address)(uint256)" 0x2cC649f2d93bF4b7d8Fb031D00B155171e99a77E --rpc-url $RPC   # 0: outsider
cast call 0x0200000000000000000000000000000000000000 "readAllowList(address)(uint256)" 0x6732CcE43f5a68Ab29ee75F1e8eF9eD939C865Ab --rpc-url $RPC   # 2: admin
```

## Limits

One validator, on a server the project runs. The L1 RPC is public and read-only at `https://zkdb-rpc.vuvietanh.com` (a proxy in front of the node: reads, plus `eth_sendRawTransaction`, which the TxAllowList refuses for outsiders); there is no block explorer, so the dashboard's School L1 page shows L1 transactions. The L1 is also visible through the P-Chain and through ICM messages on Fuji (each L1 → Fuji message is Warp-signed by that validator). Proof of authority, and the PoA owner is a project key (`0x7855…47F9`), which is also an allow-list admin. The validator's P-Chain balance needs topping up about once a day. The allow-lists are live since 21 Nov 2026 01:26 VN; runs before that had them off. No fee manager or native minter.
