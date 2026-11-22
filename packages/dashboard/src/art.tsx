import type { CSSProperties, ReactNode } from 'react';

/**
 * Illustrations. Flat, geometric, drawn on a 4px grid, coloured only through the classes in styles.css (art-*), so
 * they follow the theme. Each one shows the real mechanism: rows → a 16-slot proof → a verified root.
 * Motion (mo-*) loops slowly and stops under prefers-reduced-motion; every frame at rest is a complete picture.
 */

const delay = (s: number): CSSProperties => ({ animationDelay: `${s}s` });

const Grid = ({ x, y, size, gap, fills, animate }: { x: number; y: number; size: number; gap: number; fills: string[]; animate?: boolean }) => (
  <g>
    {fills.map((c, i) => (
      <rect
        key={i}
        x={x + (i % 4) * (size + gap)}
        y={y + Math.floor(i / 4) * (size + gap)}
        width={size}
        height={size}
        rx={2.5}
        className={animate && c !== 'art-soft' ? `${c} mo-fill` : c}
        style={animate && c !== 'art-soft' ? delay(i * 0.12) : undefined}
      />
    ))}
  </g>
);

const SLOTS = ['art-a', 'art-a', 'art-a', 'art-a', 'art-a', 'art-a', 'art-bad', 'art-a', 'art-a', 'art-a', 'art-a', 'art-soft', 'art-soft', 'art-soft', 'art-soft', 'art-soft'];

/** Rows flow into one proof, the proof seals the root on-chain. */
export function HeroArt() {
  return (
    <svg className="art" viewBox="0 0 420 220" role="img" aria-label="Rows go into a 16-slot proof; the contract checks it and seals the new root">
      <circle cx="350" cy="58" r="44" className="art-lime mo-breathe" />
      {[0, 1, 2].map((i) => (
        <g key={i} transform={`translate(${16 + i * 8} ${56 + i * 34})`}>
          <g className="mo-slide" style={delay(i * 0.3)}>
            <rect width="112" height="26" rx="7" className="art-paper art-stroke" />
            <rect x="10" y="9" width="8" height="8" rx="2" className={i === 1 ? 'art-bad' : 'art-a'} />
            <rect x="26" y="10" width="44" height="6" rx="3" className="art-line" />
            <rect x="78" y="10" width="22" height="6" rx="3" className="art-ink" />
          </g>
        </g>
      ))}
      <path d="M150 112 C 170 112, 172 112, 190 112" className="art-flow mo-dash" />
      <path d="M186 106 l7 6 -7 6" className="art-flow" />
      <rect x="200" y="58" width="108" height="108" rx="14" className="art-paper art-stroke" />
      <Grid x={213} y={71} size={18} gap={4} fills={SLOTS} animate />
      <path d="M308 112 C 322 112, 326 150, 340 150" className="art-flow mo-dash" />
      <g transform="translate(330 134)">
        <g className="mo-pop">
          <circle cx="26" cy="26" r="26" className="art-ink" />
          <path d="M14 27 l8 8 16 -18" className="art-check" />
        </g>
      </g>
    </svg>
  );
}

/** A card whose secret stays on the device: only its hash goes to the ledger. */
export function CardArt() {
  return (
    <svg className="art" viewBox="0 0 200 120" aria-hidden="true">
      <circle cx="160" cy="30" r="22" className="art-lime mo-breathe" />
      <g className="mo-float">
        <rect x="24" y="22" width="132" height="84" rx="12" className="art-a" />
        <rect x="38" y="38" width="22" height="16" rx="3" className="art-lime" />
        <rect x="38" y="72" width="60" height="6" rx="3" className="art-on-a" />
        <rect x="38" y="84" width="36" height="6" rx="3" className="art-on-a-soft" />
        <g transform="translate(118 66)">
          <g className="mo-wiggle">
            <circle cx="12" cy="12" r="15" className="art-paper art-stroke" />
            <circle cx="9" cy="12" r="4" className="art-key" />
            <path d="M13 12 h8 m-3 0 v4" className="art-key-line" />
          </g>
        </g>
      </g>
    </svg>
  );
}

