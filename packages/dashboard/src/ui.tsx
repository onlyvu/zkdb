import { useState, type ReactNode } from 'react';
import type { ChainConfig, Snapshot } from './chain';
import { roleLabel } from './roles';
import { describeOp, shortHex } from './format';
import { actionName } from './format';
import type { OpStatus, Slot } from './replay';
import { EmptyArt } from './art';

export const K = 16;

/** `page` makes the title the page's headline (serif); otherwise it is a section inside a page. */
export function Section({ id, title, count, note, actions, page, children }: { id?: string; title: string; count?: number; note?: string; actions?: ReactNode; page?: boolean; children: ReactNode }) {
  return (
    <section id={id} className={page ? 'section page' : 'section'}>
      <div className="section-head">
        <div>
          <h2>{title}{count !== undefined && <span className="count mono">{count}</span>}</h2>
          {note && <p className="note">{note}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Table({ head, children, className }: { head: ([string] | [string, string])[]; children: ReactNode; className?: string }) {
  return (
    <div className={className ? `table-wrap ${className}` : 'table-wrap'} tabIndex={0}>
      <table>
        <thead><tr>{head.map(([h, cls], i) => <th key={i} scope="col" className={cls}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty"><EmptyArt /><p>{children}</p></div>;

let explorer: { url: string; name: string } | null = null;

/** Called once with the config, so every tx/address on the page can link to the network's block explorer. */
export function setExplorer(cfg: ChainConfig) {
  if (!cfg.explorer) return;
  const host = new URL(cfg.explorer).hostname.split('.');
  const name = host.length > 1 ? host[host.length - 2] : host[0];
  explorer = { url: cfg.explorer, name: name.charAt(0).toUpperCase() + name.slice(1) };
}

/** A hash with a copy button and, when the network has an explorer, a link to it. */
export function OnChain({ value, kind, full }: { value: string; kind: 'tx' | 'address'; full?: boolean }) {
  return (
    <span className="onchain">
      <Hash value={value} full={full} />
      {explorer && <a className="link ext" href={`${explorer.url}/${kind}/${value}`} target="_blank" rel="noreferrer">{explorer.name} ↗</a>}
    </span>
  );
}

/** Who did something: the role the address holds today and the address itself, linked to the explorer. */
export function Actor({ s, address, verb }: { s: Snapshot; address?: string; verb?: string }) {
  if (!address) return <span className="note">—</span>;
  const role = roleLabel(s, address);
  const short = shortHex(address, 4, 4);
  return (
    <span className="actor" title={address}>
      {verb && <span className="verb">{verb}</span>}
      {role && <b>{role}</b>}
      {explorer
        ? <a className="addr mono" href={`${explorer.url}/address/${address}`} target="_blank" rel="noreferrer">{short}</a>
        : <span className="addr mono">{short}</span>}
    </span>
  );
}

export function Hash({ value, full }: { value: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <button type="button" className={full ? 'hash full' : 'hash'} title={value} aria-label={`Copy ${value}`} onClick={copy}>
      <span>{copied ? 'Copied' : full ? value : shortHex(value)}</span>
      <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.5" /><path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" /></svg>
    </button>
  );
}

const SLOT_LABEL: Record<Slot['kind'], string> = { ok: 'Confirmed', fail: 'Rejected', pending: 'Waiting', noop: 'Unused', empty: 'Free' };

function slotTitle(x: Slot, i: number) {
  const base = `Slot ${i + 1}: ${SLOT_LABEL[x.kind]}`;
  return x.op ? `${base} · change #${x.op.id} · ${actionName(x.op.op)} · ${describeOp(x.op.op)}` : base;
}

export function SlotBar({ slots, small }: { slots: Slot[]; small?: boolean }) {
  const counts = (Object.keys(SLOT_LABEL) as Slot['kind'][])
    .map((k) => [SLOT_LABEL[k], slots.filter((x) => x.kind === k).length] as const)
    .filter(([, n]) => n > 0);
  return (
    <div className={small ? 'slots small' : 'slots'} role="img" aria-label={counts.map(([l, n]) => `${l}: ${n}`).join(', ')}>
      {slots.map((x, i) => <i key={i} className={`slot-${x.kind}`} title={slotTitle(x, i)} />)}
    </div>
  );
}

/** Each slot is one change. Only the kinds present are listed, so the legend never explains a colour that is not on screen. */
export function SlotLegend({ slots }: { slots: Slot[] }) {
  const kinds = (['ok', 'fail', 'pending', 'noop', 'empty'] as const).filter((k) => slots.some((x) => x.kind === k));
  return (
    <ul className="legend">
      {kinds.map((k) => <li key={k}><i className={`slot-${k}`} aria-hidden="true" />{SLOT_LABEL[k]} {slots.filter((x) => x.kind === k).length}</li>)}
    </ul>
  );
}

export function Details({ children, label = 'Technical details' }: { children: ReactNode; label?: string }) {
  return (
    <details className="tech">
      <summary>{label}</summary>
      {children}
    </details>
  );
}

export const STATUS: Record<OpStatus, string> = { applied: 'Confirmed', failed: 'Rejected', pending: 'Waiting' };
export const STATUS_HELP: Record<OpStatus, string> = {
  applied: 'A proof confirmed this change and the contract accepted it.',
  failed: 'The proof showed this change could not be applied, for example subtracting below zero or editing a deleted row. It had no effect.',
  pending: 'Recorded on-chain and waiting. It takes effect when the next proof is published.',
};
export const OpStatusLabel = ({ status }: { status: OpStatus }) => (
  <span className={`status ${status}`} title={STATUS_HELP[status]}><i aria-hidden="true" />{STATUS[status]}</span>
);

export function KeyValues({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="access">
      {items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}
