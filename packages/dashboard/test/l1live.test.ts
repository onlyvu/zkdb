import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/chain';
import { allowVerdict, buildAllowList, callName, eventName, l1ContractNames, logSpans, mayUse, readL1LiveConfig, roleName, ROLE_ADMIN, ROLE_ENABLED, ROLE_NONE, syncOf, TX_ALLOW_LIST, type RoleChange } from '../src/l1live';
import { L1_UPGRADE_ACCOUNTS, L1_UPGRADE_TIME, upgradeAccounts } from '../src/l1seed';
import { joinClaims, joinRoots, type L1Claim, type L1Root } from '../src/schoolL1';

const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
const LIVE = {
  VITE_L1_RPC_URL: 'https://l1.example/rpc',
  VITE_L1_MIRROR: a(1),
  VITE_L1_GATE: a(2),
  VITE_L1_FORWARDER: a(3),
  VITE_L1_CLAIM_VERIFIER: a(4),
};

describe('L1 live config', () => {
  it('reads the RPC and the three contracts', () => {
    expect(readL1LiveConfig(LIVE)).toEqual({ rpcUrl: 'https://l1.example/rpc', mirror: a(1), gate: a(2), forwarder: a(3), verifier: a(4) });
  });

  it('is off without an RPC or with a malformed address, and the verifier is optional', () => {
    expect(readL1LiveConfig({ ...LIVE, VITE_L1_RPC_URL: '' })).toBeUndefined();
    expect(readL1LiveConfig({ ...LIVE, VITE_L1_GATE: '0x12' })).toBeUndefined();
    expect(readL1LiveConfig({ ...LIVE, VITE_L1_CLAIM_VERIFIER: undefined })?.verifier).toBeUndefined();
  });

  it('hangs off the school L1 config, which still works without it', () => {
    const env = { VITE_ZKDB_ADDRESS: a(9), VITE_L1_BLOCKCHAIN_ID: 'abc', VITE_L1_RELAY_ADDRESS: a(5), VITE_L1_REGISTRY_ADDRESS: a(6) };
    expect(readConfig(env)?.l1?.live).toBeUndefined();
    expect(readConfig({ ...env, ...LIVE })?.l1?.live?.mirror).toBe(a(1));
  });
});

describe('root sync between the L1 and Fuji', () => {
  const fuji = { batchCount: 8, root: 0xabcn };
  it('is in sync only when the same batch number carries the same root', () => {
    expect(syncOf({ batchNo: 8, root: '0x0abc' }, fuji)).toBe('synced');
    expect(syncOf({ batchNo: 8, root: '0x0abd' }, fuji)).toBe('mismatch');
  });
  it('is behind while the newest root has not been sent, and ahead while the Fuji read lags', () => {
    expect(syncOf({ batchNo: 7, root: '0x01' }, fuji)).toBe('behind');
    expect(syncOf({ batchNo: 9, root: '0x01' }, fuji)).toBe('ahead');
  });
});

describe('eth_getLogs spans', () => {
  it('covers the range without gaps or overlap and never exceeds the cap', () => {
    expect(logSpans(0, 34, 2000)).toEqual([[0, 34]]);
    expect(logSpans(0, 4500, 2000)).toEqual([[0, 1999], [2000, 3999], [4000, 4500]]);
    expect(logSpans(35, 34, 2000)).toEqual([]);
  });
});

describe('allow-list table', () => {
  const change = (list: 'send' | 'deploy', account: string, role: number, oldRole: number, block: number): RoleChange =>
    ({ list, account: account as `0x${string}`, role, oldRole, by: a(1), txHash: h(block), block });
  const roles = [
    { account: a(7), send: ROLE_ENABLED, deploy: ROLE_NONE, balance: 5n },
    { account: a(1), send: ROLE_ADMIN, deploy: ROLE_ADMIN, balance: 9n },
    { account: a(8), send: ROLE_ENABLED, deploy: ROLE_NONE, balance: 0n },
    { account: a(9), send: ROLE_NONE, deploy: ROLE_NONE, balance: 1n },
    { account: a(6), send: ROLE_ENABLED, deploy: ROLE_ENABLED, balance: 2n },
  ];
  const changes = [change('send', a(8), ROLE_ENABLED, ROLE_NONE, 26), change('deploy', a(8), ROLE_ENABLED, ROLE_NONE, 27), change('deploy', a(8), ROLE_NONE, ROLE_ENABLED, 32)];
  const list = buildAllowList(roles, changes, [{ sender: a(7) }, { sender: a(7).toUpperCase().replace('0X', '0x') as `0x${string}` }], [{ sender: a(8) }]);

  it('lists admins first, then deployers, then senders, and leaves out wallets that never had a role', () => {
    expect(list.map((e) => e.account)).toEqual([a(1), a(6), a(7), a(8)]);
  });
  it('keeps a wallet that lost a role, with its changes in order', () => {
    const e = list.find((x) => x.account === a(8))!;
    expect(e.deploy).toBe(ROLE_NONE);
    expect(e.changes.map((c) => c.block)).toEqual([26, 27, 32]);
  });
  it('counts what each wallet did on the L1, whatever the address casing', () => {
    expect(list.find((x) => x.account === a(7))).toMatchObject({ rootsDelivered: 2, claimsSent: 0 });
    expect(list.find((x) => x.account === a(8))).toMatchObject({ rootsDelivered: 0, claimsSent: 1 });
  });
  it('names roles and says in words what a wallet may do', () => {
    expect([0, 1, 2, 3].map(roleName)).toEqual(['None', 'Enabled', 'Admin', 'Manager']);
    expect(mayUse(ROLE_NONE)).toBe(false);
    expect(allowVerdict(ROLE_NONE, ROLE_NONE)).toMatch(/not on the TxAllowList/);
    expect(allowVerdict(ROLE_ENABLED, ROLE_NONE)).toBe('may send transactions (enabled) but may not deploy contracts.');
    expect(allowVerdict(ROLE_ADMIN, ROLE_ENABLED)).toBe('may send transactions (admin) and deploy contracts (enabled).');
  });
});

