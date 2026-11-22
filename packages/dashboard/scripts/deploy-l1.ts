/**
 * Deploys the ICM links between the Fuji C-Chain and the school L1 (zkdb, chainId 510102), and writes .env.l1.
 *
 *   npm run deploy:l1 -w @zkdb/dashboard
 *
 * Fuji C-Chain (signer TREASURER_KEY):
 *   RootRelay      reads the proven root from the live ZkDB and sends it to RootMirror on the L1
 *   ClaimRegistry  records the claim receipts ClaimForwarder sends back; a nullifier is recorded once per perk
 * zkdb L1 (signer DEPLOYER_KEY, gas paid in ZKD):
 *   RootMirror     the root, written only by Teleporter for messages from RootRelay
 *   ClaimVerifier  the same UltraHonk verifier of the claim circuit as on Fuji
 *   PointsGate     the same perk gate as on Fuji, reading RootMirror instead of ZkDB
 *   ClaimForwarder checks a claim through the gate and sends the receipt to ClaimRegistry
 *
 * Each side names a contract on the other side before it exists: the L1 addresses come from the L1 deployer's nonce
 * (nobody else sends from it there), so the Fuji contracts go first. Re-running skips what is already deployed.
 */
import { formatEther, getContractAddress, parseAbi, parseEther, type Address } from 'viem';
import { PROGRAM } from '../src/points';
import { PERKS } from './seed';
import { artifact, EXPLORER, FUJI_BLOCKCHAIN_ID, fuji, fujiWallet, L1, l1, l1Wallet, readDeployment, TELEPORTER, writeDeployment, type L1Deployment } from './l1';

const ZKDB = process.env.VITE_ZKDB_ADDRESS as Address;
if (!ZKDB) throw new Error('VITE_ZKDB_ADDRESS missing (.env.fuji)');

async function main() {
  const fw = fujiWallet('TREASURER_KEY');
  const lw = l1Wallet('DEPLOYER_KEY');
  const d: Partial<L1Deployment> = readDeployment();
  const hasCode = async (chain: typeof fuji, a?: string) => !!a && ((await chain.getCode({ address: a as Address })) ?? '0x') !== '0x';

  const [fBal, lBal] = await Promise.all([fuji.getBalance({ address: fw.account.address }), l1.getBalance({ address: lw.account.address })]);
  console.log(`Fuji signer ${fw.account.address}: ${formatEther(fBal)} AVAX`);
  console.log(`L1 signer   ${lw.account.address}: ${formatEther(lBal)} ${L1.token} on chain ${await l1.getChainId()}`);

  // Where the L1 contracts will land: mirror, verifier, gate, forwarder are the deployer's next four creations.
  const l1Done = await hasCode(l1, d.forwarder);
  const n = BigInt(await l1.getTransactionCount({ address: lw.account.address }));
  const mirrorAt = l1Done ? d.mirror! : getContractAddress({ from: lw.account.address, nonce: n });
  const forwarderAt = l1Done ? d.forwarder! : getContractAddress({ from: lw.account.address, nonce: n + 3n });
  if (!l1Done) console.log(`L1 deployer nonce ${n}: RootMirror will be ${mirrorAt}, ClaimForwarder ${forwarderAt}`);

  type Deployer = typeof fw | typeof lw;
  const deploy = async (w: Deployer, chain: typeof fuji, name: string, args: unknown[], where: string) => {
    const { abi, bytecode } = artifact(name);
    const hash = await w.deployContract({ abi, bytecode, args } as never);
    const r = await chain.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`deploy ${name} on ${where} reverted (${hash})`);
    console.log(`  ${where.padEnd(5)} ${name.padEnd(14)} ${r.contractAddress}  gas ${String(r.gasUsed).padStart(8)}  tx ${hash}`);
    return { address: r.contractAddress! as Address, block: r.blockNumber };
  };

  // Fuji side: reused only if it already points at the addresses the L1 contracts are about to get.
  const pointsAt = async (a: string | undefined, fn: 'mirror' | 'forwarder', want: string) =>
    (await hasCode(fuji, a)) && String(await fuji.readContract({ address: a as Address, abi: parseAbi([`function ${fn}() view returns (address)`]), functionName: fn })).toLowerCase() === want.toLowerCase();
  if (!(await pointsAt(d.relay, 'mirror', mirrorAt))) {
    const relay = await deploy(fw, fuji, 'RootRelay', [ZKDB, TELEPORTER, L1.blockchainId, mirrorAt], 'Fuji');
    d.relay = relay.address;
    d.fujiFromBlock = relay.block;
    writeDeployment(d);
  }
  if (!(await pointsAt(d.registry, 'forwarder', forwarderAt))) {
    d.registry = (await deploy(fw, fuji, 'ClaimRegistry', [TELEPORTER, L1.blockchainId, forwarderAt], 'Fuji')).address;
    writeDeployment(d);
  }

  // L1 side, in nonce order.
  if (!l1Done) {
    const mirror = (await deploy(lw, l1, 'RootMirror', [TELEPORTER, FUJI_BLOCKCHAIN_ID, d.relay], 'L1')).address;
    const verifier = (await deploy(lw, l1, 'ClaimVerifier', [], 'L1')).address;
    const gate = (await deploy(lw, l1, 'PointsGate', [mirror, verifier], 'L1')).address;
    const forwarder = (await deploy(lw, l1, 'ClaimForwarder', [gate, TELEPORTER, FUJI_BLOCKCHAIN_ID, d.registry], 'L1')).address;
    if (mirror.toLowerCase() !== mirrorAt.toLowerCase() || forwarder.toLowerCase() !== forwarderAt.toLowerCase()) {
      throw new Error(`L1 addresses moved (mirror ${mirror}, forwarder ${forwarder}); the Fuji contracts point elsewhere`);
    }
    Object.assign(d, { mirror, claimVerifier: verifier, gate, forwarder });
    writeDeployment(d);
    for (const p of PERKS) {
      const hash = await lw.writeContract({ address: gate, abi: artifact('PointsGate').abi, functionName: 'addPerk', args: [PROGRAM.table, p.minPoints, p.name] } as never);
      await l1.waitForTransactionReceipt({ hash });
      console.log(`  L1    addPerk "${p.name}" (at least ${p.minPoints})  tx ${hash}`);
    }
  }

  // The claim relayer sends members' claims on the L1; it pays gas in ZKD, which the school hands out.
  const relayer = l1Wallet('RELAYER_KEY').account.address;
  if ((await l1.getBalance({ address: relayer })) < parseEther('1')) {
    const hash = await lw.sendTransaction({ to: relayer, value: parseEther('100') } as never);
    await l1.waitForTransactionReceipt({ hash });
    console.log(`  L1    100 ${L1.token} to the claim relayer ${relayer}  tx ${hash}`);
  }

  console.log(`\nWrote packages/dashboard/.env.l1`);
  console.log(`Fuji RootRelay     ${EXPLORER}/address/${d.relay}`);
  console.log(`Fuji ClaimRegistry ${EXPLORER}/address/${d.registry}`);
  console.log(`L1 RootMirror ${d.mirror}, PointsGate ${d.gate}, ClaimForwarder ${d.forwarder}`);
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

