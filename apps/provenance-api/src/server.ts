/**
 * Provenance x402 API — a deployable, secret-free service that sells organic-
 * revenue-quality / wash-risk scores for Algorand x402 endpoints, in TIERS.
 *
 * Holds NO private keys: the resource server never signs — the GoPlausible
 * facilitator settles payments to our public payTo address. Safe to deploy
 * anywhere. The 402 carries a `bazaar` discovery extension so GoPlausible
 * auto-lists this endpoint on the Global x402 Challenge leaderboard once it's
 * public and receives its first payment.
 *
 * Pricing tiers (repricing was the #1 financial lever — see the financial plan):
 *   GET /score/<addr>      $0.05  quick wash verdict (level + score + top flags)
 *   GET /report/<addr>     $0.50  full report (all 8 signals, ORQ grade, drift)
 *   GET /diligence/<addr>  $5.00  deep (full report + every indicator, wide window)
 *
 * Config (env): PORT, PROVENANCE_PAYTO, FACILITATOR_URL, NETWORK, TIER_MULT.
 */
import http from "node:http";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402-avm/core/server";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/server";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402-avm/core/http";
import { assessWashRisk, scoreEndpoint } from "@agentkit/scoring";
import { assembleInput } from "@agentkit/provenance";

const PORT = Number(process.env.PORT ?? 8402);
const PAY_TO = process.env.PROVENANCE_PAYTO ?? "K5HIZPOUUUBQ5WJ6I3DT6NGIQUMALYJYSVVBY7CXA3BYBWY6225DNNBDSA";
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://facilitator.goplausible.xyz";
const NETWORK = process.env.NETWORK ?? "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const SPONSOR = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
// A global price multiplier so pricing can be dialed without a redeploy.
const TIER_MULT = Number(process.env.TIER_MULT ?? 1);
const ADDR_RE = /^[A-Z2-7]{58}$/;

type Depth = "quick" | "full" | "deep";
const TIERS: Record<string, { priceUsdc: number; depth: Depth; label: string }> = {
  score: { priceUsdc: 0.05, depth: "quick", label: "quick wash verdict" },
  report: { priceUsdc: 0.5, depth: "full", label: "full scored report" },
  diligence: { priceUsdc: 5.0, depth: "deep", label: "deep diligence" },
};

const atomic = (usdc: number) => String(Math.round(usdc * TIER_MULT * 1e6));

/**
 * Multi-chain collection (verified: the GoPlausible facilitator settles Base,
 * Solana AND Algorand — one facilitator, three rails, no bridge). Algorand is
 * always advertised; Base/Solana activate only when a payTo address for that
 * chain is configured via env. Funds land natively per chain — read-don't-bridge.
 */
const BASE_PAYTO = process.env.BASE_PAYTO ?? "";
const SOLANA_PAYTO = process.env.SOLANA_PAYTO ?? "";
const CHAIN_RAILS = [
  {
    network: NETWORK,
    asset: "31566704", // USDC ASA
    payTo: PAY_TO,
    extra: { name: "USDC", decimals: 6, feePayer: SPONSOR },
  },
  ...(BASE_PAYTO
    ? [{
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
        payTo: BASE_PAYTO,
        extra: { name: "USDC", version: "2" },
      }]
    : []),
  ...(SOLANA_PAYTO
    ? [{
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC SPL
        payTo: SOLANA_PAYTO,
        extra: { feePayer: "8a8fFNfk2AGS7rgVv1BoqPUWnzQuoCrShJV8tSE6RAYi" },
      }]
    : []),
];

function acceptsFor(resourceUrl: string, priceUsdc: number, description: string) {
  return CHAIN_RAILS.map((rail) => ({
    scheme: "exact",
    network: rail.network,
    amount: atomic(priceUsdc),
    asset: rail.asset,
    payTo: rail.payTo,
    maxTimeoutSeconds: 300,
    resource: resourceUrl,
    description,
    mimeType: "application/json",
    extra: rail.extra,
  }));
}


const bazaarExtension = (depth: Depth) => ({
  bazaar: {
    info: {
      input: { type: "http", method: "GET", pathParams: { address: "Algorand endpoint payTo address" } },
      output: {
        type: "json",
        example: {
          endpoint: "MERCHANT_ADDRESS",
          tier: depth,
          washRisk: { level: "critical", score: 98 },
          onChain: { payments: 207, payers: 2, clusters: 1 },
        },
      },
    },
  },
});

/** Naive in-memory free-tier limiter: 30 checks/hour/IP. */
const freeBuckets = new Map<string, { count: number; resetAt: number }>();
function allowFree(ip: string): boolean {
  const now = Date.now();
  const b = freeBuckets.get(ip);
  if (!b || now > b.resetAt) {
    freeBuckets.set(ip, { count: 1, resetAt: now + 3600_000 });
    return true;
  }
  if (b.count >= 30) return false;
  b.count++;
  return true;
}

function baseUrl(req: http.IncomingMessage): string {
  const host = req.headers.host ?? `localhost:${PORT}`;
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "http";
  return `${proto}://${host}`;
}

