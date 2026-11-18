# zkDB demo flows

## Before recording

```bash
npm run prerecord -w @zkdb/dashboard                 # check; exits 1 and lists what is missing
npm run prerecord -w @zkdb/dashboard -- --restage    # also fixes what it can
ZKDB_DEMO=1 npm run fuji -w @zkdb/dashboard          # then open http://localhost:5173
```

`prerecord` checks, on Fuji:

- the owner, treasurer, auditor and relayer test keys each hold at least 0.002 AVAX;
- the page's replay matches the contract root;
- no proposal is waiting for the auditor and the queue is empty (a take starts from a clean desk);
- the latest root was sent over ICM;
- at least two seeded demo cards can still claim "Priority event ticket" (one for the take, one spare), one demo card has too few points for the refused claim, and one card with 300 or more points is free for the live correction (a card that has already claimed, or a third claimable one). It prints which cards to use.

`--restage` declines stray proposals, proves a non-empty queue and, if fewer than two cards can still claim or no card is left to correct, adds a fresh member with a new random secret (kept in `.demo-cards.fuji.local`, never committed) and 600 points. Each take uses up one card for the correction and one for the claim, so run it between takes.

`ZKDB_DEMO=1` is a dev toggle, off by default. With it, and the test keys and card secrets in the gitignored `packages/dashboard/.env.fuji.local` and `.demo-cards.fuji.local`, *Sign in* offers Owner, Treasurer and Auditor and the Perks page offers the seeded cards. Open the page as `http://localhost:5173` (or `127.0.0.1:5173`); the server refuses demo requests under any other name.

Local chain instead: `npm run demo -w @zkdb/dashboard` (anvil on 8559). Same story, same clicks, no ICM. Restarting it is the reset.

## Recording settings

- Viewport 1280 × 720 at device scale factor 1.5, which gives 1920 × 1080 frames with everything 1.5 times larger.
- Captions are burned in by the recorder as a bottom bar: one line, at least 40 px tall at 1080p, white on dark, from the Caption column below.
- The headline verdicts are 26 px in the page, 39 px in the frame: "Data verified", "Proof accepted", "Claim accepted", "No proof exists". Row statuses ("Corrected", "Rejected", "Needs auditor") are 14 px in the page, 21 px in the frame.
- No wallet popups (demo accounts sign), no file pickers, no terminal. Explorer shots at most 4 s.
- Length 2:10 to 2:40.

## The video: three acts, two sign-ins

Story: CLB Tình nguyện runs *Mùa hè xanh 2026*. Card #0042 had 1,250 points. Now it says 250.

Cards on Fuji on 19 Nov after two rehearsals (run `prerecord` for the current state; it names the cards for the take):

| Card | Points | Use |
|---|---:|---|
| #0042 | 250 | opening: corrected from 1,250, both signers shown |
| #0731 | 700 | act 1: the live correction, 700 → 70 (it has already claimed, so the correction costs no claim) |
| #0333 | 150 | act 2: the redemption of 500 that the proof rejects |
| #0107, #0215, #0604 | 500 to 550 | act 3: the successful claim (`prerecord` names the richest) |
| #0518 | 55 | act 3: the refused claim |
| #0889 | 55 | corrected and claimed in the README GIF take |

In the table below, `CORRECT`, `CLAIM` and `REFUSE` are the cards `prerecord` printed.

