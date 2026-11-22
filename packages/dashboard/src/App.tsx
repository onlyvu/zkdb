import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Admin } from './admin';
import { Perks } from './perks';
import { Trial } from './trial';
import { LogoMark } from './art';
import { L1TxDetail, SchoolL1 } from './l1view';
import { useL1Live, type L1LiveState } from './l1live';
import { L1_UPGRADE_ACCOUNTS } from './l1seed';
import { useSchoolL1, type SchoolL1State } from './schoolL1';
import { rolesOf } from './roles';
import { useIcmDeliveries } from './useIcm';
import { readConfig, type ChainConfig, type Snapshot } from './chain';
import { friendlyError } from './errors';
import { shortHex } from './format';
import { resolveSearch } from './search';
import { CARD_FIELD, PROGRAM } from './points';
import { setExplorer } from './ui';
import { useAuth, type Auth } from './useAuth';
import { useTech } from './tech';
import { useTheme, type Theme } from './theme';
import { useSnapshot } from './useSnapshot';
import { BatchDetail, Batches, Data, MemberDetail, Members, OpDetail, Ops, Overview, RowDetail } from './views';
import { useProofMeta, type ProofMetaMap } from './useProofMeta';
import type { Delivery } from './useIcm';
import { usePriceRef, type PriceRef } from './usePriceRef';
import { connectBrowserWallet, devWallet, hasBrowserWallet, listDevAccounts, type DevAccount } from './wallet';

const config = readConfig();
if (config) setExplorer(config);

export function App() {
  if (!config) return <NotConfigured />;
  return <Dashboard cfg={config} />;
}

function NotConfigured() {
  return (
    <main className="wrap solo">
      <Logo />
      <section className="box message">
        <h2>No ledger connected</h2>
        <pre>npm run demo -w @zkdb/dashboard</pre>
        <p className="note">Or set <code>VITE_ZKDB_ADDRESS</code> and <code>VITE_RPC_URL</code> in <code>.env.local</code>.</p>
      </section>
    </main>
  );
}

/** One name everywhere: zkDB. What it is here, a points ledger, sits beside it in small type. */
const Logo = () => <a className="logo" href="#overview" aria-label="zkDB home"><LogoMark />zkDB</a>;

/** What people come for. The rest (how it is proven, the chain, admin) sits under More. */
const PRIMARY: [string, string][] = [['overview', 'Home'], ['try', 'Try it'], ['members', 'Members'], ['perks', 'Rewards'], ['ops', 'History']];
const MORE: [string, string, string][] = [
  ['batches', 'Proofs', ''],
  ['l1', 'School chain', ''],
  ['admin', 'Sign in', ''],
];

const ICONS: Record<string, ReactNode> = {
  overview: <path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z" />,
  try: <path d="M8 5.5v13l10.5-6.5z" />,
  members: <><circle cx="9" cy="9" r="3.2" /><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6" /><path d="M15.5 6.2a3 3 0 0 1 0 5.6M17 14.6c1.8.5 3 1.9 3.5 4.4" /></>,
  perks: <><rect x="4" y="9" width="16" height="11" rx="1.5" /><path d="M12 9v11M4 13h16M12 9c-1.5-3.5-5.5-4-5.5-1.5S10 9 12 9zm0 0c1.5-3.5 5.5-4 5.5-1.5S14 9 12 9z" /></>,
  ops: <><path d="M5 7h14M5 12h14M5 17h9" /></>,
  more: <><circle cx="6" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="18" cy="12" r="1.4" /></>,
};
const Icon = ({ id }: { id: string }) => <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">{ICONS[id]}</svg>;

