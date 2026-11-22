import { useEffect, useState, type ReactNode } from 'react';
import type { Hex } from 'viem';
import { buildClaim, cardKey } from '@zkdb/core';
import { createReader, type ChainConfig } from './chain';
import { proveClaimHere } from './claimProver';
import { toHex32 } from './format';
import { newCardSecret, newPickupCode, pickupHash } from './pickup';
import { Hash, OnChain, Section } from './ui';
import { BatchArt, CardArt, ClaimArt } from './art';
import { formatMs } from './useProofMeta';
import { relayClaim, trialBatch, trialCard, trialInfo, type TrialInfo } from './wallet';

type Step = 'card' | 'batch' | 'claim';
interface Done { label: string; hash: string; note?: string }
type Status = { kind: 'idle' } | { kind: 'busy'; label: string } | { kind: 'error'; message: string };

const storeKey = (cfg: ChainConfig) => `zkdb.trial.${cfg.address.toLowerCase()}`;

/**
 * Try it without a wallet and without AVAX. Three real transactions on the network this page watches, each linked to
 * the explorer as soon as it lands:
 *   1. the server's trial key inserts a card for a key made on this device, and awards it points;
 *   2. the server proves the batch with the batch circuit and submits it; ZkDB checks the proof;
 *   3. this browser proves "a card in the table has at least N points" and the relayer sends it; PointsGate checks it.
 * The trial table is separate from the club's, and the server caps cards and proofs per hour and per visitor.
 */
