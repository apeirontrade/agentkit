/**
 * Wrapper Watch v1 — detects unauthorized API resellers ("wrappers") among
 * public x402 endpoints: services reselling first-party data (Wolfram,
 * Amadeus, Google, OpenAI, weather/flight/search/finance APIs) behind an
 * x402 paywall without obvious authorization. See Bankless's "x402 Wrapper
 * Problem" for the documented issue.
 *
 *   npx tsx scripts/wrapper-watch.ts
 *
 * Outputs:
 *   scratch/wrapper-watch.json       — every scanned endpoint with score + evidence
 *   scratch/wrapper-watch-report.md  — outbound-ready per-brand report
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { collectListings, USER_AGENT, Listing } from "./lib/wrapper-watch-collect";
import { scoreListing, ScoredListing } from "./lib/wrapper-watch-score";
import { BRANDS } from "./lib/wrapper-watch-brands";

const PROBE_COUNT = 20;
const PROBE_DELAY_MS = 2000;
const PROBE_TIMEOUT_MS = 10_000;

interface ProbeResult {
  status: number | null;
  is402: boolean;
  server402Description?: string;
  paymentAmount?: string;
  paymentNetwork?: string;
  error?: string;
}

/** Harmless unauthenticated GET to capture live 402 metadata. No payment is ever made. */
async function probe(url: string): Promise<ProbeResult> {
  const target = url.replace(/:([a-zA-Z_]+)/g, "test"); // fill path params harmlessly
  try {
    const res = await fetch(target, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: "follow",
    });
    const out: ProbeResult = { status: res.status, is402: res.status === 402 };
    if (res.status === 402) {
      try {
        const body = (await res.json()) as any;
        const accept = (body.accepts ?? [])[0];
        out.server402Description = String(body.error ?? accept?.description ?? "").slice(0, 200) || undefined;
        if (accept) {
          out.paymentAmount = accept.amount ?? accept.maxAmountRequired;
          out.paymentNetwork = accept.network;
        }
      } catch { /* non-JSON 402 body */ }
    }
    return out;
  } catch (e) {
    return { status: null, is402: false, error: (e as Error).message.slice(0, 120) };
  }
}

function fmtUsd(l: Listing): string {
  return l.priceUsd !== null ? `$${l.priceUsd.toFixed(4)}` : `${l.amountAtomic} (asset ${l.asset.slice(0, 10)}…)`;
}

