import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { formatEther, isAddress, type Abi, type Address, type Hex } from 'viem';
import { TxStatus, useTx } from './admin';
import { relayAbi, type ChainConfig, type Snapshot } from './chain';
import { formatAmount, formatGas, formatTime, plural, shortHex, toHex32 } from './format';
import { allowVerdict, l1ContractNames, mayUse, readAllowRoles, readL1Tx, roleName, ROLE_ADMIN, syncOf, type AllowEntry, type L1Live, type L1LiveConfig, type L1LiveState, type L1TxView } from './l1live';
import { L1_UPGRADE_TIME } from './l1seed';
import { roleLabel } from './roles';
import { joinClaims, joinRoots, type SchoolL1State } from './schoolL1';
import { Details, Empty, Hash, KeyValues, OnChain, Section, Table } from './ui';
import type { Wallet } from './wallet';

const TxLink = ({ hash, cfg }: { hash: string; cfg: ChainConfig }) => (cfg.explorer
  ? <a className="link ext mono" href={`${cfg.explorer}/tx/${hash}`} target="_blank" rel="noreferrer">{hash.slice(0, 8)}… ↗</a>
  : <Hash value={hash} />);

/** The L1 has no block explorer, so its transactions open in this dashboard, read from the public RPC. */
export const L1Tx = ({ hash }: { hash: string }) => <a className="link mono l1tx" href={`#l1tx/${hash}`} title={`L1 transaction ${hash}`}>{hash.slice(0, 8)}…</a>;

const zkd = (wei: bigint) => Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 2 });
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * The school's own L1 from both ends: what Fuji sent and got back over ICM, and what the L1 itself holds, read
 * from its public RPC. Without that RPC the page still shows the Fuji side.
 */
