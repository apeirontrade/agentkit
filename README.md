# agentkit

Monorepo for three agentic-payments products on a shared x402 foundation.
Full plan: `~/agentic-payments-roadmaps/0-MASTER-BUILD-SPEC.md`.

## Status

Shared foundation complete (2026-07-04) — 5 packages, 27 tests green, full workspace typecheck clean:
- ✅ Monorepo skeleton — pnpm workspaces, turbo, tsconfig.base, CI, docker-compose.
- ✅ `@agentkit/shared` — USDC money math (BigInt, 13 tests), zod env loader, pino logger, pg-boss queue wrapper.
- ✅ `@agentkit/db` — Drizzle schema + raw-SQL core migration (partitioned `payments`, `wallets`, `facilitators`, `endpoints`, `funding_edges`), applied and verified against Postgres 16.
- ✅ `@agentkit/facilitators` — typed x402-facilitator registry (address-indexed, empirically grown).
- ✅ `@agentkit/x402-core` — payer (real `@x402/fetch` v2, hard per-call ceiling), Apify prepaid-token buyer, settlement classifier, EIP-3009 decoding, 402 probe. Base USDC + AuthorizationUsed topic self-verified vs viem.
- ✅ `@agentkit/chain-indexer` — Base (viem getLogs) + Algorand (Nodely REST) USDC ingestion, reorg-safe. **Verified live against Algorand mainnet.**
- ✅ `@agentkit/scoring` — Provenance Desk's 8-signal Organic Revenue Quality engine (union-find clustering, self-dealing cycles, retention, temporal, wallet fingerprint, Benford, concentration, cross-endpoint rings) → weighted geometric mean → ORQ + grade + bootstrap CI. **Proven on fixtures: organic → A (86.7), wash → F (17.3).** Algorand-first.

6 packages, 37 tests green. Smoke/demo scripts: `pnpm x402:smoke` (needs a funded Base key), `pnpm indexer:smoke` (read-only), `pnpm scoring:demo` (pure).

Next per the backlog: wire scoring to live data (`assembleInput` querying the chain-indexer + per-wallet funding/age lookups on Algorand), then the Provenance leaderboard + attestations, or start `apps/jobsmith`. Ticket 5's live payment run gates Jobsmith automation and needs a funded wallet.

### Known v0.1 refinements
- Robotic-retention detection has a week-boundary edge (didn't fire on the metronomic fixture); the geometric mean still grades it F via other signals. Refine cohort bucketing.
- `assembleInput` (DB/indexer → ScoringInput, incl. Algorand funding-edge + wallet-age derivation) is not yet built — the engine is proven on fixtures, not yet on live mainnet endpoints.

## Quickstart

```bash
corepack enable && corepack prepare pnpm@9.15.0 --activate
pnpm install
cp .env.example .env            # fill in secrets

pnpm db:up                      # docker: postgres + redis
DATABASE_URL=postgres://agentkit:agentkit@localhost:5432/agentkit pnpm db:migrate

pnpm typecheck                  # turbo, all packages
pnpm test                       # vitest
```

## Layout

```
packages/
  shared/     env, logging, USDC money math, queue        (@agentkit/shared)
  db/         Drizzle schema + migrations                 (@agentkit/db)
  # coming: chain-indexer, x402-core, facilitators, attest
apps/
  # coming: jobsmith, provenance, subledger
```

See the master build spec for the full file tree, the 48-ticket backlog, the
dated 16-week calendar, and the six decision gates.
