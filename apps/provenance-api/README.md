# Provenance x402 API

A paid x402 endpoint that sells organic-revenue-quality / wash-risk scores for
Algorand x402 endpoints. **Holds no private keys** — the GoPlausible facilitator
settles payments to the public `PROVENANCE_PAYTO` address; the server never signs.
Safe to deploy anywhere.

## Endpoints
- `GET /` — service info
- `GET /health` — health check
- `GET /score/<ALGORAND_ADDRESS>` — x402-gated; pay `PRICE_USDC` USDC → get the score

The 402 response carries a `bazaar` discovery extension, so once this is public
and takes its first payment, **GoPlausible auto-lists it on the Global x402
Challenge leaderboard** — no manual registration.

## Config (env, all optional)
| var | default |
|-----|---------|
| `PORT` | `8402` |
| `PROVENANCE_PAYTO` | our wallet (revenue address) |
| `PRICE_USDC` | `0.01` |
| `FACILITATOR_URL` | `https://facilitator.goplausible.xyz` |
| `NETWORK` | Algorand mainnet CAIP-2 |

## Run locally
```bash
pnpm --filter provenance-api start
# then pay it:
pnpm tsx scripts/x402-pay-algo.ts "http://localhost:8402/score/<ADDR>" --send
```

## Deploy (Railway)
The Dockerfile builds from the **monorepo root** so workspace deps resolve.
```bash
railway init          # in repo root
railway up            # uses apps/provenance-api/railway.json
# set PROVENANCE_PAYTO in the Railway dashboard if not using the default
```
Any Docker host works: `docker build -f apps/provenance-api/Dockerfile -t provenance-api .`

## What makes this a Challenge entry
A paid x402 endpoint on Algorand mainnet, settled via GoPlausible, that does
something genuinely useful (rates other endpoints' revenue quality). The
remaining step to *win* is real external payers — see the top-level plan.