export function Trial({ cfg, onChanged }: { cfg: ChainConfig; onChanged: () => void }) {
  const [info, setInfo] = useState<TrialInfo | null>(null);
  const [secret, setSecret] = useState<bigint | null>(() => {
    try {
      const v = localStorage.getItem(storeKey(cfg));
      return v ? BigInt(v) : null;
    } catch {
      return null;
    }
  });
  const [step, setStep] = useState<Step>('card');
  const [done, setDone] = useState<Done[]>([]);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [code, setCode] = useState<Hex | null>(null);

  useEffect(() => {
    trialInfo().then(setInfo).catch(() => setInfo({ enabled: false }));
  }, []);

  const busy = status.kind === 'busy';
  const fail = (e: unknown) => setStatus({ kind: 'error', message: (e as Error).message || 'Something went wrong.' });

  async function makeCard() {
    const s = newCardSecret();
    setStatus({ kind: 'busy', label: 'Adding your card…' });
    try {
      const r = await trialCard(toHex32(cardKey(s)) as Hex);
      try {
        localStorage.setItem(storeKey(cfg), toHex32(s));
      } catch {
        // Private window: the secret lives only in this page.
      }
      setSecret(s);
      setDone(r.txs.map((t) => ({
        label: t.step === 'insert' ? `Card #${r.card} added` : `${r.points} points awarded`,
        hash: t.hash,
        note: `${Number(t.gasUsed).toLocaleString('en')} gas`,
      })));
      setStep('batch');
      setStatus({ kind: 'idle' });
      // The hourly allowance just went down by one.
      trialInfo().then(setInfo).catch(() => {});
      onChanged();
    } catch (e) {
      fail(e);
    }
  }

  async function proveBatch() {
    setStatus({ kind: 'busy', label: 'Proving the batch…' });
    try {
      const r = await trialBatch();
      if (r.txHash) {
        setDone((d) => [...d, {
          label: `Batch proof verified on-chain · ${r.consumed} changes`,
          hash: r.txHash!,
          note: `proved in ${formatMs(r.provingMs ?? 0)} · ${Number(r.gasUsed).toLocaleString('en')} gas`,
        }, ...(r.relayed ?? []).map((x) => ({
          label: `New root sent to ${x.to} over ICM`,
          hash: x.txHash,
          note: `${Number(x.gasUsed).toLocaleString('en')} gas`,
        }))]);
      }
      setStep('claim');
      setStatus({ kind: 'idle' });
      onChanged();
    } catch (e) {
      fail(e);
    }
  }

  async function claim() {
    if (secret === null || !info?.table || info.perkId === undefined || !cfg.gate) return;
    setStatus({ kind: 'busy', label: 'Reading the ledger…' });
    try {
      const snapshot = await createReader(cfg).snapshot();
      if (!snapshot.matches) throw new Error('The rebuilt table does not match the root on-chain. Try again in a moment.');
      const perk = snapshot.perks.find((p) => p.id === info.perkId);
      if (!perk) throw new Error('The trial perk is not on the gate.');
      const pickup = newPickupCode();
      const built = buildClaim(snapshot.state, BigInt(info.table), { id: BigInt(perk.id), minPoints: perk.minPoints }, secret, pickupHash(pickup));
      if (!built.ok) {
        throw new Error(built.reason === 'unknown_card'
          ? 'Your card is not in the proven table yet. Run step 2 first.'
          : `Your card has ${built.balance} of the ${perk.minPoints} points needed.`);
      }
      setStatus({ kind: 'busy', label: 'Proving on this device…' });
      const { proof, ms } = await proveClaimHere(built.input);
      setStatus({ kind: 'busy', label: 'Sending the proof…' });
      const { txHash, gasUsed } = await relayClaim({ proof, perkId: perk.id, nullifier: toHex32(built.input.nullifier) as Hex, pickup: toHex32(built.input.pickup) as Hex });
      setDone((d) => [...d, {
        label: `Claim verified: ≥ ${perk.minPoints} points, card hidden`,
        hash: txHash,
        note: `proved in this browser in ${formatMs(ms)} · ${Number(gasUsed).toLocaleString('en')} gas`,
      }]);
      setCode(pickup);
      setStatus({ kind: 'idle' });
      onChanged();
    } catch (e) {
      fail(e);
    }
  }

  function restart() {
    setDone([]);
    setCode(null);
    setStep('card');
    setStatus({ kind: 'idle' });
  }

  if (!info) return <div className="box loading"><p className="note">Checking the trial…</p></div>;
  if (!info.enabled) {
    return (
      <>
        <Title />
        <div className="box message">
          <h2>Trial is off on this server</h2>
          <p className="note">Start the API with <code>TRIAL_KEY</code> and <code>ZKDB_TRIAL_PERK</code>.</p>
        </div>
      </>
    );
  }

  const steps: { id: Step; title: string; text: string; art: ReactNode; action: string; run: () => Promise<void> }[] = [
    { id: 'card', title: 'Get a card', text: 'Your browser makes a secret. Only its hash is sent.', art: <CardArt />, action: 'Get a trial card', run: makeCard },
    { id: 'batch', title: 'Prove the batch', text: 'One proof checks every change against the rules.', art: <BatchArt />, action: 'Prove and submit', run: proveBatch },
    { id: 'claim', title: 'Claim privately', text: "Prove you have enough points without saying which card.", art: <ClaimArt />, action: 'Prove and claim', run: claim },
  ];
  const order: Step[] = ['card', 'batch', 'claim'];
  const finished = code !== null;
  const phase = (id: Step) => (finished || order.indexOf(id) < order.indexOf(step) ? 'done' : id === step ? 'now' : 'later');

  return (
    <>
      <Title quota={info.cardsLeftThisHour} currency={cfg.currency} />
      <div className="steps">
        {steps.map((x, i) => {
          const p = phase(x.id);
          return (
            <section key={x.id} className={`box step ${p}`} aria-current={p === 'now' ? 'step' : undefined}>
              <div className="step-head">
                <span className="step-num">{p === 'done' ? '✓' : i + 1}</span>
                {p === 'done' && <span className="tag">Done</span>}
              </div>
              {x.art}
              <h3>{x.title}</h3>
              <p>{x.text}</p>
              {p === 'now' && (
                <div className="row-actions">
                  <button type="button" className="primary" disabled={busy} onClick={() => void x.run()}>{x.action}</button>
                </div>
              )}
            </section>
          );
        })}
      </div>
      {status.kind === 'busy' && <p className="tx busy" role="status">{status.label}</p>}
      {status.kind === 'error' && <p className="tx error" role="alert">{status.message}</p>}

      {finished && (
        <section className="box done-card" role="status">
          <div className="stack-form">
            <h3>Written, proven,<br /><em>claimed.</em></h3>
            <div className="lab">Your pickup code · stays on this device</div>
            <Hash value={code} full />
            <div className="row-actions"><button type="button" className="secondary small" onClick={restart}>Start again</button></div>
          </div>
          <ClaimArt />
        </section>
      )}

      {done.length > 0 && (
        <Section title="On-chain" count={done.length}>
          <ol className="box txlist">
            {done.map((d) => (
              <li key={d.hash}>
                <span className="tick"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.5 5 9l4.5-5.5" /></svg></span>
                <div><b>{d.label}</b><p className="note">{d.note}</p></div>
                <OnChain value={d.hash} kind="tx" />
              </li>
            ))}
          </ol>
        </Section>
      )}
    </>
  );
}

function Title({ quota, currency }: { quota?: number; currency?: string }) {
  return (
    <div className="page-title">
      <h2>Try it, <em>no wallet needed.</em></h2>
      <p className="note">
        Every step is a real transaction. The server pays the gas.
        {quota !== undefined && <span className="trial-quota"><b>{quota}</b> cards left this hour</span>}
      </p>
    </div>
  );
}
