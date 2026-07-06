/**
 * Wrapper Watch scoring — layered heuristics, each contributing named
 * evidence to a 0–100 wrapper-likelihood score.
 *
 * Layers:
 *   A. Brand-term matching (endpoint references a first-party brand but is
 *      NOT hosted on that brand's domain)
 *   B. Proxy signatures ("access to X API" phrasing, generic passthrough
 *      input schema, plausible cost-plus markup on known per-call prices)
 *   C. Domain forensics (generic/ephemeral hosting while claiming premium data)
 */
import {
  BRANDS,
  Brand,
  COMPARATIVE_PHRASES,
  GENERIC_INFRA_SUFFIXES,
} from "./wrapper-watch-brands";
import type { Listing } from "./wrapper-watch-collect";

export interface Evidence {
  layer: "brand-match" | "proxy-signature" | "domain-forensics";
  signal: string;
  detail: string;
  points: number;
}

export interface BrandHit {
  brandId: string;
  brandName: string;
  term: string;
  where: "url" | "description" | "schema" | "tags" | "serviceName";
  comparative: boolean;
}

export interface ScoredListing extends Listing {
  score: number;
  confidence: "high" | "medium" | "low" | "none";
  brands: BrandHit[];
  evidence: Evidence[];
}

const GENERIC_INPUT_NAMES = new Set([
  "query", "q", "prompt", "input", "text", "question", "search", "message", "url", "keywords", "term",
]);

function suffixMatch(host: string, suffixes: string[]): string | null {
  for (const s of suffixes) {
    if (host === s || host.endsWith("." + s)) return s;
  }
  return null;
}

