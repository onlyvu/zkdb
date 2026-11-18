/**
 * The receiving side of the root relay on the destination L1 (Dispatch for the Fuji deployment): RootMirror, then a
 * ClaimVerifier and a PointsGate that reads the mirrored root, with the same perks.
 *
 * Not deployed yet: the mirror deployer has no gas on Dispatch, and the Dispatch faucet needs a signed-in account.
 * Until then RootRelay's ICM messages reach Teleporter on Dispatch, which cannot run them (the destination has no
 * code) and stores each one as failed, ready to be retried.
 *
 *   npm run deploy:mirror -w @zkdb/dashboard -- --simulate
 *       No gas needed. Asks the Dispatch RPC to run Teleporter's retryMessageExecution for the latest stored root
 *       with RootMirror's code placed at its address (an eth_call state override). Shows the stored message is the
 *       one RootRelay sent and that the mirror would accept it. Nothing is written on-chain.
 *   npm run deploy:mirror -w @zkdb/dashboard
 *       Needs a little DIS on the address it prints. Deploys RootMirror (it must be that account's first
 *       transaction: RootRelay already sends to that address), the gate and the perks, retries the latest stored
 *       message for real, and reads the root back.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, decodeEventLog, encodeDeployData, encodeFunctionData, formatEther, getContractAddress, http, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PROGRAM } from '../src/points';
import { relayAbi } from '../src/chain';
import { PERKS } from './seed';

const network = process.argv[2] ?? 'fuji';
const pathOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
for (const file of [`../.env.${network}`, `../.env.${network}.local`]) {
  try { process.loadEnvFile(pathOf(file)); } catch { /* optional */ }
}
const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Run deploy:${network} first.`);
  return v;
};
// Blockchain ID of the chain RootRelay lives on (Fuji C-Chain), as TeleporterMessenger reports it.
const SOURCE_BLOCKCHAIN_ID = process.env.ICM_SOURCE_BLOCKCHAIN_ID ?? '0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5';

// TeleporterMessenger (ava-labs/icm-contracts): the event that carries a sent message, and the call that re-runs a
// message Teleporter received but could not execute.
const MESSAGE = '(uint256 messageNonce, address originSenderAddress, bytes32 destinationBlockchainID, address destinationAddress, uint256 requiredGasLimit, address[] allowedRelayerAddresses, (uint256 receivedMessageNonce, address relayerRewardAddress)[] receipts, bytes message)';
const teleporterAbi = parseAbi([
  `event SendCrossChainMessage(bytes32 indexed messageID, bytes32 indexed destinationBlockchainID, ${MESSAGE} message, (address feeTokenAddress, uint256 amount) feeInfo)`,
  `function retryMessageExecution(bytes32 sourceBlockchainID, ${MESSAGE} message)`,
  'function receivedFailedMessageHashes(bytes32 messageID) view returns (bytes32)',
]);
const mirrorAbi = parseAbi(['function root() view returns (bytes32)', 'function batchNo() view returns (uint64)']);

const artifact = (name: string): { abi: Abi; bytecode: Hex } => {
  const a = JSON.parse(readFileSync(pathOf(`../../../contracts/out/${name}.sol/${name}.json`), 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object };
};

/** The latest root RootRelay sent, as the Teleporter message struct, read from the source chain's logs. */
async function latestSentMessage() {
  const source = createPublicClient({ transport: http(need('VITE_RPC_URL')) });
  const relay = need('VITE_RELAY_ADDRESS') as Address;
  const latest = await source.getBlockNumber();
  const span = BigInt(process.env.VITE_LOG_RANGE ?? 2000);
  const from = BigInt(need('VITE_ZKDB_FROM_BLOCK'));
  let sent;
  for (let to = latest; to >= from && !sent; to -= span) {
    const logs = await source.getContractEvents({ address: relay, abi: relayAbi, eventName: 'RootRelayed', fromBlock: to - span + 1n > from ? to - span + 1n : from, toBlock: to });
    sent = logs[logs.length - 1];
  }
  if (!sent) throw new Error('RootRelay has not sent a root yet.');
  const receipt = await source.getTransactionReceipt({ hash: sent.transactionHash });
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: teleporterAbi, data: log.data, topics: log.topics });
      if (ev.eventName === 'SendCrossChainMessage') return { batchNo: sent.args.batchNo!, root: sent.args.root!, messageId: ev.args.messageID, message: ev.args.message };
    } catch {
      // not a Teleporter log
    }
  }
  throw new Error('No SendCrossChainMessage in the relay transaction.');
}

async function main() {
  const account = privateKeyToAccount(need('MIRROR_DEPLOYER_KEY') as Hex);
  const transport = http(need('VITE_ICM_RPC_URL'));
  const pub = createPublicClient({ transport });
  const wallet = createWalletClient({ account, transport });
  const teleporter = need('VITE_ICM_TELEPORTER') as Address;
  const expected = need('VITE_ICM_MIRROR') as Address;
  const mirrorArgs = [teleporter, SOURCE_BLOCKCHAIN_ID, need('VITE_RELAY_ADDRESS')];
  const sent = await latestSentMessage();
  const stored = await pub.readContract({ address: teleporter, abi: teleporterAbi, functionName: 'receivedFailedMessageHashes', args: [sent.messageId] });
  console.log(`Latest root sent: batch #${sent.batchNo} ${sent.root}`);
  console.log(`Teleporter on ${process.env.VITE_ICM_NAME} holds it as a failed message: ${BigInt(stored) !== 0n ? 'yes' : 'no'} (${stored})`);
  const retry = encodeFunctionData({ abi: teleporterAbi, functionName: 'retryMessageExecution', args: [SOURCE_BLOCKCHAIN_ID as Hex, sent.message] });

  if (process.argv.includes('--simulate')) {
    // The constructor's return value is the runtime code, immutables included. No transaction, no gas.
    const { abi, bytecode } = artifact('RootMirror');
    const created = await pub.call({ account: account.address, data: encodeDeployData({ abi, bytecode, args: mirrorArgs }) });
    if (!created.data) throw new Error('could not build RootMirror runtime code');
    await pub.call({ account: account.address, to: teleporter, data: retry, stateOverride: [{ address: expected, code: created.data }] });
    console.log(`Simulated on ${process.env.VITE_ICM_NAME}: with RootMirror's code at ${expected}, retryMessageExecution runs the stored message without reverting.`);
    const without = await pub.call({ account: account.address, to: teleporter, data: retry }).then(() => 'runs', (e) => `reverts (${(e as { shortMessage?: string }).shortMessage ?? 'no receiver'})`);
    console.log(`Without the override (the chain as it is today) the same call ${without}.`);
    return;
  }

  const [balance, nonce] = await Promise.all([pub.getBalance({ address: account.address }), pub.getTransactionCount({ address: account.address })]);
  console.log(`Mirror deployer ${account.address} on ${process.env.VITE_ICM_NAME}: ${formatEther(balance)} native coin, nonce ${nonce}`);
  if (nonce !== 0 || getContractAddress({ from: account.address, nonce: 0n }).toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`RootMirror must be this account's first transaction, at ${expected}.`);
  }
  if (balance === 0n) throw new Error('Fund this address on the destination chain, then run again.');

  const deploy = async (name: string, args: unknown[]) => {
    const { abi, bytecode } = artifact(name);
    const hash = await wallet.deployContract({ abi, bytecode, args, chain: null });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`deploy ${name} reverted`);
    console.log(`  ${name} ${r.contractAddress}  gas ${r.gasUsed}`);
    return r.contractAddress!;
  };
  const mirror = await deploy('RootMirror', mirrorArgs);
  if (mirror.toLowerCase() !== expected.toLowerCase()) throw new Error(`RootMirror landed at ${mirror}, expected ${expected}`);
  const gate = await deploy('PointsGate', [mirror, await deploy('ClaimVerifier', [])]);
  for (const p of PERKS) {
    const hash = await wallet.writeContract({ address: gate, abi: artifact('PointsGate').abi, functionName: 'addPerk', args: [PROGRAM.table, p.minPoints, p.name], chain: null });
    await pub.waitForTransactionReceipt({ hash });
  }
  // Run the stored message for the latest root, so the mirror holds it without waiting for the next proof.
  const retried = await wallet.sendTransaction({ to: teleporter, data: retry, chain: null });
  await pub.waitForTransactionReceipt({ hash: retried });
  const [root, batchNo] = await Promise.all([
    pub.readContract({ address: mirror, abi: mirrorAbi, functionName: 'root' }),
    pub.readContract({ address: mirror, abi: mirrorAbi, functionName: 'batchNo' }),
  ]);
  console.log(`RootMirror ${mirror} now holds batch #${batchNo} root ${root} (retry tx ${retried}). PointsGate ${gate} checks claims against it.`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