describe('upgrade file', () => {
  it('yields every listed address once, lowercase', () => {
    const file = { precompileUpgrades: [{ txAllowListConfig: { adminAddresses: ['0xAA'], enabledAddresses: ['0xbb', '0xaa'] } }, { contractDeployerAllowListConfig: { adminAddresses: ['0xAA'], managerAddresses: ['0xCC'] } }] };
    expect(upgradeAccounts(file)).toEqual(['0xaa', '0xbb', '0xcc']);
    expect(upgradeAccounts({})).toEqual([]);
  });
  it('reads the committed l1/upgrade.json: two admins, four enabled wallets, one activation time', () => {
    expect(L1_UPGRADE_ACCOUNTS).toHaveLength(6);
    expect(L1_UPGRADE_ACCOUNTS.every((x) => /^0x[0-9a-f]{40}$/.test(x))).toBe(true);
    expect(L1_UPGRADE_TIME).toBe(1795199165);
  });
});

describe('L1 transaction view', () => {
  const cfg = readL1LiveConfig(LIVE)!;
  it('names the contracts and precompiles a transaction can touch', () => {
    const names = l1ContractNames(cfg);
    expect(names[a(1)]).toBe('RootMirror');
    expect(names[TX_ALLOW_LIST]).toBe('TxAllowList');
    expect(names['0x253b2784c75e510dd0ff1da844684a1ac0aa5fcf']).toBe('TeleporterMessenger');
  });
  it('names calls by selector and events by topic', () => {
    expect(callName('0x', a(1))).toBe('Transfer');
    expect(callName('0x6080', null)).toBe('Contract deployment');
    expect(callName('0xccb5f809000000', a(1))).toBe('receiveCrossChainMessage');
    expect(callName('0xdeadbeef00', a(1))).toBe('0xdeadbeef');
    expect(eventName('0x43fc9ea9c132009dbbdd15fda744b455d9dc275f246ce7905dc1138569283a82')).toBe('RootMirrored');
    expect(eventName('0xCDB7EA01F00A414D78757BDB0F6391664BA3FEDF987EED280927C1E7D695BE3E'.replace('0X', '0x'))).toBe('RoleSet');
    expect(eventName(h(1))).toBeUndefined();
  });
});

describe('claims and roots as both chains saw them', () => {
  const recorded = (n: number, time: number, redeemTx?: `0x${string}`): L1Claim =>
    ({ perkId: 1, nullifier: h(400 + n), pickup: h(500 + n), minPoints: 250n, root: h(100), batchNo: 8, txHash: h(600 + n), block: BigInt(n), time, redeemTx });
  const checked = (n: number, time: number) => ({ perkId: 1, nullifier: h(400 + n), batchNo: 8, txHash: h(700 + n), time });

  it('joins a claim checked on the L1 with its receipt on Fuji, newest first', () => {
    const rows = joinClaims([recorded(1, 110, h(900)), recorded(2, 210)], [checked(1, 100), checked(2, 200)]);
    expect(rows.map((r) => r.nullifier)).toEqual([h(402), h(401)]);
    expect(rows[1]).toMatchObject({ l1Tx: h(701), fujiTx: h(601), redeemTx: h(900), time: 100, minPoints: 250n });
  });
  it('shows a claim whose receipt has not reached Fuji yet, first', () => {
    const rows = joinClaims([recorded(1, 110)], [checked(1, 100), checked(3, 300)]);
    expect(rows[0]).toMatchObject({ nullifier: h(403), l1Tx: h(703) });
    expect(rows[0].fujiTx).toBeUndefined();
  });
  it('still lists receipts when the L1 was not read', () => {
    const rows = joinClaims([recorded(1, 110)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fujiTx: h(601), time: 110 });
    expect(rows[0].l1Tx).toBeUndefined();
  });
  it('joins roots by proof number and counts the claims against each', () => {
    const sent: L1Root[] = [7, 8].map((n) => ({ batchNo: n, root: h(100 + n), messageId: h(n), txHash: h(300 + n), block: BigInt(n), claims: 0 }));
    const rows = joinRoots(sent, [{ batchNo: 7, root: h(107), txHash: h(800) }], [{ batchNo: 7 }, { batchNo: 7 }]);
    expect(rows).toEqual([
      { batchNo: 8, root: h(108), sentTx: h(308), claims: 0 },
      { batchNo: 7, root: h(107), sentTx: h(307), storedTx: h(800), claims: 2 },
    ]);
  });
});
