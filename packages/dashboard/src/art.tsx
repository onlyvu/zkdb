/**
 * Illustrations. Flat, geometric, drawn on a 4px grid, coloured only through the classes in styles.css (art-*), so
 * they follow the theme. Each one shows the real mechanism: rows → a 16-slot proof → a verified root.
 */

const Grid = ({ x, y, size, gap, fills }: { x: number; y: number; size: number; gap: number; fills: string[] }) => (
  <g>
    {fills.map((c, i) => (
      <rect key={i} x={x + (i % 4) * (size + gap)} y={y + Math.floor(i / 4) * (size + gap)} width={size} height={size} rx={2.5} className={c} />
    ))}
  </g>
);

const SLOTS = ['art-a', 'art-a', 'art-a', 'art-a', 'art-a', 'art-a', 'art-bad', 'art-a', 'art-a', 'art-a', 'art-a', 'art-soft', 'art-soft', 'art-soft', 'art-soft', 'art-soft'];

/** Overview hero: ledger rows flow into one proof, the proof seals the root on-chain. */
export function HeroArt() {
  return (
    <svg className="art" viewBox="0 0 420 220" role="img" aria-label="Rows go into a 16-slot proof; the contract checks it and seals the new root">
      <circle cx="350" cy="58" r="44" className="art-lime" />
      {/* rows */}
      {[0, 1, 2].map((i) => (
        <g key={i} transform={`translate(${16 + i * 8} ${56 + i * 34})`}>
          <rect width="112" height="26" rx="7" className="art-paper art-stroke" />
          <rect x="10" y="9" width="8" height="8" rx="2" className={i === 1 ? 'art-bad' : 'art-a'} />
          <rect x="26" y="10" width="44" height="6" rx="3" className="art-line" />
          <rect x="78" y="10" width="22" height="6" rx="3" className="art-ink" />
        </g>
      ))}
      {/* flow */}
      <path d="M150 112 C 170 112, 172 112, 190 112" className="art-flow" />
      <path d="M186 106 l7 6 -7 6" className="art-flow" />
      {/* proof */}
      <rect x="200" y="58" width="108" height="108" rx="14" className="art-paper art-stroke" />
      <Grid x={213} y={71} size={18} gap={4} fills={SLOTS} />
      {/* seal */}
      <path d="M308 112 C 322 112, 326 150, 340 150" className="art-flow" />
      <g transform="translate(330 134)">
        <circle cx="26" cy="26" r="26" className="art-ink" />
        <path d="M14 27 l8 8 16 -18" className="art-check" />
      </g>
    </svg>
  );
}

/** A card whose secret stays on the device: only its hash goes to the ledger. */
export function CardArt() {
  return (
    <svg className="art" viewBox="0 0 200 120" aria-hidden="true">
      <circle cx="160" cy="30" r="22" className="art-lime" />
      <rect x="24" y="22" width="132" height="84" rx="12" className="art-a" />
      <rect x="38" y="38" width="22" height="16" rx="3" className="art-lime" />
      <rect x="38" y="72" width="60" height="6" rx="3" className="art-on-a" />
      <rect x="38" y="84" width="36" height="6" rx="3" className="art-on-a-soft" />
      <g transform="translate(118 66)">
        <circle cx="12" cy="12" r="15" className="art-paper art-stroke" />
        <circle cx="9" cy="12" r="4" className="art-key" />
        <path d="M13 12 h8 m-3 0 v4" className="art-key-line" />
      </g>
    </svg>
  );
}

/** Changes enter the 16 slots; the batch proof says the new root follows the rules. */
export function BatchArt() {
  return (
    <svg className="art" viewBox="0 0 200 120" aria-hidden="true">
      <rect x="18" y="14" width="92" height="92" rx="12" className="art-paper art-stroke" />
      <Grid x={28} y={24} size={16} gap={4} fills={['art-a', 'art-a', 'art-a', 'art-bad', 'art-a', 'art-a', 'art-soft', 'art-soft', 'art-soft', 'art-soft', 'art-soft', 'art-soft', 'art-soft', 'art-soft', 'art-soft', 'art-soft']} />
      <path d="M118 60 H 140" className="art-flow" />
      <path d="M136 54 l7 6 -7 6" className="art-flow" />
      <circle cx="168" cy="60" r="20" className="art-ink" />
      <path d="M159 61 l6 6 12 -13" className="art-check" />
    </svg>
  );
}

/** "At least N" without saying which card: the card sits behind a frosted pane, the number is in front. */
export function ClaimArt() {
  return (
    <svg className="art" viewBox="0 0 200 120" aria-hidden="true">
      {[0, 1, 2].map((i) => <rect key={i} x={30 + i * 26} y={30 + i * 6} width="70" height="46" rx="9" className={i === 1 ? 'art-a' : 'art-line'} />)}
      <rect x="22" y="44" width="132" height="58" rx="12" className="art-frost" />
      <text x="88" y="82" textAnchor="middle" className="art-num">≥ 100</text>
      <circle cx="164" cy="34" r="18" className="art-lime" />
      <path d="M156 34 l5 5 10 -11" className="art-check-ink" />
    </svg>
  );
}

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
    <rect x="13" y="13" width="9" height="9" rx="2.5" className="art-lime" />
  </svg>
);