/** Changes enter the 16 slots one by one; the proof says the new root follows the rules. */
export function BatchArt() {
  return (
    <svg className="art" viewBox="0 0 200 120" aria-hidden="true">
      <rect x="18" y="14" width="92" height="92" rx="12" className="art-paper art-stroke" />
      <Grid x={28} y={24} size={16} gap={4} animate fills={['art-a', 'art-a', 'art-a', 'art-bad', 'art-a', 'art-a', 'art-soft', 'art-soft', 'art-soft', 'art-soft', 'art-soft', 'art-soft', 'art-soft', 'art-soft', 'art-soft', 'art-soft']} />
      <path d="M118 60 H 140" className="art-flow mo-dash" />
      <path d="M136 54 l7 6 -7 6" className="art-flow" />
      <g className="mo-pop">
        <circle cx="168" cy="60" r="20" className="art-ink" />
        <path d="M159 61 l6 6 12 -13" className="art-check" />
      </g>
    </svg>
  );
}

/** "At least N" without saying which card: cards shuffle behind a frosted pane, the number stays in front. */
export function ClaimArt() {
  return (
    <svg className="art" viewBox="0 0 200 120" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <g key={i} className="mo-shuffle" style={delay(i * -1.1)}>
          <rect x={30 + i * 26} y={30 + i * 6} width="70" height="46" rx="9" className={i === 1 ? 'art-a' : 'art-line'} />
        </g>
      ))}
      <rect x="22" y="44" width="132" height="58" rx="12" className="art-frost" />
      <text x="88" y="82" textAnchor="middle" className="art-num">≥ 100</text>
      <g className="mo-pop" style={delay(0.6)}>
        <circle cx="164" cy="34" r="18" className="art-lime" />
        <path d="M156 34 l5 5 10 -11" className="art-check-ink" />
      </g>
    </svg>
  );
}

/** A reward, drawn by what it is: a ticket, a certificate, or the trial's "at least" badge. */
export const perkKind = (name: string) => (/ticket/i.test(name) ? 'ticket' : /certif/i.test(name) ? 'cert' : 'badge');

export function PerkArt({ name }: { name: string }) {
  const kind = perkKind(name);
  return (
    <svg className="art perk-art" viewBox="0 0 120 72" aria-hidden="true">
      <circle cx="98" cy="18" r="14" className="art-lime mo-breathe" />
      <g className="mo-float">
        {kind === 'ticket' && (
          <g>
            <path d="M14 18 h68 a6 6 0 0 0 0 12 v12 a6 6 0 0 0 0 12 h-68 a6 6 0 0 0 0-12 v-12 a6 6 0 0 0 0-12z" className="art-a" transform="translate(4 0)" />
            <path d="M66 22 v32" className="art-dash-on-a" />
            <rect x="26" y="30" width="28" height="5" rx="2.5" className="art-on-a" />
            <rect x="26" y="40" width="18" height="5" rx="2.5" className="art-on-a-soft" />
          </g>
        )}
        {kind === 'cert' && (
          <g>
            <rect x="14" y="12" width="70" height="50" rx="6" className="art-paper art-stroke" />
            <rect x="24" y="22" width="40" height="5" rx="2.5" className="art-ink" />
            <rect x="24" y="32" width="50" height="4" rx="2" className="art-line" />
            <rect x="24" y="40" width="34" height="4" rx="2" className="art-line" />
            <circle cx="70" cy="52" r="9" className="k-cert-seal" />
            <path d="M66 52 l3 3 6-6" className="art-check-white" />
          </g>
        )}
        {kind === 'badge' && (
          <g>
            <rect x="16" y="14" width="68" height="46" rx="12" className="k-badge-fill" />
            <text x="50" y="44" textAnchor="middle" className="art-num-on-a">≥ 100</text>
          </g>
        )}
      </g>
    </svg>
  );
}

