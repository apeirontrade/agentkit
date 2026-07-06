# Provenance x402 API

A paid x402 endpoint that sells organic-revenue-quality / wash-risk scores for
Algorand x402 endpoints. **Holds no private keys** — facilitators settle
payments to public payTo addresses; the server never signs. Safe to deploy
anywhere.

Two settlement rails, routed by the network the payer chooses:

| rail | network | facilitator | status |
|------|---------|-------------|--------|
| Algorand mainnet | `algorand:wGHE2…` | GoPlausible (`facilitator.goplausible.xyz`) | always on |
| Base mainnet | `eip155:8453` | GoPlausible by default (keyless); Coinbase CDP if CDP keys set | on when `BASE_PAYTO` is set |

**Base needs no Coinbase account.** GoPlausible's facilitator settles `eip155:8453`
(verified via its `/supported`), so `BASE_PAYTO` alone lights up the Base rail —
keyless, same host as the Algorand rail. Setting `CDP_API_KEY_ID` +
`CDP_API_KEY_SECRET` instead routes Base through Coinbase's CDP facilitator, whose
only added benefit is auto-listing in the Coinbase x402 Bazaar.

## Endpoints
- `GET /` — service info
- `GET /health` — health check
- `GET /check/<ADDR>` — free quick check (30/hour/IP)
- `GET /score/<ADDR>` — $0.05 · quick wash verdict (x402-gated)
- `GET /report/<ADDR>` — $0.50 · full scored report (x402-gated)
- `GET /diligence/<ADDR>` — $5.00 · deep diligence (x402-gated)

Every 402 carries a spec-compliant `bazaar` discovery extension (strict
2020-12 JSON Schema, built with `@x402/extensions/bazaar`). Discovery reach:
- **GoPlausible** auto-lists us on the Global x402 Challenge leaderboard after
  the first public Algorand payment.
- **x402scan** indexes Base endpoints from on-chain activity — no signup — so
  the GoPlausible-settled Base rail surfaces there automatically.
- **402 Index** takes a direct registration for the Base endpoint.
- **Coinbase's x402 Bazaar** (only if CDP keys are set) auto-catalogs us on the
  first CDP settlement — the facilitator strict-validates the extension at settle
  (`EXTENSION-RESPONSES: processing` → indexed). Run the dry-run below to prove
  the extension passes before going live.

## Config (env)
| var | default | notes |
|-----|---------|-------|
| `PORT` | `8402` | |
| `PROVENANCE_PAYTO` | our wallet | Algorand revenue address (receive-only) |
| `FACILITATOR_URL` | `https://facilitator.goplausible.xyz` | Algorand rail |
| `NETWORK` | Algorand mainnet CAIP-2 | |
| `TIER_MULT` | `1` | global price multiplier, no redeploy repricing |
| `BASE_PAYTO` | — | Base (0x…) revenue address, receive-only. Setting this alone lights up the Base rail via GoPlausible. **Use a fresh address** — do NOT reuse the Jobsmith hot wallet (`JOBSMITH_WALLET_PK`); payTo needs no key on the server, so give it an address whose key never touches a server |
| `CDP_API_KEY_ID` | — | *Optional.* CDP Secret API key id — set (with the secret) to route Base through Coinbase CDP instead of GoPlausible, adding Bazaar auto-listing |
| `CDP_API_KEY_SECRET` | — | *Optional.* CDP Secret API key secret (Ed25519/EC PEM) |
| `SOLANA_PAYTO` | — | advertises the rail; **no SVM settlement path yet** |

The Base rail activates when `BASE_PAYTO` is set *and* the chosen facilitator's
handshake succeeds at boot — `Base rail LIVE via GoPlausible (keyless)` by
default, or `Base rail LIVE via CDP facilitator` if CDP keys are present. On any
failure it fails dark: Base is simply not advertised, Algorand is unaffected.
CDP keys, when used, only sign facilitator-API JWTs — they cannot move funds.

## Go-live checklist for Base / the Coinbase Bazaar (manual, one-time)
1. Create a CDP account at <https://portal.cdp.coinbase.com>, then
   **API Keys → Secret API Key → Create** (Ed25519 recommended). Copy the key
   **id** and **secret** — the secret is shown once.
2. Pick a **fresh Base receive address** (new empty account in any wallet —
   the server never needs its private key). Do not reuse the Jobsmith wallet.
3. Set `BASE_PAYTO`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` in the Railway
   dashboard (or your host's env) and redeploy.
4. Confirm the boot log says `Base rail LIVE via CDP facilitator`, and
   `pnpm --filter provenance-api dry-run https://<host>/score/<ADDR>` shows
   `✓ Base rail advertised` + a valid on-the-wire extension.
5. Make (or wait for) the first real Base USDC payment. That settlement
   auto-catalogs the endpoint in the x402 Bazaar.

## Run locally
```bash
pnpm --filter provenance-api start
# validate the Bazaar extension + probe a live 402 (no payment, no deploy):
pnpm --filter provenance-api dry-run
pnpm --filter provenance-api dry-run "http://localhost:8402/score/<ADDR>"
# pay it on Algorand:
pnpm tsx scripts/x402-pay-algo.ts "http://localhost:8402/score/<ADDR>" --send
```

## Deploy (Railway)
The Dockerfile builds from the **monorepo root** so workspace deps resolve.
```bash
railway init          # in repo root
railway up            # uses apps/provenance-api/railway.json
# set PROVENANCE_PAYTO / BASE_PAYTO / CDP_API_KEY_* in the Railway dashboard
```
Any Docker host works: `docker build -f apps/provenance-api/Dockerfile -t provenance-api .`

## SDK note (why two resource servers)
The Algorand rail runs on GoPlausible's `@x402-avm/*` fork (v2.6.x); the Base
rail runs on upstream `@x402/core` + `@x402/evm` (v2.17) with `@coinbase/x402`
supplying the CDP facilitator URL + JWT auth. Both speak the same x402 V2 wire
format (`PAYMENT-SIGNATURE` / `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE` headers,
base64-JSON payloads), but their TypeScript types diverged, so `server.ts`
decodes the payment header once and routes by CAIP-2 network to the right
server instance instead of forcing one core to do both.