function useRoute(): string {
  const read = () => location.hash.slice(1) || 'overview';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => { setRoute(read()); window.scrollTo(0, 0); };
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

function Dashboard({ cfg }: { cfg: ChainConfig }) {
  const { snapshot, error, checkedAt, refresh, recheck } = useSnapshot(cfg);
  const auth = useAuth(cfg, snapshot?.chainId);
  const route = useRoute();
  const [signingIn, setSigningIn] = useState(false);
  const stale = !!error;
  const section = route.split('/')[0];
  const active = { batch: 'batches', op: 'ops', row: 'members', data: 'members', member: 'members', l1tx: 'l1' }[section] ?? section;
  const meta = useProofMeta(snapshot?.batchCount);
  const deliveries = useIcmDeliveries(cfg.icm, snapshot?.relays ?? []);
  const priceRef = usePriceRef(cfg);
  const l1 = useSchoolL1(cfg.rpcUrl, cfg.l1, cfg.logRange);
  const l1Live = useL1Live(cfg.l1?.live, L1_UPGRADE_ACCOUNTS);
  const nav = PRIMARY.filter(([id]) => (id !== 'perks' || cfg.gate) && (id !== 'try' || cfg.gate));
  // Signed out it reads "Sign in"; signed in, the same entry is the admin page for whatever role the wallet holds.
  const more = MORE.filter(([id]) => id !== 'l1' || cfg.l1).map(([id, label, hint]): [string, string, string] => [id, id === 'admin' && auth.address ? 'Admin' : label, hint]);
  const inMore = more.some(([id]) => id === active);
  const [tech, setTech] = useTech();
  const [theme, toggleTheme] = useTheme();

  return (
    <>
      <header className="top">
        <Logo />
        <nav className="nav" aria-label="Sections">
          {nav.map(([id, label]) => <a key={id} href={`#${id}`} aria-current={active === id ? 'page' : undefined}>{label}</a>)}
          <More items={more} active={active} current={inMore} />
        </nav>
        <div className="top-right">
          {snapshot && <div className="tech-only"><Search s={snapshot} /></div>}
          {snapshot && section !== 'overview' && <Health stale={stale} matches={snapshot.matches} checkedAt={checkedAt} />}
          <TechSwitch on={tech} set={setTech} />
          <ThemeButton theme={theme} toggle={toggleTheme} />
          {snapshot && auth.address && <Account s={snapshot} auth={auth} />}
          <div className="m-only"><More items={more} active={active} current={inMore}><TechSwitch on={tech} set={setTech} /></More></div>
        </div>
      </header>

      <main className={section === 'overview' ? 'wrap home' : 'wrap'}>
        {error && (
          <div className="box alert" role="alert">
            <strong>Can't reach {cfg.network ?? 'the chain'} right now.</strong>
            <p>{snapshot ? 'Showing the last good read. ' : ''}It retries on its own.</p>
            <p className="note tech-only">{cfg.rpcUrl}: {error}</p>
          </div>
        )}
        {!snapshot && !error && (
          <section className="box loading" aria-busy="true">
            <div className="slots pulse" aria-hidden="true">{Array.from({ length: 16 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 60}ms` }} />)}</div>
            <div>
              <h2>Reading the ledger</h2>
              <p className="note">Your browser is re-checking every change on {cfg.network ?? 'the chain'}. This takes a few seconds.</p>
            </div>
          </section>
        )}
        {snapshot && <Page route={route} s={snapshot} stale={stale} cfg={cfg} meta={meta} deliveries={deliveries} priceRef={priceRef} l1={l1} l1Live={l1Live} auth={auth} onSignIn={() => setSigningIn(true)} onChanged={refresh} onRecheck={recheck} />}
      </main>

      <nav className="tabbar" aria-label="Sections">
        {nav.map(([id, label]) => <a key={id} href={`#${id}`} aria-current={active === id ? 'page' : undefined}><Icon id={id} />{label}</a>)}
      </nav>

      {signingIn && snapshot && <SignInDialog cfg={cfg} s={snapshot} auth={auth} onClose={() => setSigningIn(false)} />}
    </>
  );
}

function Page({ route, s, stale, cfg, meta, deliveries, priceRef, l1, l1Live, auth, onSignIn, onChanged, onRecheck }: { route: string; s: Snapshot; stale: boolean; cfg: ChainConfig; meta: ProofMetaMap; deliveries: Record<string, Delivery>; priceRef?: PriceRef; l1: { data?: SchoolL1State; error?: string }; l1Live: L1LiveState; auth: Auth; onSignIn: () => void; onChanged: () => void; onRecheck: () => Promise<number> }) {
  const [view, arg] = route.split('/');
  const id = Number(arg);
  switch (view) {
    case 'batches': return <Batches s={s} cfg={cfg} meta={meta} deliveries={deliveries} l1={l1.data} l1Live={l1Live.data} />;
    case 'batch': return <BatchDetail s={s} batchNo={id} cfg={cfg} meta={meta} deliveries={deliveries} priceRef={priceRef} l1={l1.data} l1Live={l1Live.data} />;
    case 'l1': return cfg.l1 ? <SchoolL1 s={s} cfg={cfg} data={l1.data} error={l1.error} live={l1Live} wallet={auth.wallet} onChanged={onChanged} /> : null;
    case 'l1tx': return <L1TxDetail cfg={cfg} hash={arg ?? ''} />;
    case 'try': return <Trial s={s} cfg={cfg} onChanged={onChanged} />;
    case 'perks': return <Perks s={s} cfg={cfg} wallet={auth.wallet} l1={l1.data} l1Live={l1Live.data} onChanged={onChanged} onSignIn={onSignIn} />;
    case 'ops': return <Ops s={s} />;
    case 'op': return <OpDetail s={s} id={id} />;
    case 'members': return <Members s={s} />;
    case 'member': return <MemberDetail s={s} id={id} />;
    case 'data': return <Data s={s} />;
    case 'row': return <RowDetail s={s} id={id} />;
    case 'admin': return <Admin s={s} cfg={cfg} address={auth.address} wallet={auth.wallet} onSignIn={onSignIn} onChanged={onChanged} />;
    default: return <Overview s={s} stale={stale} cfg={cfg} meta={meta} priceRef={priceRef} l1={l1.data} l1Live={l1Live} onCheck={onRecheck} />;
  }
}

function Search({ s }: { s: Snapshot }) {
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const cards = s.rows.filter((r) => r.table === PROGRAM.table).map((r) => ({ card: r.fields[CARD_FIELD], rowId: r.rowId }));
    const result = resolveSearch(query, { ...s, rowCount: s.nextRowId, verifier: s.verifier, cards });
    if ('route' in result) {
      location.hash = result.route;
      setQuery('');
      setError(null);
    } else {
      setError(result.error);
    }
  }
  return (
    <form className="search" role="search" onSubmit={submit}>
      <label className="sr-only" htmlFor="search">Search rows, changes, proofs and hashes</label>
      <input
        id="search"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setError(null); }}
        placeholder="Find a card, e.g. 0107"
        autoComplete="off"
        spellCheck={false}
        aria-describedby={error ? 'search-error' : undefined}
      />
      {error && <p id="search-error" className="search-error" role="alert">{error}</p>}
    </form>
  );
}

function Account({ s, auth }: { s: Snapshot; auth: Auth }) {
  if (!auth.address) return null;
  return (
    <div className="account">
      <span className="role mono">{rolesOf(s, auth.address).join(' + ')}</span>
      <span className="mono" title={auth.address}>{shortHex(auth.address)}</span>
      <button type="button" className="secondary small" onClick={() => void auth.logout()}>Sign out</button>
    </div>
  );
}

function SignInDialog({ cfg, s, auth, onClose }: { cfg: ChainConfig; s: Snapshot; auth: Auth; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [dev, setDev] = useState<DevAccount[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ref.current?.showModal();
    listDevAccounts(cfg, s.chainId).then(setDev).catch(() => setDev([]));
  }, [cfg, s.chainId]);

  async function finish(connect: () => Promise<Parameters<Auth['login']>[0] | null>) {
    setBusy(true);
    setError(null);
    try {
      const wallet = await connect();
      if (!wallet) throw new Error('No account was connected.');
      await auth.login(wallet);
      onClose();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  const browser = hasBrowserWallet();
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="signin-title">
      <div className="dialog-head">
        <h2 id="signin-title">Sign in</h2>
        <button type="button" className="secondary small" onClick={() => ref.current?.close()}>Close</button>
      </div>
      {browser && (
        <button type="button" className="primary" disabled={busy} onClick={() => void finish(() => connectBrowserWallet(s.chainId, false, cfg))}>Connect browser wallet</button>
      )}
      {dev.length > 0 && (
        <div className="dev-accounts">
          <div className="lab">{dev[0].kind === 'demo' ? 'Demo accounts · test keys on this machine' : 'Test accounts'}</div>
          {dev.map((a) => (
            <button key={a.address} type="button" className="dev-account" disabled={busy} onClick={() => void finish(async () => devWallet(cfg, a))}>
              <span className="mono">{shortHex(a.address)}</span>
              <span className="role mono">{rolesOf(s, a.address).join(' + ')}</span>
            </button>
          ))}
        </div>
      )}
      {!browser && dev.length === 0 && <p className="tx error">No wallet found.</p>}
      {busy && <p className="tx busy" role="status">Waiting for your signature…</p>}
      {error && <p className="tx error" role="alert">{error}</p>}
    </dialog>
  );
}

/** The secondary sections, in a small menu. Closes on choice, on Escape and on a click elsewhere. */
function More({ items, active, current, children }: { items: [string, string, string][]; active: string; current: boolean; children?: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      const d = ref.current;
      if (!d?.open) return;
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !d.contains(e.target as Node)) d.open = false;
    };
    const onHash = () => { if (ref.current) ref.current.open = false; };
    addEventListener('pointerdown', close);
    addEventListener('keydown', close);
    addEventListener('hashchange', onHash);
    return () => { removeEventListener('pointerdown', close); removeEventListener('keydown', close); removeEventListener('hashchange', onHash); };
  }, []);
  return (
    <details ref={ref} className="more">
      <summary aria-current={current ? 'page' : undefined}>More<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5l3-3" /></svg></summary>
      <div className="menu" role="menu">
        {items.map(([id, label, hint]) => (
          <a key={id} role="menuitem" href={`#${id}`} aria-current={active === id ? 'page' : undefined}>
            <b>{label}</b>{hint && <span>{hint}</span>}
          </a>
        ))}
        {children && <div className="menu-foot">{children}</div>}
      </div>
    </details>
  );
}

