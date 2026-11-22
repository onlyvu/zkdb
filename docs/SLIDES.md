# zkDB: slide outline

The current deck is [zkdb-pitch.pdf](zkdb-pitch.pdf). This file is the earlier text outline, kept for its sources.

Ten slides, text ready to paste. Every number is from the README or `docs/`, which link the transaction or the command behind it. Screens named here are in `docs/media/`.

## 1. Title

**zkDB**
A points ledger for student clubs where nobody can take a point away alone, and a member can prove "I have 500 points" without showing their card.

Avalanche Fuji

## 2. The problem

About 2.6 million Vietnamese undergraduates are scored on *điểm rèn luyện* (Tuổi Trẻ, 9 Oct 2026). Volunteer points feed it, and it decides scholarships (Thông tư 40/2026/TT-BGDĐT, Điều 18.6).

The party that keeps the points is the only one who can check them. A member whose 1,250 points became 250 cannot see who changed it.

In 2026 three defendants were sentenced over fake community-service certificates for students of one university (STU): 373 certificates for 63 students (13.5 years), 204 resold to 32 students (10 years on appeal), 23 sold to 4 students at 400,000 VND per 15-day set (9 years on appeal) (Tiền Phong, 24 Jun 2026). zkDB would not stop an insider signing a false award. It would put every award on a public record under the signer's address.

## 3. The solution, in one sentence

Every change to a balance is public and names its signer, taking points away needs two signers, each batch is checked by a validity proof (a SNARK) on Avalanche, and a member can prove a fact about their balance without revealing which card is theirs.

## 4. How it works

Diagram: the "System" flowchart from `docs/ARCHITECTURE.md`, cut to five boxes.

1. Treasurer queues a change (one transaction, public, signed).
2. Taking points away is only a proposal until the auditor co-signs.
3. A prover makes one proof for up to 16 changes; `ZkDB` verifies it and stores the new root.
4. Any browser re-runs the changes and compares roots: "Data verified".
5. A member's browser proves "a card in this root has at least N points"; `PointsGate` checks it against the root.

## 5. Demo

Three screens, left to right:

- `member.png`: "1,250 → 250 · Corrected · Treasurer 0x8117… + Auditor 0xb7AA…"
- `manage.png`: a correction and a redemption waiting for the auditor
- `perks.png`: "Claim accepted · Card: hidden · 1 of N qualifying cards"

Caption: recorded on Fuji with demo test accounts; the club and cards are seeded.

## 6. Why on-chain, why Avalanche

Why on-chain: the club cannot be the referee of its own numbers. The log, the signers and the root sit where nobody at the club can edit them.

Why Avalanche, measured on Fuji:

- 2.5 s median from broadcast to receipt over 41 transactions (p90 3.0 s); a proof is accepted on the screen the treasurer is looking at.
- A proof costs 1.05 to 1.18 M gas: about 0.008 to 0.009 AVAX at the C-Chain mainnet base fee (7.5 nAVAX on 18 Nov 2026). An award costs 67,502 gas.
- ICM: each proven root is sent from the C-Chain to the Dispatch L1 through Teleporter. It is received by Teleporter on Dispatch and not executed, because the receiver (`RootMirror`) is written and tested but not deployed. Nothing on Dispatch stores the root yet.
- Avalanche Data API for sender, time and fee of every transaction.

Why a proof and not a plain contract: we measured it. zkDB costs 3.3 times the gas of a plain ledger (152,731 against 46,896 gas per change). The proof is there for the private claim, which a plain contract cannot do.

## 7. Where the money comes from

No token, no yield. Points have no cash value and cannot be bought, sold or moved.

Costs are gas and hosting. A semester for a 200-member club is about 2.2 AVAX of gas at the mainnet base fee, roughly 390,000 VND (calculated from measured gas).

Buyer: a university's student-affairs office or its Đoàn and Hội, paying in VND for the dashboard, the prover and the claim relayer. No school has seen it yet.

## 8. Vietnamese law

- Crypto is not a lawful means of payment (State Bank of Vietnam); the crypto-asset pilot (Nghị quyết 05/2025/NQ-CP) keeps trading and payment in VND. zkDB takes no payments and issues no token; points cannot be bought, sold or moved.
- Personal data (Luật 91/2025/QH15, Nghị định 356/2025): only card numbers, balances, reason codes and hashes go on-chain. Names and student IDs stay with the club.
- *Điểm rèn luyện* is decided by each school under Thông tư 40/2026. zkDB is a record a club can show; it does not replace the decision.

## 9. What is mock, and limits

- Testnet. The club, cards and reasons are seeded; the seeded card secrets are random and stay on the recording laptop. Recordings sign with demo test accounts (`ZKDB_DEMO=1`), and the treasurer, auditor and owner keys sit on one laptop.
- Balances are public. The claim hides which qualifying card claimed, nothing more.
- One signer can still award points and add a member. Both are public and name the signer.
- The receiving contract on Dispatch is not deployed. One prover server.
- Built when: the batch circuit, its verifier, the tree and a first contract (1,308 hand-written lines) were committed on 16 Oct 2026, before the event (the organiser FAQ at team1vn.xyz: "Can I bring a project I am already building?" Yes). From 2 Nov: 8,869 lines, the claim circuit, PointsGate, ICM relay, the app and every Fuji deployment (`./scripts/built-when.sh`).

## 10. Team and links


- ZkDB `0x1dd3f88db29ee55e66b8db243c99c5b7fc0ea91c`
- PointsGate `0xe68736b7dc375a90635dec5b07e09838f4fc4c33`
- RootRelay `0x497e8189dc2d2cc07712f448f51fbe708e2e306f`
- The main flow, run on Fuji on 20 Nov 2026: 13 transactions in docs/fuji-flow-run.md
- All five contracts are source-verified on Snowtrace (Routescan). 197 tests: 54 Foundry, 30 core, 84 dashboard, 29 Noir.