function buildReport(
  scored: ScoredListing[],
  suspects: ScoredListing[],
  probes: Map<string, ProbeResult>,
  stats: { bazaarTotal: number; bazaarFetched: number; goplausibleFetched: number },
): string {
  const now = new Date().toISOString().slice(0, 10);
  const byBrand = new Map<string, ScoredListing[]>();
  for (const s of suspects) {
    for (const b of s.brands.filter((x) => !x.comparative)) {
      const list = byBrand.get(b.brandId) ?? [];
      list.push(s);
      byBrand.set(b.brandId, list);
    }
  }
  const brandSections = [...byBrand.entries()]
    .map(([id, list]) => ({ brand: BRANDS.find((b) => b.id === id)!, list }))
    .filter((x) => x.brand)
    .sort((a, b) => b.list.length - a.list.length);

  const high = suspects.filter((s) => s.confidence === "high").length;
  const med = suspects.filter((s) => s.confidence === "medium").length;
  const active = suspects.filter((s) => (s.calls30d ?? 0) > 0).length;

  const lines: string[] = [];
  lines.push(`# Wrapper Watch — x402 Unauthorized-Reseller Scan`);
  lines.push(``);
  lines.push(`*Prepared by Provenance · ${now} · methodology + raw evidence available on request*`);
  lines.push(``);
  lines.push(`## Executive summary`);
  lines.push(``);
  lines.push(
    `We scanned **${scored.length.toLocaleString()} unique x402-paywalled endpoints** across the two public ` +
    `x402 discovery registries (Coinbase Bazaar: ${stats.bazaarFetched.toLocaleString()} listings; ` +
    `GoPlausible/Algorand: ${stats.goplausibleFetched}) for reseller signatures against a curated list of ` +
    `${BRANDS.length} first-party API brands.`,
  );
  lines.push(``);
  lines.push(`- **${suspects.length} endpoints exhibit reseller signatures** referencing a first-party brand while hosted off that brand's domain (${high} high-confidence, ${med} medium).`);
  lines.push(`- **${active} of them show payment activity in the last 30 days** — agents are already paying these endpoints.`);
  lines.push(`- **${brandSections.length} brands are affected.** Per-brand detail below, ordered by exposure.`);
  lines.push(``);
  lines.push(
    `A note on language: everything below is stated as *suspected unauthorized resale — verification recommended*. ` +
    `A flagged endpoint may hold a legitimate redistribution license; the signatures identify candidates for review, not conclusions.`,
  );
  lines.push(``);

  for (const { brand, list } of brandSections) {
    const sorted = [...list].sort((a, b) => b.score - a.score);
    lines.push(`## ${brand.name} — ${list.length} suspected wrapper${list.length === 1 ? "" : "s"}`);
    lines.push(``);
    lines.push(`*Why this matters for ${brand.name}: ${brand.outboundNote}*`);
    lines.push(``);
    for (const s of sorted.slice(0, 8)) {
      const p = probes.get(s.url);
      lines.push(`### \`${s.url}\``);
      lines.push(``);
      lines.push(`- **Wrapper-likelihood score:** ${s.score}/100 (${s.confidence} confidence) · listed on ${s.source === "bazaar" ? "Coinbase Bazaar" : "GoPlausible (Algorand)"}`);
      if (s.description) lines.push(`- **Listed description:** "${s.description.slice(0, 220)}${s.description.length > 220 ? "…" : ""}"`);
      lines.push(`- **Price per call:** ${fmtUsd(s)} · pays to \`${s.payTo.slice(0, 20)}…\` on \`${s.network}\``);
      if (s.calls30d !== undefined) {
        lines.push(`- **Observed activity:** ${s.calls30d} paid calls${s.payers30d !== undefined ? ` from ${s.payers30d} unique payers` : ""} (30d) — ${s.calls30d! > 0 ? "revenue is flowing through this endpoint today" : "currently dormant"}`);
      }
      for (const e of s.evidence) lines.push(`- **Evidence (${e.layer}):** ${e.detail}`);
      if (p) {
        if (p.is402) {
          lines.push(`- **Live probe:** endpoint is up and returned HTTP 402 with payment requirements${p.paymentAmount ? ` (${p.paymentAmount} atomic units on ${p.paymentNetwork})` : ""}${p.server402Description ? ` — server says: "${p.server402Description}"` : ""}. No payment was made.`);
        } else if (p.status !== null) {
          lines.push(`- **Live probe:** responded HTTP ${p.status} to an unauthenticated GET (no payment made).`);
        } else {
          lines.push(`- **Live probe:** unreachable (${p.error}) — may be stale or geo/UA-gated.`);
        }
      }
      lines.push(``);
    }
    if (sorted.length > 8) {
      lines.push(`*…plus ${sorted.length - 8} more (full list in the machine-readable appendix).*`);
      lines.push(``);
    }
  }

  lines.push(`## Methodology & caveats`);
  lines.push(``);
  lines.push(`- Sources: Coinbase Bazaar x402 discovery API and the GoPlausible Algorand facilitator registry, fetched ${now}. Listings are self-declared by endpoint operators.`);
  lines.push(`- Scoring layers: (a) brand-term matching against ${BRANDS.length} first-party brands with off-domain check, (b) proxy signatures — "access to X API" phrasing, generic single-field passthrough schemas, cost-plus markup vs. known public per-call prices, (c) domain forensics — generic/ephemeral hosting (vercel.app, workers.dev, onrender.com, bare IPs) while claiming premium data.`);
  lines.push(`- Up to ${PROBE_COUNT} top-scoring endpoints were probed with a single harmless unauthenticated GET (UA \`${USER_AGENT}\`, ${PROBE_DELAY_MS / 1000}s spacing) to confirm liveness and capture 402 payment metadata. **No payments were made and no paid data was retrieved.**`);
  lines.push(`- False-positive modes: licensed redistributors, brands named comparatively ("alternative to X" is down-weighted but imperfect), coincidental term collisions, and stale listings. Each flagged endpoint should be verified against the brand's partner list before action.`);
  lines.push(``);
  lines.push(`## About Provenance`);
  lines.push(``);
  lines.push(
    `Provenance continuously monitors the x402 machine-payment economy — the fastest-growing channel for unauthorized API resale, because paywalled proxies there earn real revenue from autonomous agents with no human reviewing the source of the data. ` +
    `This report is a one-time free snapshot. Our monitoring subscription ($499/mo per brand) delivers: weekly scans of all public x402 registries, instant alerts when a new endpoint referencing your brand appears, payment-address attribution and on-chain revenue estimates for each reseller, takedown-ready evidence packages, and trend reporting your DevRel and legal teams can act on. ` +
    `Reply to this report and we'll set up your brand's watchlist within one business day.`,
  );
  lines.push(``);
  return lines.join("\n");
}

