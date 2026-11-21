import type { ChainConfig, Snapshot } from './chain';
import { formatAmount, formatTime } from './format';
import type { SchoolL1State } from './schoolL1';
import { Empty, Hash, KeyValues, OnChain, Section, Table } from './ui';

const TxLink = ({ hash, cfg }: { hash: string; cfg: ChainConfig }) => (cfg.explorer
  ? <a className="link ext mono" href={`${cfg.explorer}/tx/${hash}`} target="_blank" rel="noreferrer">{hash.slice(0, 8)}… ↗</a>
  : <Hash value={hash} />);

/**
 * The school's own L1, seen from Fuji: proven roots sent to it and the claim receipts it sent back over ICM.
 * Every row is a Fuji transaction a visitor can open; the L1's own RPC is not public.
 */
export function SchoolL1({ s, cfg, data, error }: { s: Snapshot; cfg: ChainConfig; data?: SchoolL1State; error?: string }) {
  const l1 = cfg.l1!;
  const perkName = (id: number) => s.perks.find((p) => p.id === id)?.name ?? `Perk #${id}`;
  return (
    <>
      <div className="page-title">
        <h2>School L1</h2>
        <p className="note">
          {l1.name}, chainId {l1.chainId}. Members claim perks there; only wallets the school enabled can send or deploy.
          Roots go in and claim receipts come back over Avalanche ICM.
        </p>
      </div>
      {error && !data && <div className="box alert" role="alert"><strong>Cannot read the ICM contracts</strong><p>{error}</p></div>}
      {!data && !error && <section className="box loading" aria-busy="true"><p className="note mono">Reading {cfg.network ?? 'Fuji'}…</p></section>}
      {data && (
        <>
          <section className="tiles four" aria-label="School L1 summary">
            <div className="box tile">
              <div className="lab">Roots sent to the L1</div>
              <div className="big">{data.roots.length}</div>
              {data.roots[0] && <p className="note mono">latest: proof #{data.roots[0].batchNo}</p>}
            </div>
            <div className="box tile">
              <div className="lab">Claims received</div>
              <div className="big">{data.claims.length}</div>
              <p className="note mono">checked on the L1</p>
            </div>
            <div className="box tile">
              <div className="lab">Redeemed on Fuji</div>
              <div className="big">{data.redeemed}<span className="of mono">/{data.claims.length}</span></div>
            </div>
            <div className="box tile">
              <div className="lab">Who can write</div>
              <div className="big fee">Allow-listed</div>
              <p className="note mono">send · deploy</p>
            </div>
          </section>

          <Section title="Claims from the L1" count={data.claims.length} note="Each receipt arrives signed by the L1 validator; Teleporter on Fuji records it in ClaimRegistry. The card stays hidden.">
            {data.claims.length === 0 ? <Empty>No claims received yet.</Empty> : (
              <Table head={[['Received'], ['Perk'], ['Needs', 'right'], ['Against', 'hide-m'], ['Nullifier', 'hide-m'], ['Desk'], ['Fuji tx']]}>
                {data.claims.map((c) => (
                  <tr key={c.txHash}>
                    <td className="mono">{formatTime(c.time)}</td>
                    <td>{perkName(c.perkId)}</td>
                    <td className="mono right">{formatAmount(c.minPoints)}</td>
                    <td className="mono hide-m"><a className="link" href={`#batch/${c.batchNo}`}>proof #{c.batchNo}</a></td>
                    <td className="hide-m"><Hash value={c.nullifier} /></td>
                    <td>{c.redeemTx
                      ? <a className="status delivered link" href={`${cfg.explorer}/tx/${c.redeemTx}`} target="_blank" rel="noreferrer"><i aria-hidden="true" />Redeemed</a>
                      : <span className="status pending"><i aria-hidden="true" />Not yet</span>}</td>
                    <td><TxLink hash={c.txHash} cfg={cfg} /></td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>

          <Section title="Roots sent to the L1" count={data.roots.length} note="RootRelay sends each proven root; the L1 stores it and checks claims against it.">
            {data.roots.length === 0 ? <Empty>No roots sent yet.</Empty> : (
              <Table head={[['Proof'], ['Root', 'hide-m'], ['Claims against it', 'right'], ['Fuji tx']]}>
                {data.roots.map((r) => (
                  <tr key={r.txHash}>
                    <td className="mono"><a className="link" href={`#batch/${r.batchNo}`}>#{r.batchNo}</a></td>
                    <td className="hide-m"><Hash value={r.root} /></td>
                    <td className="mono right">{r.claims}</td>
                    <td><TxLink hash={r.txHash} cfg={cfg} /></td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>

          <KeyValues items={[
            ['Blockchain ID', <Hash value={l1.blockchainId} full />],
            ['RootRelay (Fuji)', <OnChain value={l1.relay} kind="address" />],
            ['ClaimRegistry (Fuji)', <OnChain value={l1.registry} kind="address" />],
            ['Gas on the L1', `${l1.token}, paid by the school's claim relayer`],
          ]} />
        </>
      )}
    </>
  );
}