export function SchoolL1({ s, cfg, data, error, live, wallet, onChanged }: {
  s: Snapshot; cfg: ChainConfig; data?: SchoolL1State; error?: string; live: L1LiveState; wallet: Wallet | null; onChanged: () => void;
}) {
  const l1 = cfg.l1!;
  const chain = live.data;
  const perkName = (id: number) => s.perks.find((p) => p.id === id)?.name ?? chain?.perks.find((p) => p.id === id)?.name ?? `Perk #${id}`;
  const needs = (id: number, known?: bigint) => known ?? chain?.perks.find((p) => p.id === id)?.minPoints;
  const claims = joinClaims(data?.claims ?? [], chain?.forwarded);
  const roots = joinRoots(data?.roots ?? [], chain?.mirrored, claims);
  const senders = chain?.allow.filter((e) => mayUse(e.send)).length;
  const deployers = chain?.allow.filter((e) => mayUse(e.deploy)).length;
  return (
    <>
      <div className="page-title">
        <h2>School L1, <em>over ICM.</em></h2>
        <p className="note">{l1.name} · chain {l1.chainId}. Roots go in, claim receipts come back.</p>
      </div>
      {l1.live && <SyncBox s={s} cfg={cfg} live={live} wallet={wallet} onChanged={onChanged} />}
      {error && !data && <div className="box alert" role="alert"><strong>Cannot read the ICM contracts on {cfg.network ?? 'Fuji'}</strong><p>{error}</p></div>}
      {!data && !error && !chain && <section className="box loading" aria-busy="true"><p className="note mono">Reading {cfg.network ?? 'Fuji'}…</p></section>}
      {(data || chain) && (
        <>
          <section className="tiles four" aria-label="School L1 summary">
            <div className="box tile">
              <div className="lab">{chain ? 'Roots stored on the L1' : 'Roots sent to the L1'}</div>
              <div className="big">{chain ? chain.mirrored.length : data!.roots.length}</div>
              {roots[0] && <p className="note mono">latest: proof #{roots[0].batchNo}</p>}
            </div>
            <div className="box tile">
              <div className="lab">Claims checked on the L1</div>
              <div className="big">{chain ? chain.forwarded.length : data!.claims.length}</div>
              {data && <p className="note mono">{plural(data.claims.length, 'receipt')} on Fuji</p>}
            </div>
            <div className="box tile">
              <div className="lab">Handed out on Fuji</div>
              <div className="big">{data ? <>{data.redeemed}<span className="of mono">/{data.claims.length}</span></> : '—'}</div>
            </div>
            <a className="box tile" href="#l1-allow">
              <div className="lab">Who can write</div>
              {senders !== undefined
                ? <><div className="big">{senders}<span className="of mono"> wallets</span></div><p className="note mono">{deployers} of them may deploy</p></>
                : <><div className="big fee">Allow-listed</div><p className="note mono">send · deploy</p></>}
            </a>
          </section>

          <Section title="Claims checked on the L1" count={claims.length} note="PointsGate on the L1 checks the proof and spends the nullifier; ClaimForwarder sends the receipt to Fuji, where Teleporter records it in ClaimRegistry. The card stays hidden.">
            {claims.length === 0 ? <Empty>No claims yet.</Empty> : (
              <Table head={[['When', 'hide-m'], ['Perk'], ['Needs', 'right hide-m'], ['Against', 'hide-m'], ['Nullifier', 'hide-m'], ...(chain ? [['L1 tx'] as [string]] : []), ['Receipt on Fuji'], ['Desk']]}>
                {claims.map((c) => {
                  const min = needs(c.perkId, c.minPoints);
                  return (
                    <tr key={`${c.perkId}:${c.nullifier}`}>
                      <td className="mono hide-m">{formatTime(c.time)}</td>
                      <td>{perkName(c.perkId)}</td>
                      <td className="mono right hide-m">{min !== undefined ? formatAmount(min) : '—'}</td>
                      <td className="mono hide-m"><a className="link" href={`#batch/${c.batchNo}`}>proof #{c.batchNo}</a></td>
                      <td className="hide-m"><Hash value={c.nullifier} /></td>
                      {chain && <td>{c.l1Tx ? <L1Tx hash={c.l1Tx} /> : <span className="note">—</span>}</td>}
                      <td>{c.fujiTx ? <TxLink hash={c.fujiTx} cfg={cfg} /> : <span className="status pending"><i aria-hidden="true" />On its way</span>}</td>
                      <td>{c.redeemTx
                        ? <a className="status delivered link" href={`${cfg.explorer}/tx/${c.redeemTx}`} target="_blank" rel="noreferrer"><i aria-hidden="true" />Handed out</a>
                        : <span className="status pending"><i aria-hidden="true" />Not yet</span>}</td>
                    </tr>
                  );
                })}
              </Table>
            )}
          </Section>

          <Section title="Roots on the L1" count={roots.length} note="RootRelay on Fuji sends each proven root; Teleporter on the L1 hands it to RootMirror, which takes it from that relay only.">
            {roots.length === 0 ? <Empty>No roots sent yet.</Empty> : (
              <Table head={[['Proof'], ['Root', 'hide-m'], ['Sent from Fuji'], ...(chain ? [['Stored on the L1'] as [string]] : []), ['Claims against it', 'right hide-m']]}>
                {roots.map((r) => (
                  <tr key={r.batchNo}>
                    <td className="mono"><a className="link" href={`#batch/${r.batchNo}`}>#{r.batchNo}</a></td>
                    <td className="hide-m"><Hash value={r.root} /></td>
                    <td>{r.sentTx ? <TxLink hash={r.sentTx} cfg={cfg} /> : <span className="note">—</span>}</td>
                    {chain && <td>{r.storedTx ? <L1Tx hash={r.storedTx} /> : <span className="status pending"><i aria-hidden="true" />Waiting for the relayer</span>}</td>}
                    <td className="mono right hide-m">{r.claims}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>

          {chain && l1.live && <AllowList s={s} chain={chain} live={l1.live} token={l1.token} />}

          {chain && (
            <div className="columns even">
              <Section title="Latest L1 blocks" note="The L1 makes a block when a transaction arrives.">
                <Table head={[['Block'], ['Time'], ['Txs', 'right'], ['Gas used', 'right']]}>
                  {chain.blocks.map((b) => (
                    <tr key={b.number}>
                      <td className="mono">{b.number}</td>
                      <td className="mono">{formatTime(b.time)}</td>
                      <td className="mono right">{b.txs}</td>
                      <td className="mono right">{formatGas(b.gasUsed)}</td>
                    </tr>
                  ))}
                </Table>
              </Section>
              <Section title="Perks on the L1 gate" note="The same perks as the Fuji gate. Each gate keeps its own list of spent claims.">
                <Table head={[['Perk'], ['Needs', 'right'], ['Claimed on the L1', 'right'], ['On Fuji', 'right']]}>
                  {chain.perks.map((p) => (
                    <tr key={p.id}>
                      <td><b>{p.name}</b></td>
                      <td className="mono right">{formatAmount(p.minPoints)}</td>
                      <td className="mono right">{p.claims}</td>
                      <td className="mono right">{s.perks.find((x) => x.id === p.id)?.claims ?? '—'}</td>
                    </tr>
                  ))}
                </Table>
              </Section>
            </div>
          )}

          <KeyValues items={[
            ...(l1.live ? [['Public RPC (read-only)', <Hash value={l1.live.rpcUrl} full />] as [string, ReactNode]] : []),
            ['Blockchain ID', <Hash value={l1.blockchainId} full />],
            ...(l1.subnetId ? [['Subnet ID', <Hash value={l1.subnetId} full />] as [string, ReactNode]] : []),
            ...(l1.live ? [
              ['RootMirror (L1)', <Hash value={l1.live.mirror} />],
              ['PointsGate (L1)', <Hash value={l1.live.gate} />],
              ['ClaimForwarder (L1)', <Hash value={l1.live.forwarder} />],
              ...(l1.live.verifier ? [['ClaimVerifier (L1)', <Hash value={l1.live.verifier} />] as [string, ReactNode]] : []),
            ] as [string, ReactNode][] : []),
            ['RootRelay (Fuji)', <OnChain value={l1.relay} kind="address" />],
            ['ClaimRegistry (Fuji)', <OnChain value={l1.registry} kind="address" />],
            ['Gas on the L1', `${l1.token}, paid by the school's claim relayer`],
          ]} />
          {l1.live && (
            <Details label="Read it yourself">
              <pre>{[
                `RPC=${l1.live.rpcUrl}`,
                `cast call ${l1.live.mirror} "batchNo()(uint64)" --rpc-url $RPC`,
                `cast call ${l1.live.mirror} "root()(bytes32)" --rpc-url $RPC`,
                `cast call 0x0200000000000000000000000000000000000002 "readAllowList(address)(uint256)" <wallet> --rpc-url $RPC   # 0 none, 1 enabled, 2 admin`,
              ].join('\n')}</pre>
            </Details>
          )}
        </>
      )}
    </>
  );
}

/** The school L1 in one line on the overview: is its root current, how far its chain is, how much it has done. */
export function L1Band({ s, cfg, data, live }: { s: Snapshot; cfg: ChainConfig; data?: SchoolL1State; live: L1LiveState }) {
  const l1 = cfg.l1!;
  const chain = live.data;
  const sync = chain ? syncOf(chain.mirror, s) : undefined;
  const claims = chain ? chain.forwarded.length : data?.claims.length;
  const writers = chain?.allow.filter((e) => mayUse(e.send)).length;
  return (
    <a className="box l1-band" href="#l1" aria-label={`School L1: ${l1.name}`}>
      <span className="lab">School L1 · {l1.name} · chainId {l1.chainId}</span>
      {chain && sync === 'synced' && <span className="status delivered"><i aria-hidden="true" />Root #{chain.mirror.batchNo} in sync</span>}
      {chain && sync === 'behind' && <span className="status needs"><i aria-hidden="true" />Holds root #{chain.mirror.batchNo}, Fuji is at #{s.batchCount}</span>}
      {chain && sync === 'mismatch' && <span className="status failed"><i aria-hidden="true" />Root #{chain.mirror.batchNo} differs from Fuji</span>}
      {chain && sync === 'ahead' && <span className="status pending"><i aria-hidden="true" />Root #{chain.mirror.batchNo}</span>}
      {!chain && <span className="status pending"><i aria-hidden="true" />{!l1.live ? 'Read through Fuji' : live.error ? 'L1 RPC did not answer' : 'Reading the L1…'}</span>}
      {chain && <span className="mono note">block {chain.head}</span>}
      {claims !== undefined && <span className="note">{plural(claims, 'claim')} checked there</span>}
      {writers !== undefined && <span className="note hide-m">{plural(writers, 'wallet')} may write</span>}
      <span className="link open">Open</span>
    </a>
  );
}

/**
 * Whether the L1 checks claims against the root Fuji holds now. Same shape as "Data verified" on the overview:
 * a verdict, one sentence on how it was reached, and the reading it came from.
 */
function SyncBox({ s, cfg, live, wallet, onChanged }: { s: Snapshot; cfg: ChainConfig; live: L1LiveState; wallet: Wallet | null; onChanged: () => void }) {
  const l1 = cfg.l1!;
  const tx = useTx(cfg, wallet, onChanged);
  const chain = live.data;
  if (!chain) {
    return live.error ? (
      <section className="box intro unknown" role="alert">
        <div className="verdict">
          <svg className="mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" /></svg>
          <div>
            <h1>The L1 RPC did not answer</h1>
            <p className="note how">{host(l1.live!.rpcUrl)}: {live.error} The tables below show the Fuji side of the link.</p>
          </div>
        </div>
      </section>
    ) : <section className="box loading" aria-busy="true"><p className="note mono">Reading {l1.name} from {host(l1.live!.rpcUrl)}…</p></section>;
  }
  const sync = syncOf(chain.mirror, s);
  const gap = s.batchCount - chain.mirror.batchNo;
  const state = sync === 'synced' ? 'match' : sync === 'mismatch' ? 'mismatch' : sync === 'behind' ? 'behind' : 'unknown';
  const title = { synced: 'Root in sync', behind: `The L1 is ${plural(gap, 'root')} behind`, mismatch: 'Roots differ', ahead: 'Waiting for Fuji' }[sync];
  const how = {
    synced: `RootMirror on the L1 holds root #${chain.mirror.batchNo}, the same 32 bytes ZkDB holds on Fuji. Claims there are checked against it.`,
    behind: `RootMirror holds root #${chain.mirror.batchNo}; ZkDB on Fuji is at #${s.batchCount}. Claims on the L1 are checked against #${chain.mirror.batchNo} until RootRelay sends the new root.`,
    mismatch: `Both chains say root #${chain.mirror.batchNo}, with different values.`,
    ahead: `The L1 already holds root #${chain.mirror.batchNo}; this page's Fuji read is at #${s.batchCount} and will catch up.`,
  }[sync];
  const busy = tx.state.kind === 'busy';
  return (
    <section className={`box intro ${state}`} aria-labelledby="l1-sync-title">
      <div className="intro-head">
        <div className="verdict">
          <svg className="mark" viewBox="0 0 16 16" aria-hidden="true">
            {sync === 'synced' && <path d="M3 8.5 6.5 12 13 4.5" />}
            {sync === 'mismatch' && <path d="M4 4l8 8M12 4l-8 8" />}
            {(sync === 'behind' || sync === 'ahead') && <path d="M3 8h10" />}
          </svg>
          <div>
            <h1 id="l1-sync-title">{title}</h1>
            <p className="note how">{how}</p>
          </div>
        </div>
        <dl className="roots l1-head mono">
          <div><dt>L1 block</dt><dd>{chain.head} · {formatTime(chain.headTime)}</dd></div>
          <div><dt>Read from</dt><dd><i className={live.error ? 'dot off' : 'dot on'} aria-hidden="true" /> {host(l1.live!.rpcUrl)}{live.checkedAt && ` · ${live.checkedAt.toLocaleTimeString('en-GB')}`}</dd></div>
        </dl>
      </div>
      {sync === 'mismatch' && (
        <dl className="roots">
          <div><dt>Fuji</dt><dd><Hash value={toHex32(s.root)} /></dd></div>
          <div><dt>L1</dt><dd><Hash value={chain.mirror.root} /></dd></div>
        </dl>
      )}
      {sync === 'behind' && (
        <div className="row-actions">
          {wallet
            ? <button type="button" className="primary" disabled={busy} onClick={() => void tx.run(() => tx.send('relay', [], `Root #${s.batchCount} sent. The relayer delivers it to the L1 in a few seconds.`, { address: l1.relay, abi: relayAbi as Abi }))}>Send root #{s.batchCount} to the L1</button>
            : <p className="note">Any signed-in wallet can send it: the relay contract reads the root from ZkDB itself.</p>}
        </div>
      )}
      <TxStatus state={tx.state} />
      {live.error && <p className="note">The L1 RPC did not answer the last read ({live.error}). Figures are from the read before it.</p>}
    </section>
  );
}

const RoleBadge = ({ role }: { role: number }) => (mayUse(role)
  ? <span className={`status ${role === ROLE_ADMIN ? 'applied' : 'delivered'}`}><i aria-hidden="true" />{roleName(role)}</span>
  : <span className="status pending"><i aria-hidden="true" />No</span>);

function since(e: AllowEntry): ReactNode {
  const last = e.changes[e.changes.length - 1];
  if (!last) return <span className="note">network upgrade{L1_UPGRADE_TIME ? `, ${formatTime(L1_UPGRADE_TIME)}` : ''}</span>;
  const verb = mayUse(last.role) ? `${last.list} ${roleName(last.role).toLowerCase()}` : `${last.list} removed`;
  return <span className="note">{verb} in block {last.block} · <L1Tx hash={last.txHash} /></span>;
}

function usedFor(e: AllowEntry): string {
  const parts = [e.rootsDelivered ? `delivered ${plural(e.rootsDelivered, 'root')}` : '', e.claimsSent ? `sent ${plural(e.claimsSent, 'claim')}` : ''].filter(Boolean);
  return parts.join(' · ') || '—';
}

/** The two allow-lists as the precompiles answer now, and a field to ask them about any other wallet. */
function AllowList({ s, chain, live, token }: { s: Snapshot; chain: L1Live; live: L1LiveConfig; token: string }) {
  return (
    <Section
      id="l1-allow"
      title="Who can write to the L1"
      count={chain.allow.length}
      note="Read from the TxAllowList and ContractDeployerAllowList precompiles at this block. A wallet on neither list is refused by the node."
    >
      <Table head={[['Wallet'], ['Send'], ['Deploy'], ['On the list since', 'hide-m'], ['Used for', 'hide-m'], [token, 'right hide-m']]}>
        {chain.allow.map((e) => {
          const label = roleLabel(s, e.account);
          return (
            <tr key={e.account}>
              <td><span className="onchain"><Hash value={e.account} />{label && <span className="role mono">{label} on Fuji</span>}</span></td>
              <td><RoleBadge role={e.send} /></td>
              <td><RoleBadge role={e.deploy} /></td>
              <td className="hide-m">{since(e)}</td>
              <td className="note hide-m">{usedFor(e)}</td>
              <td className="mono right hide-m">{zkd(e.balance)}</td>
            </tr>
          );
        })}
      </Table>
      <AllowCheck live={live} token={token} />
    </Section>
  );
}

type Checked = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string } | { kind: 'done'; account: Address; send: number; deploy: number; balance: bigint };

function AllowCheck({ live, token }: { live: L1LiveConfig; token: string }) {
  const [value, setValue] = useState('');
  const [state, setState] = useState<Checked>({ kind: 'idle' });
  async function check(e: FormEvent) {
    e.preventDefault();
    const account = value.trim();
    if (!isAddress(account)) return setState({ kind: 'error', message: 'Enter a wallet address: 0x and 40 hex characters.' });
    setState({ kind: 'busy' });
    try {
      setState({ kind: 'done', account, ...(await readAllowRoles(live, account)) });
    } catch {
      setState({ kind: 'error', message: 'The L1 RPC did not answer. Try again.' });
    }
  }
  return (
    <form className="box padded allow-check" onSubmit={check}>
      <label htmlFor="allow-check">Ask the L1 about any wallet</label>
      <div className="allow-check-row">
        <input id="allow-check" className="mono" value={value} onChange={(e) => { setValue(e.target.value); setState({ kind: 'idle' }); }} placeholder="0x…" autoComplete="off" spellCheck={false} />
        <button type="submit" className="secondary" disabled={state.kind === 'busy'}>Check</button>
      </div>
      {state.kind === 'busy' && <p className="tx busy" role="status">Asking the precompiles…</p>}
      {state.kind === 'error' && <p className="tx error" role="alert">{state.message}</p>}
      {state.kind === 'done' && (
        <p className={`tx ${mayUse(state.send) ? 'done' : 'error'}`} role="status">
          <span className="mono">{shortHex(state.account)}</span>{' '}
          {allowVerdict(state.send, state.deploy)} It holds {zkd(state.balance)} {token}.
        </p>
      )}
    </form>
  );
}

/** One L1 transaction, read from the public RPC. Stands in for a block explorer page. */
export function L1TxDetail({ cfg, hash }: { cfg: ChainConfig; hash: string }) {
  const live = cfg.l1?.live;
  const valid = /^0x[0-9a-fA-F]{64}$/.test(hash);
  const [state, setState] = useState<{ tx?: L1TxView | null; error?: string }>({});
  useEffect(() => {
    if (!live || !valid) return;
    let cancelled = false;
    setState({});
    readL1Tx(live, hash as Hex).then(
      (tx) => { if (!cancelled) setState({ tx }); },
      () => { if (!cancelled) setState({ error: 'The L1 RPC did not answer. Reload to try again.' }); },
    );
    return () => { cancelled = true; };
  }, [live, hash, valid]);

  const back = <a className="link back" href="#l1">← School L1</a>;
  if (!live || !valid) return <>{back}<Empty>That is not an L1 transaction hash.</Empty></>;
  if (state.error) return <>{back}<div className="box alert" role="alert"><strong>Cannot read the transaction</strong><p>{state.error}</p></div></>;
  if (state.tx === undefined) return <>{back}<section className="box loading" aria-busy="true"><p className="note mono">Reading {cfg.l1!.name}…</p></section></>;
  if (state.tx === null) return <>{back}<Empty>No transaction with this hash on {cfg.l1!.name}.</Empty></>;
  const tx = state.tx;
  const names = l1ContractNames(live);
  const named = (a: string) => names[a.toLowerCase()];
  const events = tx.logs.reduce<{ name: string; count: number }[]>((out, l) => {
    const name = `${l.name ?? 'Event'} · ${named(l.address) ?? shortHex(l.address)}`;
    const hit = out.find((x) => x.name === name);
    if (hit) hit.count += 1; else out.push({ name, count: 1 });
    return out;
  }, []);
  return (
    <>
      {back}
      <Section title="L1 transaction" note={`${cfg.l1!.name} has no block explorer. This is its receipt, read from ${host(live.rpcUrl)}.`}>
        <KeyValues items={[
          ['Hash', <Hash value={tx.hash} full />],
          ['Status', tx.status === 'success'
            ? <span className="status delivered"><i aria-hidden="true" />Succeeded</span>
            : <span className="status failed"><i aria-hidden="true" />Reverted</span>],
          ['Block', <span className="mono">{tx.block} · {formatTime(tx.time)}</span>],
          ['From', <Hash value={tx.from} />],
          ['To', tx.to
            ? <span className="onchain">{named(tx.to) && <b>{named(tx.to)}</b>}<Hash value={tx.to} /></span>
            : <span className="onchain">New contract{tx.created && <Hash value={tx.created} />}</span>],
          ['Called', <span className="mono">{tx.call}</span>],
          ['Gas used', <span className="mono">{formatGas(tx.gasUsed)}</span>],
          ['Fee', <span className="mono">{Number(formatEther(tx.fee)).toLocaleString('en-US', { maximumFractionDigits: 6 })} {cfg.l1!.token}</span>],
          ['Events', events.length
            ? <span className="stack">{events.map((e) => <span key={e.name} className="mono">{e.name}{e.count > 1 ? ` × ${e.count}` : ''}</span>)}</span>
            : 'None'],
        ]} />
      </Section>
    </>
  );
}
