# agentkit

Monorepo for three agentic-payments products on a shared x402 foundation.
Full plan: `~/agentic-payments-roadmaps/0-MASTER-BUILD-SPEC.md`.

## Status

Foundation tickets 1–3 complete (2026-07-04):
- ✅ Monorepo skeleton — pnpm workspaces, turbo, tsconfig.base, CI, docker-compose.
- ✅ `@agentkit/shared` — USDC money math (BigInt, 13 passing tests), zod env loader, pino logger, pg-boss queue wrapper.
- ✅ `@agentkit/db` — Drizzle schema + raw-SQL core migration (partitioned `payments`, `wallets`, `facilitators`, `endpoints`, `funding_edges`), applied and verified against Postgres 16.

Next: ticket 4 (`@agentkit/facilitators`), ticket 5 (`@agentkit/x402-core` payer — the portfolio-de-risking milestone: one Apify Actor call paid via x402 on Base).

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
