import type { Address } from 'viem';
import upgrade from '../../../l1/upgrade.json';

interface ListConfig { blockTimestamp?: number; adminAddresses?: string[]; managerAddresses?: string[]; enabledAddresses?: string[] }
const configs = (file: unknown): ListConfig[] =>
  ((file as { precompileUpgrades?: Record<string, ListConfig | undefined>[] }).precompileUpgrades ?? [])
    .flatMap((u) => Object.values(u))
    .filter((c): c is ListConfig => !!c);

/** Every address a Subnet-EVM upgrade file puts on an allow-list, once each, lowercase. */
export function upgradeAccounts(file: unknown): Address[] {
  const all = configs(file).flatMap((c) => [...(c.adminAddresses ?? []), ...(c.managerAddresses ?? []), ...(c.enabledAddresses ?? [])]);
  return [...new Set(all.map((a) => a.toLowerCase()))] as Address[];
}

/**
 * Accounts the L1's network upgrade (l1/upgrade.json) put on its allow-lists. The upgrade emits no event, so these
 * are the addresses whose roles the page asks the precompiles about, next to every address a RoleSet event names.
 */
export const L1_UPGRADE_ACCOUNTS = upgradeAccounts(upgrade);

/** When the allow-lists were switched on (unix seconds), from the same file. */
export const L1_UPGRADE_TIME: number | undefined = configs(upgrade).map((c) => c.blockTimestamp).find((t) => typeof t === 'number');
