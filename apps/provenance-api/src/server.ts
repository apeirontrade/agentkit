/**
 * Provenance x402 API — a deployable, secret-free service that sells organic-
 * revenue-quality / wash-risk scores for Algorand x402 endpoints, in TIERS.
 *
 * Holds NO private keys: the resource server never signs — facilitators settle
 * payments to our public payTo addresses. Safe to deploy anywhere. Two rails,
 * routed by the network the payer chose:
 *   algorand:*  → GoPlausible facilitator (@x402-avm fork)
 *   eip155:8453 → GoPlausible by default (keyless — its /supported advertises
 *                 Base); Coinbase CDP instead when CDP_API_KEY_ID/SECRET are set
 *                 (adds Bazaar auto-listing). Upstream @x402/core v2.17 either way.
 * The two SDKs share the v2 wire format (PAYMENT-SIGNATURE / PAYMENT-REQUIRED
 * headers, base64-JSON) but their TS types diverged — hence two server
 * instances bridged by a decode-then-route switch, not one core.
 *
 * The 402 carries a spec-compliant `bazaar` discovery extension (strict JSON
 * Schema, built by @x402/extensions/bazaar). GoPlausible auto-lists us on the
 * Global x402 Challenge leaderboard; Base activity is picked up by x402scan and
 * (once registered) 402 Index; and if CDP keys are set, Coinbase's Bazaar
 * auto-catalogs us on the first CDP settlement — no registration on any.
 *
 * Pricing tiers (repricing was the #1 financial lever — see the financial plan):
 *   GET /score/<addr>      $0.05  quick wash verdict (level + score + top flags)
 *   GET /report/<addr>     $0.50  full report (all 8 signals, ORQ grade, drift)
 *   GET /diligence/<addr>  $5.00  deep (full report + every indicator, wide window)
 *
 * Config (env): PORT, PROVENANCE_PAYTO, FACILITATOR_URL, NETWORK, TIER_MULT,
 *   BASE_PAYTO (→ Base rail via GoPlausible), optional CDP_API_KEY_ID +
 *   CDP_API_KEY_SECRET (→ Base rail via Coinbase CDP + Bazaar listing instead).
 */