/** Plain by default; on, every screen also shows hashes, addresses, gas and proof numbers. */
function TechSwitch({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="tech-switch" title="Show hashes, addresses, gas and proof numbers">
      <input type="checkbox" role="switch" checked={on} onChange={(e) => set(e.target.checked)} />
      <span aria-hidden="true" />
      Chain details
    </label>
  );
}

/** Light or dark; the icon shows the theme a press switches to. */
function ThemeButton({ theme, toggle }: { theme: Theme; toggle: () => void }) {
  const toDark = theme === 'light';
  const label = toDark ? 'Switch to dark mode' : 'Switch to light mode';
  return (
    <button type="button" className="theme-btn" onClick={toggle} aria-label={label} title={label}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {toDark
          ? <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
          : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>}
      </svg>
    </button>
  );
}

/** One glance: does what this browser rebuilt match the chain? */
function Health({ stale, matches, checkedAt }: { stale: boolean; matches: boolean; checkedAt?: Date }) {
  const state = stale ? 'off' : matches ? 'ok' : 'bad';
  const label = { ok: 'Verified', bad: 'Mismatch', off: 'Offline' }[state];
  return (
    <span className={`health ${state}`} role="status" title={checkedAt ? `Checked at ${checkedAt.toLocaleTimeString('en-GB')}` : undefined}>
      <i aria-hidden="true" />{label}
    </span>
  );
}