| # | Time | Screen and action | Clicks | Caption (≤ 8 words) |
|---|---|---|---|---|
| 0 | 0:00 | Title card: zkDB, "Avalanche Fuji testnet" | 0 | Fuji testnet · seeded club · demo test accounts |
| 1 | 0:06 | Overview, network pill visible | 0 | 1,250 points became 250. Who changed it? |
| 2 | 0:12 | Overview: "Data verified", the re-check line | 0 | This browser re-checked every change itself |
| 3 | 0:20 | Members → `#0042`: the flagged row, two signers | 2 | Treasurer and auditor both signed it |
| | | **Act 1: taking points away needs two signers** | | |
| 4 | 0:30 | Manage → Sign in → Treasurer. Correct → `CORRECT` → a tenth of its points → Propose correction | 2 + form | A treasurer alone cannot cut a balance |
| 5 | 0:45 | Redeem → `#0333` → `500` → Propose redemption. Both sit under "Waiting for the auditor" | form | Nothing changes until the auditor signs |
| 6 | 0:55 | Sign in → Auditor. Co-sign, Co-sign | 2 + 2 | The auditor co-signs on Avalanche |
| | | **Act 2: the proof rejects an overspend** | | |
| 7 | 1:08 | Prove 2 changes → "Proof accepted · proved in … · confirmed in …" | 1 | One SNARK checks the whole batch |
| 8 | 1:20 | Members → `#0333`: −500 struck out, Rejected, both signers | 2 | Two people signed. The proof said no. |
| 9 | 1:30 | Members → `CORRECT`: 700 → 70, Corrected, both signers | 2 | The correction stays flagged for good |
| | | **Act 3: an anonymous claim** | | |
| 10 | 1:40 | Sign out. Perks → chip `CLAIM` → Prove and claim | 3 | Prove 500 points without showing your card |
| 11 | 1:52 | Verdict card: "Claim accepted · Card: hidden · 1 of N qualifying cards". Hold 3 s | 0 | Claim accepted. Card: hidden. |
| 12 | 2:02 | Chip `REFUSE` → Prove and claim → "No proof exists · 55 of the 500 points needed". Hold 2 s | 2 | Too few points: no proof exists |
| 13 | 2:10 | Proofs → latest proof: gas, fee, seconds, the ICM row "Received by Teleporter on Dispatch, not executed (receiver not deployed)" | 2 | Dispatch received the root; nothing stores it yet |
| 14 | 2:20 | Snowtrace tab of that transaction, 4 s | 1 | Verified contracts on Avalanche Fuji |
| 15 | 2:26 | End card: zkDB, the ZkDB address, the repo | 0 | zkDB · proven points, private claims |

About 2:32. A Fuji transaction confirms in 2 to 3 s and a batch proof takes about 1 s, so beats 4 to 7 run in real time. The claim proves in the browser in 2 to 4 s, then the relayer's transaction confirms.

Sign-in dialogs: two (Treasurer in beat 4, Auditor in beat 6). The auditor also presses Prove. Beat 10 signs out with one click; claiming needs no account.

## Flows, for a longer walk-through

### 1. The ledger anyone can check
`#overview`
1. "Data verified" and "This browser re-ran N changes from the chain" → Check again
2. Latest proof: slots with a legend (confirmed, rejected, unused)
3. Top members, Activity: `1,250 → 250` reads *Corrected*, a rejected redemption is struck out
4. click `#0042` → history: every row has "Signed by"; the correction has Treasurer + Auditor

### 2. Taking points away needs two signatures
`#admin` as Treasurer, then as Auditor
1. Award → queued at once, one signature
2. Correct or Redeem → "Proposed … Nothing changes until the auditor co-signs"
3. The member page shows the proposal as *Needs auditor*; the balance is unchanged
4. Auditor signs in → Waiting for the auditor → Co-sign (or Decline: the row stays, greyed, *Declined*)
5. Prove → the correction turns *Corrected*, the redemption *Confirmed* or *Rejected*, each with both signers

### 3. Proof cost, timing and ICM
`#batches` → a proof
1. Slots: confirmed and rejected
2. Tiles: fee paid (and the same gas at the mainnet base fee), gas, proved in, confirmed in
3. "Root sent to Dispatch L1 (ICM): Received by Teleporter on Dispatch, not executed (receiver not deployed)" → sent ↗ (Snowtrace), received ↗ (Dispatch explorer). `npm run deploy:mirror -w @zkdb/dashboard -- --simulate` shows, with no gas, that Teleporter's `retryMessageExecution` would run the stored message once `RootMirror` is deployed; without `--simulate` it deploys it (needs DIS on Dispatch).

### 4. A perk claim that hides the card
`#perks`, signed out
1. Perks table: threshold, how many cards qualify, how many claimed
2. A card secret (demo chip, or "Card saved on this device") → Prove and claim → verdict card with a pickup code
3. At the desk: paste the pickup code → "Valid claim" → Mark as handed out (treasurer signed in)
4. Too few points → "No proof exists". The same card twice → "Already claimed"
5. Get a card: "Make my card secret" → an enrol code for the treasurer; the secret stays in the browser

### 5. Owner and advanced
- `#admin` as Owner: add a writer, give a table, make an auditor; Roles lists them
- Manage → New member: card number + the member's enrol code
- Members → Raw rows; Manage → Raw operations; search box: `card 42`, `proof 2`, `change 16`, a tx hash