import http from "node:http";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402-avm/core/server";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/server";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402-avm/core/http";
import { x402ResourceServer as EvmResourceServer, HTTPFacilitatorClient as EvmFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { assessWashRisk, scoreEndpoint } from "@agentkit/scoring";
import { assembleInput } from "@agentkit/provenance";
import { BAZAAR_EXTENSIONS, type Depth } from "./bazaar.js";

const PORT = Number(process.env.PORT ?? 8402);
const PAY_TO = process.env.PROVENANCE_PAYTO ?? "K5HIZPOUUUBQ5WJ6I3DT6NGIQUMALYJYSVVBY7CXA3BYBWY6225DNNBDSA";
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://facilitator.goplausible.xyz";
const NETWORK = process.env.NETWORK ?? "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const SPONSOR = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
// A global price multiplier so pricing can be dialed without a redeploy.
const TIER_MULT = Number(process.env.TIER_MULT ?? 1);
const ADDR_RE = /^[A-Z2-7]{58}$/;

const TIERS: Record<string, { priceUsdc: number; depth: Depth; label: string }> = {
  score: { priceUsdc: 0.05, depth: "quick", label: "quick wash verdict" },
  report: { priceUsdc: 0.5, depth: "full", label: "full scored report" },
  diligence: { priceUsdc: 5.0, depth: "deep", label: "deep diligence" },
};

const atomic = (usdc: number) => String(Math.round(usdc * TIER_MULT * 1e6));

/**
 * Multi-chain collection. Algorand is always advertised (GoPlausible settles).
 * Base activates when BASE_PAYTO is set — settled by GoPlausible (keyless) or,
 * if CDP keys are present, by Coinbase's CDP facilitator. Solana advertises
 * when a payTo is set but has no settlement path yet.
 * Funds land natively per chain — read-don't-bridge.
 */
const BASE_PAYTO = process.env.BASE_PAYTO ?? "";
const BASE_NETWORK = "eip155:8453"; // Base mainnet
// Base settles through GoPlausible by default (same keyless facilitator as
// Algorand — its /supported advertises eip155:8453). Setting CDP keys switches
// the Base rail to Coinbase's CDP facilitator instead, which additionally
// auto-lists us in the Coinbase x402 Bazaar. CDP is an OPT-IN upgrade, not a
// requirement: BASE_PAYTO alone is enough to accept Base USDC.
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID ?? "";
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET ?? "";
const USE_CDP = Boolean(CDP_API_KEY_ID && CDP_API_KEY_SECRET);
const BASE_ENABLED = Boolean(BASE_PAYTO);
const SOLANA_PAYTO = process.env.SOLANA_PAYTO ?? "";
// Set once main() has registered + initialized the EVM resource server; the
// Base rail is only advertised while this is non-null (fail dark, not broken).
let evmServer: InstanceType<typeof EvmResourceServer> | null = null;
const CHAIN_RAILS = [
  {
    network: NETWORK,
    asset: "31566704", // USDC ASA
    payTo: PAY_TO,
    extra: { name: "USDC", decimals: 6, feePayer: SPONSOR },
  },
  ...(BASE_ENABLED
    ? [{
        network: BASE_NETWORK,
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
        payTo: BASE_PAYTO,
        extra: { name: "USDC", version: "2" }, // EIP-712 domain for EIP-3009 transferWithAuthorization
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
  // A rail is only offered if it can actually settle: Base drops out if the
  // EVM server failed to initialize against the CDP facilitator.
  return CHAIN_RAILS.filter((rail) => rail.network !== BASE_NETWORK || evmServer !== null).map((rail) => ({
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

// Spec-compliant `bazaar` discovery extension — see src/bazaar.ts. It rides
// in the 402's `extensions`; the payer's client echoes it inside the payment
// payload; the CDP facilitator strict-validates it at settle and auto-catalogs
// the endpoint in the x402 Bazaar (EXTENSION-RESPONSES: processing → indexed).

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

// ---- Discovery surface builders ----
const SITE_URL = process.env.SITE_URL ?? "https://apeirontrade.github.io/provenance-site";

/** A2A-style agent card: what this service is, how agents pay it, where else we live. */
function agentCard(origin: string) {
  return {
    protocolVersion: "0.3.0",
    name: "Provenance",
    description:
      "Ratings agency for the agent economy: organic-revenue-quality / wash-trading forensics for x402 endpoints, computed from public on-chain data. Free quick checks; paid deep forensics over x402 (USDC).",
    url: origin,
    provider: { organization: "Provenance", url: SITE_URL },
    version: "0.1.0",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "check_endpoint_risk",
        name: "Free wash-risk quick check",
        description: `GET ${origin}/check/<algorand-address> — free verdict (level, 0-100 score, top indicators), 30/hr/IP.`,
        tags: ["trust", "x402", "wash-trading", "free"],
      },
      {
        id: "score",
        name: "Wash verdict ($0.05 via x402)",
        description: `GET ${origin}/score/<algorand-address> — pay-per-call over x402.`,
        tags: ["trust", "x402", "paid"],
      },
      {
        id: "report",
        name: "Full 8-signal ORQ report ($0.50 via x402)",
        description: `GET ${origin}/report/<algorand-address>`,
        tags: ["trust", "x402", "paid"],
      },
      {
        id: "diligence",
        name: "Deep diligence ($5.00 via x402)",
        description: `GET ${origin}/diligence/<algorand-address> — 3-year window, full payer-cluster forensics.`,
        tags: ["trust", "x402", "paid", "diligence"],
      },
    ],
    // Non-spec extras agents and indexers can use:
    x402: { rails: CHAIN_RAILS.map((r) => ({ network: r.network, payTo: r.payTo })), pricingUsd: { score: 0.05, report: 0.5, diligence: 5 } },
    related: {
      dataSite: SITE_URL,
      mcpServer: "https://www.npmjs.com/package/provenance-mcp",
      guardLibrary: "https://www.npmjs.com/package/provenance-guard",
      mcpRegistry: "io.github.apeirontrade/provenance-mcp",
    },
  };
}

const LLMS_TXT = `# Provenance
> Ratings agency for the agent economy: wash-trading / organic-revenue-quality forensics for x402 (machine-payable) endpoints, from public on-chain data. Signals, not accusations.

## API (this host)
- /check/<algorand-address>: free wash-risk verdict, 30/hr/IP
- /score /report /diligence: paid tiers ($0.05 / $0.50 / $5.00) over x402, USDC
- /.well-known/agent-card.json: machine-readable service card
- /badge/<address>.svg: embeddable grade badge

## Elsewhere
- Data site + weekly Bazaar Wash Report: ${"https://apeirontrade.github.io/provenance-site"}
- MCP server (agents): npm "provenance-mcp" · MCP registry io.github.apeirontrade/provenance-mcp
- Pre-payment guard (one line for x402 clients): npm "provenance-guard"
- Source/docs: https://github.com/apeirontrade/provenance-mcp
`;

/** Shields-style flat badge. Cached per address; capped LRU-ish map. */
const badgeCache = new Map<string, { svg: string; expires: number }>();
const BADGE_COLORS: Record<string, string> = { low: "#3fb950", medium: "#d29922", high: "#f0883e", critical: "#f85149" };
function renderBadge(label: string, value: string, color: string): string {
  const lw = 6 * label.length + 10, vw = 6 * value.length + 10, w = lw + vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}: ${value}"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${label}</text><text x="${lw + vw / 2}" y="14">${value}</text></g></svg>`;
}
async function badgeSvg(target: string, ip: string): Promise<string> {
  const hit = badgeCache.get(target);
  if (hit && hit.expires > Date.now()) return hit.svg;
  let svg: string;
  if (!allowFree(ip)) {
    return renderBadge("provenance", "unrated", "#8b949e"); // rate-limited: don't cache
  }
  try {
    const { input } = await assembleInput(target, { windowDays: 730, maxEnrichedPayers: 30, now: new Date() });
    const wash = assessWashRisk(input);
    svg = renderBadge("provenance", `${wash.level} ${wash.score}/100`, BADGE_COLORS[wash.level] ?? "#8b949e");
  } catch {
    svg = renderBadge("provenance", "unrated", "#8b949e");
  }
  if (badgeCache.size > 5000) badgeCache.clear();
  badgeCache.set(target, { svg, expires: Date.now() + 3600_000 });
  return svg;
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
  await server.initialize();

  // Base rail: a SECOND resource server on upstream @x402/core v2.17 (the @x402/evm
  // exact scheme can't register on the @x402-avm fork's core, so we route by
  // network across two cores that share the v2 wire format). Its facilitator is
  // GoPlausible by default — keyless, no auth, same host that settles Algorand —
  // or Coinbase CDP when CDP keys are present (adds Bazaar auto-listing).
  if (BASE_ENABLED) {
    try {
      const evmFacilitator = USE_CDP
        ? new EvmFacilitatorClient(createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET))
        : new EvmFacilitatorClient({ url: FACILITATOR_URL });
      const evm = new EvmResourceServer(evmFacilitator);
      registerExactEvmScheme(evm, { networks: [BASE_NETWORK] });
      await evm.initialize(); // hits the facilitator's /supported — proves the rail is reachable
      evmServer = evm;
      console.log(
        USE_CDP
          ? `Base rail LIVE via CDP facilitator · payTo ${BASE_PAYTO.slice(0, 10)}… · first settlement auto-lists us in the x402 Bazaar`
          : `Base rail LIVE via GoPlausible (keyless) · payTo ${BASE_PAYTO.slice(0, 10)}… · discoverable via x402scan + 402 Index`,
      );
    } catch (e) {
      console.error(`⚠ Base facilitator init failed (${(e as Error).message}) — Base rail disabled, Algorand unaffected.`);
    }
  }
  if (SOLANA_PAYTO) {
    console.warn("⚠ SOLANA_PAYTO set: advertising that rail, but no SVM settlement path is registered yet — Solana payments will fail.");
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", baseUrl(req));

    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }

    // ---- Discovery surfaces (pull marketing: crawlers + agents find us) ----
    // A2A-style agent card. Served at both the spec path and the legacy alias.
    if (url.pathname === "/.well-known/agent-card.json" || url.pathname === "/.well-known/agent.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=3600" }).end(
        JSON.stringify(agentCard(baseUrl(req)), null, 2),
      );
      return;
    }
    if (url.pathname === "/llms.txt") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" }).end(LLMS_TXT);
      return;
    }
    // Embeddable grade badge — README/site embeds backlink to us. Cached 1h per
    // address; uncached computes ride the free-tier bucket (gray badge when hit).
    const badgeM = url.pathname.match(/^\/badge\/([A-Z2-7]{58})\.svg$/);
    if (badgeM) {
      const target = badgeM[1]!;
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "?";
      const svg = await badgeSvg(target, ip);
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" }).end(svg);
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
        extensions: BAZAAR_EXTENSIONS[tier.depth],
      };
      // Header (v2) AND body (v1 clients + registry probes, e.g. 402index.io
      // reads bodySnippet) carry the same payload — spec-hygienic duplication.
      res.writeHead(402, { "content-type": "application/json", "payment-required": encodePaymentRequiredHeader(required as never) });
      res.end(JSON.stringify(required));
      return;
    }

    try {
      const payload = decodePaymentSignatureHeader(paymentHeader) as {
        accepted?: { network?: string };
        network?: string; // older clients put network at the top level
      };
      // Settle against the rail the payer actually chose (multi-chain accepts).
      // Requirements always come from OUR accepts — never trust the client's copy.
      const paidNetwork = payload.accepted?.network ?? payload.network;
      const requirements = accepts.find((a) => a.network === paidNetwork) ?? accepts[0]!;
      const settle =
        paidNetwork?.startsWith("eip155:") && evmServer
          ? // Base → CDP facilitator. Strip to the canonical v2.17 requirements
            // shape (no resource/description/mimeType — CDP validates strictly)
            // and pass the declared bazaar extension for echo-validation.
            await evmServer.settlePayment(
              payload as never,
              {
                scheme: requirements.scheme,
                network: requirements.network as `${string}:${string}`,
                asset: requirements.asset,
                amount: requirements.amount,
                payTo: requirements.payTo,
                maxTimeoutSeconds: requirements.maxTimeoutSeconds,
                extra: requirements.extra as Record<string, unknown>,
              },
              BAZAAR_EXTENSIONS[tier.depth] as never,
            )
          : // Algorand (and anything else) → GoPlausible, unchanged.
            await server.settlePayment(payload as never, requirements as never);
      if (!settle.success) {
        res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ error: "settlement failed", detail: settle }));
        return;
      }
      const result = await buildResult(target, tier.depth);
      res.writeHead(200, {
        "content-type": "application/json",
        "x-payment-settled": settle.transaction ?? "",
        "payment-response": encodePaymentResponseHeader(settle as never), // v2 receipt header
      }).end(JSON.stringify({ ...result, settlement: settle.transaction }, null, 2));
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