function termRegex(term: string): RegExp {
  // word-boundary, escape specials, allow the term's internal spaces/hyphens to interchange
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[ -]/g, "[ \\-_]");
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`, "i");
}

// Precompile per-brand regexes once.
const BRAND_REGEXES = BRANDS.map((b) => ({
  brand: b,
  regexes: b.terms.map((t) => ({ term: t, re: termRegex(t) })),
}));

function findBrandHits(l: Listing): BrandHit[] {
  const hits: BrandHit[] = [];
  const fields: Array<[BrandHit["where"], string]> = [
    ["url", l.url.toLowerCase()],
    ["description", l.description.toLowerCase()],
    ["serviceName", (l.serviceName ?? "").toLowerCase()],
    ["tags", l.tags.join(" ").toLowerCase()],
    ["schema", l.schemaText.toLowerCase()],
  ];
  for (const { brand, regexes } of BRAND_REGEXES) {
    // First-party check: endpoint on the brand's own domain → not a wrapper of itself.
    if (suffixMatch(l.host, brand.officialDomains)) continue;
    for (const { term, re } of regexes) {
      for (const [where, text] of fields) {
        if (!text) continue;
        const m = re.exec(text);
        if (!m) continue;
        // Excluded context (e.g. "twitter card" HTML metadata) voids the match.
        if (brand.excludeContexts) {
          const ctx = text.slice(Math.max(0, (m.index ?? 0) - 20), (m.index ?? 0) + term.length + 22);
          if (brand.excludeContexts.some((x) => x.test(ctx))) continue;
        }
        // Comparative-mention check: 40-char window before the term.
        const start = Math.max(0, (m.index ?? 0) - 40);
        const before = text.slice(start, m.index ?? 0);
        const comparative =
          where === "description" &&
          COMPARATIVE_PHRASES.some((p) => new RegExp(`\\b${p}\\b\\s*$|\\b${p}\\b[^.]{0,25}$`).test(before));
        hits.push({ brandId: brand.id, brandName: brand.name, term, where, comparative });
        break; // one hit per term is enough
      }
    }
  }
  // dedupe to one hit per brand (prefer non-comparative, prefer url > description)
  const order: BrandHit["where"][] = ["url", "serviceName", "description", "tags", "schema"];
  const byBrand = new Map<string, BrandHit>();
  for (const h of hits) {
    const prev = byBrand.get(h.brandId);
    if (!prev) { byBrand.set(h.brandId, h); continue; }
    const better =
      (prev.comparative && !h.comparative) ||
      (prev.comparative === h.comparative && order.indexOf(h.where) < order.indexOf(prev.where));
    if (better) byBrand.set(h.brandId, h);
  }
  return [...byBrand.values()];
}

const PROXY_PHRASES: Array<[RegExp, string]> = [
  [/\b(access|gateway|proxy|bridge)\s+(to|for|into)\s+(the\s+)?[\w .|-]{2,40}\bapi\b/i, "promises access/proxy/gateway to a named API"],
  [/\bapi\s+prox(y|ies)\b/i, "self-describes as an API proxy"],
  [/\bprox(y|ies|ying)\b[^.]{0,80}\b(api|endpoint)\b/i, "proxies a named API/endpoint"],
  [/\bwrapper\s+(for|around|over)\b/i, "self-describes as a wrapper"],
  [/\bpowered\s+by\b/i, "'powered by' upstream-provider phrasing"],
  [/\b(resell|resale|reselling)\b/i, "resale language in description"],
  [/\bunofficial\b/i, "self-describes as unofficial"],
  [/\bwithout\s+(an?\s+)?api\s*key\b/i, "sells key-free access (upstream key laundering)"],
  [/\bno\s+api\s*key\s+(needed|required)\b/i, "sells key-free access (upstream key laundering)"],
  [/\b(data|results|prices?|quotes?)\s+(from|via|sourced from)\s+[A-Z][\w.]+/, "declares upstream data source"],
];

export function scoreListing(l: Listing): ScoredListing {
  const evidence: Evidence[] = [];
  const brands = findBrandHits(l);

  // --- Layer A: brand matches off-domain ---
  const strong = brands.filter((b) => !b.comparative);
  const comparative = brands.filter((b) => b.comparative);
  if (strong.length > 0) {
    const first = strong[0];
    evidence.push({
      layer: "brand-match",
      signal: "brand-term-off-domain",
      detail: `references ${strong.map((b) => b.brandName).join(", ")} (via "${first.term}" in ${first.where}) but is hosted on ${l.host}, not the brand's domain`,
      points: 35 + Math.min(strong.length - 1, 2) * 5,
    });
    const urlHit = strong.find((b) => b.where === "url");
    if (urlHit) {
      evidence.push({
        layer: "brand-match",
        signal: "brand-in-url-path",
        detail: `brand term "${urlHit.term}" appears in the endpoint URL itself`,
        points: 10,
      });
    }
  } else if (comparative.length > 0) {
    evidence.push({
      layer: "brand-match",
      signal: "brand-comparative-mention",
      detail: `mentions ${comparative.map((b) => b.brandName).join(", ")} comparatively ("alternative to"-style) — weaker signal`,
      points: 10,
    });
  }

  // --- Layer B: proxy signatures ---
  const desc = l.description;
  for (const [re, label] of PROXY_PHRASES) {
    const m = re.exec(desc);
    if (m) {
      evidence.push({
        layer: "proxy-signature",
        signal: "proxy-language",
        detail: `${label}: "${m[0].slice(0, 80)}"`,
        points: 15,
      });
      break; // strongest one is enough
    }
  }
  if (
    l.inputParams.length > 0 &&
    l.inputParams.length <= 2 &&
    l.inputParams.every((p) => GENERIC_INPUT_NAMES.has(p))
  ) {
    evidence.push({
      layer: "proxy-signature",
      signal: "generic-passthrough-schema",
      detail: `input schema is a bare passthrough (${l.inputParams.join(", ")}) — consistent with forwarding to an upstream API`,
      points: 10,
    });
  }
  if (l.priceUsd !== null && strong.length > 0) {
    const priced = strong
      .map((b) => BRANDS.find((x) => x.id === b.brandId)!)
      .filter((b): b is Brand => !!b && b.knownUnitUsd !== undefined);
    for (const b of priced) {
      const ratio = l.priceUsd / b.knownUnitUsd!;
      if (ratio >= 1.2 && ratio <= 100) {
        evidence.push({
          layer: "proxy-signature",
          signal: "cost-plus-markup",
          detail: `$${l.priceUsd.toFixed(4)}/call ≈ ${ratio.toFixed(1)}× ${b.name}'s public ~$${b.knownUnitUsd}/call — consistent with cost-plus resale margin`,
          points: 8,
        });
        break;
      }
    }
  }

  // --- Layer C: domain forensics ---
  const infra = suffixMatch(l.host, GENERIC_INFRA_SUFFIXES);
  const bareIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(l.host) || l.host === "localhost";
  if (infra || bareIp) {
    const claimsPremium = strong.length > 0;
    evidence.push({
      layer: "domain-forensics",
      signal: bareIp ? "bare-ip-host" : "generic-infra-host",
      detail: `hosted on ${bareIp ? "a bare IP/localhost" : `generic infrastructure (${infra})`}${claimsPremium ? " while referencing premium first-party data" : ""}`,
      points: claimsPremium ? 12 : 3,
    });
  }

  let score = Math.min(100, evidence.reduce((s, e) => s + e.points, 0));
  // A listing with no brand association can't be a brand wrapper — cap it low.
  if (strong.length === 0 && comparative.length === 0) score = Math.min(score, 25);

  const confidence: ScoredListing["confidence"] =
    score >= 70 ? "high" : score >= 50 ? "medium" : score >= 35 ? "low" : "none";

  return { ...l, score, confidence, brands, evidence };
}
