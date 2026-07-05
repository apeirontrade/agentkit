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

Smoke scripts: `pnpm x402:smoke` (ticket 5 — needs a funded Base key), `pnpm indexer:smoke` (read-only).

Next per the backlog: product apps begin — `apps/jobsmith` (order pipeline + storefront) or `apps/provenance` (scoring engine over the chain-indexer). Ticket 5's live payment run is the gating milestone before Jobsmith automation and needs a funded wallet.

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
