import type { Address } from 'viem';
import type { Snapshot } from './chain';
import { PROGRAM } from './points';

export type Role = 'Owner' | 'Treasurer' | 'Writer' | 'Auditor' | 'Viewer';
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * What an address may do, read from the contract. The treasurer is the writer who owns the points table; the
 * auditor is the second signer for corrections on it.
 */
export function rolesOf(s: Snapshot, address: Address | string | null | undefined): Role[] {
  if (!address) return [];
  const roles: Role[] = [];
  if (same(s.owner, address)) roles.push('Owner');
  if (s.tableOwners.some((t) => t.tableId === PROGRAM.table && same(t.writer, address))) roles.push('Treasurer');
  else if (s.writers.some((w) => same(w, address))) roles.push('Writer');
  if (s.tableAuditors.some((t) => same(t.auditor, address))) roles.push('Auditor');
  return roles.length ? roles : ['Viewer'];
}

/** The role to print next to an address in a history, or nothing for an account that holds none today. */
export function roleLabel(s: Snapshot, address: string): string | undefined {
  const roles = rolesOf(s, address).filter((r) => r !== 'Viewer');
  return roles.length ? roles.join(' + ') : undefined;
}
