import { useMemo, type ReactNode } from 'react';
import { cardKey } from '@zkdb/core';
import type { ChainConfig, Snapshot } from './chain';
import { formatAmount } from './format';
import { BALANCE_FIELD, CARD_FIELD, formatCard, KEY_FIELD, PROGRAM, TRIAL_TABLE } from './points';

export interface MyCard { rowId: number; card: bigint; balance: bigint; trial: boolean }

/**
 * The visitor's own card, if this device holds its key: a key made on Rewards ("Make a card key") or on Try it.
 * The key never leaves the device; the card is found by hashing it and looking for that hash in the rebuilt table.
 */
export function useMyCard(cfg: ChainConfig | undefined, s: Snapshot): MyCard | null {
  return useMemo(() => {
    if (!cfg) return null;
    const secrets: string[] = [];
    for (const k of [`zkdb.card.${cfg.address.toLowerCase()}`, `zkdb.trial.${cfg.address.toLowerCase()}`]) {
      try {
        const v = localStorage.getItem(k);
        if (v) secrets.push(v);
      } catch {
        // Storage blocked: no saved card.
      }
    }
    for (const secret of secrets) {
      let key: bigint;
      try {
        key = cardKey(BigInt(secret));
      } catch {
        continue;
      }
      const row = s.rows.find((r) => r.fields[KEY_FIELD] === key);
      if (row) return { rowId: row.rowId, card: row.fields[CARD_FIELD], balance: row.fields[BALANCE_FIELD], trial: row.table === TRIAL_TABLE };
    }
    return null;
  }, [cfg, s]);
}

/**
 * A membership card, drawn like the one in a phone wallet: club, card number, points. The slot pattern in the corner
 * is the logo's: sixteen slots of a proof. A ghost card (no number) invites the visitor to get one.
 */
export function WalletCard({ card, points, caption, ghost, children }: { card?: bigint; points?: bigint; caption?: string; ghost?: boolean; children?: ReactNode }) {
  return (
    <div className={ghost ? 'wallet-card ghost' : 'wallet-card'}>
      <div className="wc-top">
        <span className="wc-club">{PROGRAM.club}</span>
        <svg className="wc-slots" viewBox="0 0 46 46" aria-hidden="true">
          {Array.from({ length: 16 }, (_, i) => <rect key={i} x={(i % 4) * 12} y={Math.floor(i / 4) * 12} width="10" height="10" rx="2.5" style={{ animationDelay: `${i * 0.15}s` }} />)}
        </svg>
      </div>
      <i className="wc-chip" aria-hidden="true" />
      <div className="wc-bottom">
        <div>
          <span className="wc-lab">{caption ?? PROGRAM.name}</span>
          <span className="wc-num">{card !== undefined ? formatCard(card) : '#····'}</span>
        </div>
        {points !== undefined && (
          <div className="wc-points">
            <b>{formatAmount(points)}</b>
            <span>points</span>
          </div>
        )}
      </div>
      {children}
      <i className="wc-sheen" aria-hidden="true" />
    </div>
  );
}