async function buildResult(target: string, depth: Depth) {
  const wide = depth === "deep";
  const { input, stats } = await assembleInput(target, {
    windowDays: wide ? 1095 : 730,
    maxEnrichedPayers: wide ? 150 : 60,
    now: new Date(),
  });
  const wash = assessWashRisk(input);
  const base = {
    endpoint: target,
    tier: depth,
    washRisk: { level: wash.level, score: wash.score },
    onChain: { payments: stats.nPayments, payers: stats.nPayers, clusters: wash.nPayerClusters },
    methodology: "provenance v0.1 · organic-revenue-quality",
  };
  if (depth === "quick") {
    return { ...base, washRisk: { ...base.washRisk, topIndicators: wash.indicators.slice(0, 3).map((i) => i.detail) } };
  }
  // full / deep: add the graded ORQ + every wash indicator
  const scored = scoreEndpoint(input, { bootstrapRounds: depth === "deep" ? 300 : 150, seed: 1 });
  return {
    ...base,
    grade: scored.grade,
    orq: scored.orq,
    ci: scored.orq !== null ? [scored.ciLow, scored.ciHigh] : null,
    signals: scored.subscores,
    washIndicators: depth === "deep" ? wash.indicators : wash.indicators.slice(0, 6),
    flags: scored.flags,
  };
}

async function main() {
  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const server = new x402ResourceServer(facilitator);
  registerExactAvmScheme(server, { networks: [NETWORK as `${string}:${string}`] });
  if (BASE_PAYTO || SOLANA_PAYTO) {
    // Rails advertise in accepts[] once a payTo is set; settlement additionally
    // needs the EVM/SVM server scheme registered here (verify SDK compatibility
    // at that point — the @x402/evm v2.17 client was incompatible with this core).
    console.warn(
      "⚠ BASE_PAYTO/SOLANA_PAYTO set: advertising those rails, but EVM/SVM server " +
        "schemes are not yet registered — settlement on those chains will fail until added.",
    );
  }
  await server.initialize();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", baseUrl(req));

    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }

    // FREE rate-limited quick check — the Layer-0 funnel the public MCP server
    // calls. 30 req/hour/IP; paid tiers carry the depth.
    const freeM = url.pathname.match(/^\/check\/(.+)$/);
    if (freeM) {
      const target = freeM[1]!;
      if (!ADDR_RE.test(target)) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid Algorand address" }));
        return;
      }
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "?";
      if (!allowFree(ip)) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "3600" }).end(
          JSON.stringify({ error: "free-tier limit (30/hour). Paid tiers: /score $0.05 · /report $0.50 · /diligence $5.00 via x402." }),
        );
        return;
      }
      try {
        const { input, stats } = await assembleInput(target, { windowDays: 730, maxEnrichedPayers: 30, now: new Date() });
        const wash = assessWashRisk(input);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          endpoint: target,
          washRisk: { level: wash.level, score: wash.score, topIndicators: wash.indicators.slice(0, 3).map((i) => i.detail) },
          onChain: { payments: stats.nPayments, payers: stats.nPayers, clusters: wash.nPayerClusters },
          tier: "free-quick-check",
          paidTiers: { score: "$0.05", report: "$0.50", diligence: "$5.00 — pay via x402 (GoPlausible)" },
          methodology: "provenance v0.1",
        }, null, 2));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        service: "Provenance x402 API",
        description: "Pay to get an organic-revenue-quality / wash-risk score for any Algorand x402 endpoint.",
        tiers: Object.fromEntries(Object.entries(TIERS).map(([k, t]) => [
          `GET /${k}/<ADDRESS>`, `${(t.priceUsdc * TIER_MULT).toFixed(2)} USDC — ${t.label}`,
        ])),
        network: NETWORK,
        payTo: PAY_TO,
        methodology: "provenance v0.1 · 8-signal ORQ + wash-risk",
      }, null, 2));
      return;
    }

    const m = url.pathname.match(/^\/(score|report|diligence)\/(.+)$/);
    if (!m || !TIERS[m[1]!] || !ADDR_RE.test(m[2]!)) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({
        error: "GET /{score|report|diligence}/<58-char Algorand address>",
        tiers: Object.fromEntries(Object.entries(TIERS).map(([k, t]) => [k, `${(t.priceUsdc * TIER_MULT).toFixed(2)} USDC`])),
      }));
      return;
    }
    const tier = TIERS[m[1]!]!;
    const target = m[2]!;
    const resourceUrl = `${baseUrl(req)}${url.pathname}`;
    const description = `Provenance ${tier.label} for an Algorand x402 endpoint`;
    const accepts = acceptsFor(resourceUrl, tier.priceUsdc, description);

    const paymentHeader = req.headers["payment-signature"] as string | undefined;
    if (!paymentHeader) {
      const required = {
        x402Version: 2,
        error: "Payment required",
        resource: { url: resourceUrl, description, mimeType: "application/json" },
        accepts,
        extensions: bazaarExtension(tier.depth),
      };
      res.writeHead(402, { "content-type": "application/json", "payment-required": encodePaymentRequiredHeader(required as never) });
      res.end("{}");
      return;
    }

    try {
      const payload = decodePaymentSignatureHeader(paymentHeader);
      // Settle against the rail the payer actually chose (multi-chain accepts).
      const paidNetwork = (payload as { network?: string }).network;
      const requirements = accepts.find((a) => a.network === paidNetwork) ?? accepts[0]!;
      const settle = await server.settlePayment(payload as never, requirements as never);
      if (!settle.success) {
        res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ error: "settlement failed", detail: settle }));
        return;
      }
      const result = await buildResult(target, tier.depth);
      res.writeHead(200, { "content-type": "application/json", "x-payment-settled": settle.transaction ?? "" }).end(
        JSON.stringify({ ...result, settlement: settle.transaction }, null, 2),
      );
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
    }
  });

  httpServer.listen(PORT, () => {
    const t = Object.entries(TIERS).map(([k, v]) => `${k} $${(v.priceUsdc * TIER_MULT).toFixed(2)}`).join(" · ");
    console.log(`Provenance x402 API :${PORT} · tiers: ${t} · payTo ${PAY_TO.slice(0, 10)}…`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
