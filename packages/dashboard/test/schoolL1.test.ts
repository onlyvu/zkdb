import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/chain';
import { readSchoolL1Config, summarizeSchoolL1, type ClaimRecorded, type RootSent } from '../src/schoolL1';

const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
const ENV = {
  VITE_ZKDB_ADDRESS: '0x1dd3f88db29ee55e66b8db243c99c5b7fc0ea91c',
  VITE_L1_NAME: 'zkdb L1',
  VITE_L1_CHAIN_ID: '510102',
  VITE_L1_TOKEN: 'ZKD',
  VITE_L1_BLOCKCHAIN_ID: '272pDkC2CtfGT5kMktHTCNi7homXticaHaf1bJyfkgk5BLzTiU',
  VITE_L1_RELAY_ADDRESS: '0x1335af7535aee69c7253f22dea3b6b214891f6e5',
  VITE_L1_REGISTRY_ADDRESS: '0xfab45908d9309ee508fa4e9a79437f47e1396d38',
  VITE_L1_FROM_BLOCK: '61389427',
};

const root = (batchNo: number, block: number): RootSent => ({ batchNo, root: h(100 + batchNo), messageId: h(200 + batchNo), txHash: h(300 + batchNo), block: BigInt(block) });
const claim = (perkId: number, pickup: number, batchNo: number, block: number): ClaimRecorded => ({
  perkId, nullifier: h(400 + pickup), pickup: h(500 + pickup), minPoints: 250n, root: h(100 + batchNo), batchNo, txHash: h(600 + pickup), block: BigInt(block),
});

describe('school L1 config', () => {
  it('reads the Fuji ends of the ICM link from the env', () => {
    expect(readConfig(ENV)?.l1).toEqual({
      name: 'zkdb L1', chainId: 510102, token: 'ZKD', blockchainId: ENV.VITE_L1_BLOCKCHAIN_ID, subnetId: undefined,
      relay: ENV.VITE_L1_RELAY_ADDRESS, registry: ENV.VITE_L1_REGISTRY_ADDRESS, fromBlock: 61389427n,
    });
  });

  it('is off unless both contracts and the blockchain ID are set', () => {
    expect(readSchoolL1Config({ ...ENV, VITE_L1_REGISTRY_ADDRESS: undefined })).toBeUndefined();
    expect(readSchoolL1Config({ ...ENV, VITE_L1_RELAY_ADDRESS: '0x1234' })).toBeUndefined();
    expect(readSchoolL1Config({ ...ENV, VITE_L1_BLOCKCHAIN_ID: '' })).toBeUndefined();
  });
});

describe('school L1 summary', () => {
  const sent = [root(6, 10), root(7, 20), root(8, 30)];
  const recorded = [claim(1, 1, 6, 12), claim(1, 2, 7, 22), claim(1, 3, 8, 32)];

  it('counts the claims checked against each root, newest root first', () => {
    const s = summarizeSchoolL1(sent, recorded, [], 40n);
    expect(s.roots.map((r) => [r.batchNo, r.claims])).toEqual([[8, 1], [7, 1], [6, 1]]);
  });

  it('pairs a claim with its redemption by perk and pickup hash, whatever the hex case', () => {
    const s = summarizeSchoolL1(sent, recorded, [{ perkId: 1, pickup: h(502).toUpperCase().replace('0X', '0x') as `0x${string}`, txHash: h(900) }], 40n);
    expect(s.redeemed).toBe(1);
    expect(s.claims.find((c) => c.batchNo === 7)?.redeemTx).toBe(h(900));
    expect(s.claims.find((c) => c.batchNo === 8)?.redeemTx).toBeUndefined();
  });

  it('does not count a redemption of another perk with the same pickup hash', () => {
    const s = summarizeSchoolL1(sent, recorded, [{ perkId: 0, pickup: h(501), txHash: h(901) }], 40n);
    expect(s.redeemed).toBe(0);
  });

  it('lists claims newest first, with the block time when known', () => {
    const s = summarizeSchoolL1(sent, recorded, [], 40n, new Map([[32n, 1_795_200_000]]));
    expect(s.claims.map((c) => c.batchNo)).toEqual([8, 7, 6]);
    expect(s.claims[0].time).toBe(1_795_200_000);
    expect(s.claims[1].time).toBeUndefined();
  });
});