/** Small line icons for the interface. Stroke only, 24px grid, coloured by currentColor. */
const GLYPHS: Record<string, ReactNode> = {
  people: <><circle cx="9" cy="9" r="3.2" /><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6" /><path d="M15.5 6.2a3 3 0 0 1 0 5.6M17 14.6c1.8.5 3 1.9 3.5 4.4" /></>,
  coins: <><ellipse cx="10" cy="8" rx="6" ry="2.6" /><path d="M4 8v4c0 1.4 2.7 2.6 6 2.6s6-1.2 6-2.6V8" /><path d="M8 17.4c.6.9 2.7 1.6 5 1.6 3.3 0 6-1.2 6-2.6v-4c0-1-1.3-1.8-3.2-2.3" /></>,
  hourglass: <><path d="M7 4h10M7 20h10" /><path d="M8 4c0 4 8 4 8 8s-8 4-8 8M16 4c0 4-8 4-8 8s8 4 8 8" /></>,
  bolt: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" />,
  check: <path d="M5 12.5 10 17l9-10" />,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  user: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6" /></>,
  gift: <><rect x="4" y="9" width="16" height="11" rx="1.5" /><path d="M12 9v11M4 13h16M12 9c-1.5-3.5-5.5-4-5.5-1.5S10 9 12 9zm0 0c1.5-3.5 5.5-4 5.5-1.5S14 9 12 9z" /></>,
  desk: <><path d="M4 10h16v3H4zM6 13v7M18 13v7" /><path d="M9 10V7a3 3 0 0 1 6 0v3" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  up: <><path d="M12 19V6" /><path d="M6.5 11 12 5.5l5.5 5.5" /></>,
  pen: <><path d="M5 19l1-4L16 5l3 3L9 18z" /><path d="M14 7l3 3" /></>,
  join: <><circle cx="10" cy="8.5" r="3.5" /><path d="M3.5 20c.8-3.6 3.4-5.6 6.5-5.6 1.4 0 2.6.4 3.6 1.1" /><path d="M18 14v6M15 17h6" /></>,
  leave: <><circle cx="10" cy="8.5" r="3.5" /><path d="M3.5 20c.8-3.6 3.4-5.6 6.5-5.6 1.4 0 2.6.4 3.6 1.1" /><path d="M15 17h6" /></>,
  card: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18M7 15h4" /></>,
  shield: <><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" /><path d="M9 12l2 2 4-4.5" /></>,
};

export const Glyph = ({ name, className }: { name: keyof typeof GLYPHS | string; className?: string }) => (
  <svg className={className ? `glyph ${className}` : 'glyph'} viewBox="0 0 24 24" aria-hidden="true">{GLYPHS[name]}</svg>
);

/** A check mark that draws itself in, inside a filled circle. */
export const Seal = ({ state }: { state: 'match' | 'mismatch' | 'unknown' }) => (
  <svg className="mark seal" viewBox="0 0 16 16" aria-hidden="true">
    {state === 'match' && <path className="mo-draw" d="M3 8.5 6.5 12 13 4.5" pathLength={1} />}
    {state === 'mismatch' && <path d="M4 4l8 8M12 4l-8 8" />}
    {state === 'unknown' && <path d="M3 8h10" />}
  </svg>
);

/** Nothing here yet. */
export function EmptyArt() {
  return (
    <svg className="art art-empty" viewBox="0 0 96 64" aria-hidden="true">
      <rect x="10" y="10" width="76" height="44" rx="10" className="art-dash" />
      <Grid x={30} y={20} size={6} gap={3} fills={Array(16).fill('art-soft')} />
    </svg>
  );
}

/** The logo mark: four slots, one of them lit. */
export const LogoMark = () => (
  <svg className="logo-mark" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2" y="2" width="9" height="9" rx="2.5" className="art-a" />
    <rect x="13" y="2" width="9" height="9" rx="2.5" className="art-a" />
    <rect x="2" y="13" width="9" height="9" rx="2.5" className="art-a" />
    <rect x="13" y="13" width="9" height="9" rx="2.5" className="art-lime mo-blink" />
  </svg>
);
