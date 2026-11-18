import { BaseError, ContractFunctionRevertedError } from 'viem';

const REVERTS: Record<string, string> = {
  NotOwner: 'Only the contract owner can do this.',
  NotWriter: 'This account is not an approved writer.',
  NotTableOwner: 'This account does not own that table.',
  NeedsAuditor: 'This table has an auditor. Overwriting, subtracting or deleting needs a proposal the auditor co-signs.',
  NotAuditor: 'Only this table\'s auditor can do this.',
  AuditorIsWriter: 'The auditor and the table\'s writer must be different accounts.',
  ProposalClosed: 'This proposal was already co-signed, declined or withdrawn.',
  ProposalMismatch: 'This is not the change that was proposed.',
  NothingNew: 'This root was already sent.',
  NothingToCollect: 'No claim is waiting for that pickup code.',
  PickupTaken: 'That pickup code was used before.',
  BadOpcode: 'That operation is not allowed.',
  RowOutOfRange: 'That row has not been allocated yet.',
  RowLimit: 'The database has reached its row limit.',
  FieldOverflow: 'A value is too large to store.',
  EmptyBatch: 'There are no waiting changes to prove.',
  TooManyOps: 'New changes arrived while the proof was being made. Try again.',
  OpMismatch: 'New changes arrived while the proof was being made. Try again.',
  InvalidProof: 'The contract rejected the proof, so nothing changed. The prover and the contract may be out of date with each other.',
};

export function friendlyError(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      if (name && REVERTS[name]) return REVERTS[name];
    }
    const rejected = e.walk((x) => (x as { code?: number }).code === 4001);
    if ((rejected as { code?: number } | null)?.code === 4001) return 'The wallet request was cancelled.';
    return e.shortMessage;
  }
  const err = e as { code?: number; message?: string };
  if (err?.code === 4001) return 'The wallet request was cancelled.';
  return err?.message ?? 'Something went wrong.';
}
