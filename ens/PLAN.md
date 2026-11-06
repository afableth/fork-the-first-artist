# 🏷 ens — implementation plan
*artist names: issue `artist.<parent>.eth` (or offchain names on testnet) · records: Hedera payout account, agent URL, profile URL*

## 0. First decision — parent name + issuing method
Demo constraints: **testnet**, and records (Hedera account, agent URL, profile URL) must be resolvable. Options:

| Option | How | Verdict |
|---|---|---|
| **A. Onchain subnames on Sepolia** (recommended) | ENS contracts are deployed on Sepolia. Register a parent name (e.g. `forkthefirst`), then issue subnames via Registry `setSubnodeRecord` | Real ENS records judges can verify. Low cost, one script |
| B. Offchain names (CCIP-Read / ENSIP-10 gateway) | Resolve subnames via our own server | Strong for real-time issuing but gateway implementation is heavy — too risky for hackathon time |
| C. Subname-issuing SaaS (e.g. NameStone) | A few API calls | Fastest, but weaker "we built it" story |

**Decision: A** (fall back to C if stuck). Registering a fresh `.eth` name on mainnet is not needed — testnet only.

## 1. Data design — ENS text/addr records written at issue time
- `url` → profile page URL
- `avatar` → profile image
- `com.hedera.account` (custom key) → Hedera payout account ID
- `agent.url` → steward agent URL (x402 endpoint)
- `vnd.fork-first.claim` → HCS claim transaction ID (link to the audit proof)

## 2. Layout
```
ens/
├── README.md            # update with what this module does
├── package.json         # ethers (hardhat only if needed)
├── .env.example         # RPC_URL, PARENT_OWNER_KEY (testnet only)
├── scripts/
│   ├── deploy-parent.ts # register the parent name (one-off)
│   └── issue.ts         # issue a subname + set records (core)
└── src/
    ├── registry.ts      # setSubnodeRecord wrapper
    └── claim-api.ts     # POST /api/claim (called by frontend)
```

## 3. Issuing flow (integrates with PLAN.md Verification)
1. Frontend calls `POST /api/claim` with `{ artistName, wallet, hederaPayoutAccount, signature, inviteToken }`.
2. **Signature check** — EIP-191 signature of "I am [name], claiming [name].<parent>" must recover to the payout wallet. No keys shared.
3. **Invite check** — validate the steward's one-time invite token (simple version: match against the HCS topic; shared with `agent/`).
4. **Issue** — parent-owner wallet runs `setSubnodeRecord`, then sets on the resolver: `addr(wallet)` + the text records above.
5. **Log** — send claim details (inviter, artist, wallet, time, tx hash) to the HCS topic (same audit topic as `agent/`).
6. Response: `{ name, txHash, hcsTxId }` → frontend shows "your name is this".

## 4. Milestones (deadline Sat 09:00 IST)
- [ ] **Fri morning**: Sepolia RPC + parent name set up; `issue.ts` mints one subname → verify resolution (ensjs read script / Sepolia view on app.ens.domains)
- [ ] **Fri afternoon**: `/api/claim` with signature verification wired to the frontend "Claim your name" button; HCS log integration
- [ ] **Fri night**: issue Shaka's real name (rehearsal) + second name for the live fork rehearsal; record tx hashes in `docs/TX-PROOF.md`
- [ ] **Sat morning**: README polish + demo video screen (how to show name resolution)

## 5. Risks & fallbacks
- **Parent registration on Sepolia is fiddly** → switch to C (SaaS issuing); demo looks the same.
- **Resolution not visible in MetaMask** → demo resolution via an ensjs read script or the Sepolia view on app.ens.domains.
- Parent owner key never goes in the repo — `.env` only (repo rule: no secrets committed).