async function main() {
  console.log("Wrapper Watch v1 — collecting x402 endpoint listings…");
  const { listings, stats } = await collectListings({
    log: (m) => process.stdout.write(`\r  ${m}          `),
  });
  console.log(`\n  collected ${listings.length} unique endpoints (${stats.deduped} duplicates removed)`);

  console.log("Scoring…");
  const scored = listings.map(scoreListing).sort((a, b) => b.score - a.score);
  const suspects = scored.filter((s) => s.score >= 45 && s.brands.some((b) => !b.comparative));
  console.log(`  ${suspects.length} suspected wrappers (score ≥ 45 with off-domain brand reference)`);

  // Probe top suspects — prefer active ones, dedupe by host to spread coverage.
  const probeTargets: ScoredListing[] = [];
  const seenHosts = new Set<string>();
  for (const s of [...suspects].sort((a, b) => (b.calls30d ?? 0) - (a.calls30d ?? 0) || b.score - a.score)) {
    if (seenHosts.has(s.host)) continue;
    seenHosts.add(s.host);
    probeTargets.push(s);
    if (probeTargets.length >= PROBE_COUNT) break;
  }
  console.log(`Probing ${probeTargets.length} top suspects (harmless GET, no payment)…`);
  const probes = new Map<string, ProbeResult>();
  for (const [i, t] of probeTargets.entries()) {
    const p = await probe(t.url);
    probes.set(t.url, p);
    console.log(`  [${i + 1}/${probeTargets.length}] ${t.host} → ${p.status ?? `ERR ${p.error}`}${p.is402 ? " (402 ✓)" : ""}`);
    if (i < probeTargets.length - 1) await new Promise((r) => setTimeout(r, PROBE_DELAY_MS));
  }

  mkdirSync("scratch", { recursive: true });

  // JSON: full record for anything with signal, compact stub for the rest.
  const json = {
    generatedAt: new Date().toISOString(),
    sources: {
      bazaar: { fetched: stats.bazaarFetched, declaredTotal: stats.bazaarTotal },
      goplausible: { fetched: stats.goplausibleFetched },
      x402scan: "no public JSON API found — skipped",
    },
    uniqueEndpoints: scored.length,
    suspectedWrappers: suspects.length,
    thresholds: { suspect: 45, high: 70, medium: 50, low: 35 },
    endpoints: scored.map((s) => {
      const p = probes.get(s.url);
      const base = {
        url: s.url,
        source: s.source,
        score: s.score,
        confidence: s.confidence,
      };
      if (s.score === 0) return base;
      return {
        ...base,
        method: s.method,
        description: s.description.slice(0, 300),
        serviceName: s.serviceName,
        host: s.host,
        payTo: s.payTo,
        network: s.network,
        priceUsd: s.priceUsd,
        calls30d: s.calls30d,
        payers30d: s.payers30d,
        brands: s.brands,
        evidence: s.evidence,
        probe: p,
      };
    }),
  };
  writeFileSync("scratch/wrapper-watch.json", JSON.stringify(json, null, 1));
  console.log(`Wrote scratch/wrapper-watch.json (${scored.length} endpoints)`);

  const report = buildReport(scored, suspects, probes, stats);
  writeFileSync("scratch/wrapper-watch-report.md", report);
  console.log("Wrote scratch/wrapper-watch-report.md");

  // Console summary
  const byBrand = new Map<string, number>();
  for (const s of suspects) {
    for (const b of s.brands.filter((x) => !x.comparative)) {
      byBrand.set(b.brandName, (byBrand.get(b.brandName) ?? 0) + 1);
    }
  }
  console.log("\nSuspected wrappers by brand:");
  for (const [name, n] of [...byBrand.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${name}`);
  }
  console.log("\nTop 10 suspects:");
  for (const s of suspects.slice(0, 10)) {
    console.log(`  ${String(s.score).padStart(3)}  ${s.url.slice(0, 90)}  [${s.brands.filter(b => !b.comparative).map((b) => b.brandId).join(",")}]`);
  }
}

main().catch((e) => {
  console.error("wrapper-watch failed:", e);
  process.exit(1);
});
