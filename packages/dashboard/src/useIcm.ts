import { useEffect, useState } from 'react';
import { createPublicClient, http, type Hex } from 'viem';
import { teleporterAbi, type IcmConfig, type RootRelayed } from './chain';

export interface Delivery {
  /** Teleporter on the other L1 has the message. */
  delivered: boolean;
  /** Teleporter also ran the receiving contract. False while the message is stored as failed (no receiver, or it reverted). */
  executed?: boolean;
  txHash?: string;
}

const RECEIVED = '0x292ee90bbaf70b5d4936025e09d56ba08f3e421156b6a568cf3c2840d9343e34'; // ReceiveCrossChainMessage
const LOG_SPAN = 2000n; // the destination RPC answers eth_getLogs for at most 2,048 blocks

/**
 * For each root sent over ICM, asks TeleporterMessenger on the destination L1 whether the message arrived and whether
 * it could run the receiving contract, and looks for the delivering transaction among its recent blocks.
 */
export function useIcmDeliveries(icm: IcmConfig | undefined, relays: RootRelayed[]): Record<string, Delivery> {
  const [state, setState] = useState<Record<string, Delivery>>({});
  const pending = relays.map((r) => r.messageId).filter((id) => !state[id]?.delivered).join(',');

  useEffect(() => {
    if (!icm || !pending) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const client = createPublicClient({ transport: http(icm.rpcUrl) });
    const check = async () => {
      const found: Record<string, Delivery> = {};
      for (const id of pending.split(',') as Hex[]) {
        try {
          const delivered = await client.readContract({ address: icm.teleporter, abi: teleporterAbi, functionName: 'messageReceived', args: [id] });
          if (!delivered) { found[id] = { delivered: false }; continue; }
          const latest = await client.getBlockNumber();
          const logs = await client.request({
            method: 'eth_getLogs',
            params: [{ address: icm.teleporter, topics: [RECEIVED, id], fromBlock: `0x${(latest > LOG_SPAN ? latest - LOG_SPAN : 0n).toString(16)}`, toBlock: `0x${latest.toString(16)}` }],
          }).catch(() => []);
          // A non-zero stored hash means Teleporter received the message but the call to its destination failed.
          const failed = await client.readContract({ address: icm.teleporter, abi: teleporterAbi, functionName: 'receivedFailedMessageHashes', args: [id] });
          found[id] = { delivered: true, executed: BigInt(failed) === 0n, txHash: (logs as { transactionHash: string }[])[0]?.transactionHash };
        } catch {
          // The other chain's RPC is unreachable: say nothing rather than guess.
        }
      }
      if (cancelled) return;
      setState((s) => ({ ...s, ...found }));
      if (Object.values(found).some((d) => !d.delivered)) timer = setTimeout(check, 4000);
    };
    void check();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [icm, pending]);

  return state;
}
