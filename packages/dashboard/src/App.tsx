import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Admin } from './admin';
import { Perks } from './perks';
import { SchoolL1 } from './l1view';
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
        <h2>No contract to watch yet</h2>
        <p>Run the local demo. It starts anvil, deploys the contracts and opens this dashboard:</p>
        <pre>npm run demo -w @zkdb/dashboard</pre>
        <p>Or set <code>VITE_ZKDB_ADDRESS</code> and <code>VITE_RPC_URL</code> in <code>packages/dashboard/.env.local</code>.</p>
      </section>
    </main>
  );
}

/** One name everywhere: zkDB. What it is here, a points ledger, sits beside it in small type. */
const Logo = () => <a className="logo" href="#overview">zkDB<small>points ledger</small></a>;

const NAV: [string, string][] = [['overview', 'Overview'], ['members', 'Members'], ['ops', 'Activity'], ['batches', 'Proofs'], ['perks', 'Perks'], ['l1', 'School L1'], ['admin', 'Manage']];

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
  const active = { batch: 'batches', op: 'ops', row: 'members', data: 'members', member: 'members' }[section] ?? section;
  const meta = useProofMeta(snapshot?.batchCount);
  const deliveries = useIcmDeliveries(cfg.icm, snapshot?.relays ?? []);
  const priceRef = usePriceRef(cfg);
  const l1 = useSchoolL1(cfg.rpcUrl, cfg.l1, cfg.logRange);
  const nav = NAV.filter(([id]) => (id !== 'perks' || cfg.gate) && (id !== 'l1' || cfg.l1));

  return (
    <>
      <ChainStrip s={snapshot} />
      <header className="top">
        <Logo />
        <nav aria-label="Sections">
          {nav.map(([id, label]) => <a key={id} href={`#${id}`} aria-current={active === id ? 'page' : undefined}>{label}</a>)}
        </nav>
        {snapshot && <Search s={snapshot} />}
        <div className="top-right">
          {snapshot && (
            <div className="live mono">
              {cfg.network && <span className="net">{cfg.network}</span>}
              <i className={stale ? 'dot off' : 'dot on'} aria-hidden="true" />
              {stale ? 'Offline' : 'Live'}<span className="blk"> · block {snapshot.block.toString()}</span>
              <span className="checked">· {checkedAt?.toLocaleTimeString('en-GB')}</span>
            </div>
          )}
          {snapshot && <Account s={snapshot} auth={auth} onSignIn={() => setSigningIn(true)} />}
        </div>
      </header>

      <main className="wrap">
        {error && (
          <div className="box alert" role="alert">
            <strong>Cannot read from {cfg.rpcUrl}</strong>
            <p>{error}{snapshot ? ' Figures below are from the last successful read.' : ''}</p>
          </div>
        )}
        {!snapshot && !error && (
          <section className="box loading" aria-busy="true">
            <div className="slots pulse" aria-hidden="true">{Array.from({ length: 16 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 60}ms` }} />)}</div>
            <p className="note mono">Reading {cfg.network ?? 'the chain'}…</p>
          </section>
        )}
        {snapshot && <Page route={route} s={snapshot} stale={stale} cfg={cfg} meta={meta} deliveries={deliveries} priceRef={priceRef} l1={l1} auth={auth} onSignIn={() => setSigningIn(true)} onChanged={refresh} onRecheck={recheck} />}
      </main>

      {signingIn && snapshot && <SignInDialog cfg={cfg} s={snapshot} auth={auth} onClose={() => setSigningIn(false)} />}
    </>
  );
}

function Page({ route, s, stale, cfg, meta, deliveries, priceRef, l1, auth, onSignIn, onChanged, onRecheck }: { route: string; s: Snapshot; stale: boolean; cfg: ChainConfig; meta: ProofMetaMap; deliveries: Record<string, Delivery>; priceRef?: PriceRef; l1: { data?: SchoolL1State; error?: string }; auth: Auth; onSignIn: () => void; onChanged: () => void; onRecheck: () => Promise<number> }) {
  const [view, arg] = route.split('/');
  const id = Number(arg);
  switch (view) {
    case 'batches': return <Batches s={s} cfg={cfg} meta={meta} deliveries={deliveries} />;
    case 'batch': return <BatchDetail s={s} batchNo={id} cfg={cfg} meta={meta} deliveries={deliveries} priceRef={priceRef} />;
    case 'l1': return cfg.l1 ? <SchoolL1 s={s} cfg={cfg} data={l1.data} error={l1.error} /> : null;
    case 'perks': return <Perks s={s} cfg={cfg} wallet={auth.wallet} onChanged={onChanged} />;
    case 'ops': return <Ops s={s} />;
    case 'op': return <OpDetail s={s} id={id} />;
    case 'members': return <Members s={s} />;
    case 'member': return <MemberDetail s={s} id={id} />;
    case 'data': return <Data s={s} />;
    case 'row': return <RowDetail s={s} id={id} />;
    case 'admin': return <Admin s={s} cfg={cfg} address={auth.address} wallet={auth.wallet} onSignIn={onSignIn} onChanged={onChanged} />;
    default: return <Overview s={s} stale={stale} cfg={cfg} meta={meta} priceRef={priceRef} onCheck={onRecheck} />;
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
        className="mono"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setError(null); }}
        placeholder="Card, proof, change or tx"
        autoComplete="off"
        spellCheck={false}
        aria-describedby={error ? 'search-error' : undefined}
      />
      {error && <p id="search-error" className="search-error" role="alert">{error}</p>}
    </form>
  );
}

function Account({ s, auth, onSignIn }: { s: Snapshot; auth: Auth; onSignIn: () => void }) {
  if (!auth.address) return <button type="button" className="primary small" onClick={onSignIn}>Sign in</button>;
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
      {!browser && dev.length === 0 && <p className="tx error">No wallet found. Install a browser wallet to sign in.</p>}
      {busy && <p className="tx busy" role="status">Waiting for your signature…</p>}
      {error && <p className="tx error" role="alert">{error}</p>}
    </dialog>
  );
}

/** Top edge of the page: one square per change, oldest on the left. Empty proof slots are not drawn. */
function ChainStrip({ s }: { s?: Snapshot }) {
  const ops = s ? [...s.ops].sort((a, b) => a.id - b.id).slice(-72) : [];
  const kind = (status: string) => (status === 'applied' ? 'ok' : status === 'failed' ? 'fail' : 'pending');
  return (
    <div className="strip" role="img" aria-label={`The last ${ops.length} changes, newest on the right`}>
      {ops.map((o) => <i key={o.id} className={`slot-${kind(o.status)}`} />)}
      <b><span>{s ? `the last ${ops.length} changes · blue confirmed · red rejected · light waiting` : ''}</span></b>
    </div>
  );
}
