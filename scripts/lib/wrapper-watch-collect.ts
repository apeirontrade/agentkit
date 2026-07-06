/**
 * Wrapper Watch data collection — normalizes x402 endpoint listings from:
 *   1. Coinbase Bazaar discovery API (EVM/Solana; free, no auth; paginated)
 *   2. GoPlausible Algorand facilitator registry (via @agentkit/provenance)
 *
 * x402scan.com was probed and exposes no public JSON API (Next.js app,
 * tRPC routes redirect) — skipped.
 */
import { fetchResources } from "@agentkit/provenance";

export const USER_AGENT = "provenance-wrapper-watch/0.1";

/** One normalized x402 endpoint listing. */
export interface Listing {
  source: "bazaar" | "goplausible";
  url: string;
  host: string;
  method?: string;
  description: string;
  serviceName?: string;
  tags: string[];
  /** JSON-stringified declared input/output schema (bazaar extensions / goplausible discoveryInfo). */
  schemaText: string;
  /** Input parameter names declared in the schema (query/body/path params). */
  inputParams: string[];
  payTo: string;
  network: string;
  asset: string;
  amountAtomic: string;
  /** USD price if the asset is a recognized USDC deployment (6 decimals). */
  priceUsd: number | null;
  /** Bazaar 30-day quality stats when present. */
  calls30d?: number;
  payers30d?: number;
  lastUpdated?: string;
}

const USDC_ASSETS = new Set([
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // Base USDC
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // Arbitrum USDC
  "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238", // Base Sepolia USDC
  "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v", // Solana USDC
  "31566704", // Algorand USDC
]);

function usdFromAtomic(asset: string, amount: string): number | null {
  if (!asset || !amount) return null;
  if (!USDC_ASSETS.has(asset.toLowerCase())) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return n / 1e6;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Pull declared input parameter names out of a bazaar/goplausible info block. */
function inputParamsOf(info: any): string[] {
  const params = new Set<string>();
  const input = info?.input;
  if (!input || typeof input !== "object") return [];
  for (const key of ["queryParams", "pathParams", "body"]) {
    const obj = input[key];
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const k of Object.keys(obj)) params.add(k.toLowerCase());
    }
  }
  return [...params];
}

interface CollectStats {
  bazaarTotal: number;
  bazaarFetched: number;
  goplausibleFetched: number;
  deduped: number;
}

export interface CollectResult {
  listings: Listing[];
  stats: CollectStats;
}

/** Fetch + normalize + dedupe all listings. */
export async function collectListings(opts: {
  bazaarMax?: number; // safety cap on items fetched
  log?: (msg: string) => void;
}): Promise<CollectResult> {
  const log = opts.log ?? (() => {});
  const listings: Listing[] = [];
  const stats: CollectStats = { bazaarTotal: 0, bazaarFetched: 0, goplausibleFetched: 0, deduped: 0 };

  // --- 1. Coinbase Bazaar (paginated, limit 500/page verified live) ---
  const pageSize = 500;
  const max = opts.bazaarMax ?? Infinity;
  let offset = 0;
  for (;;) {
    const url = `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`bazaar discovery ${res.status} at offset ${offset}`);
    const page = (await res.json()) as any;
    stats.bazaarTotal = page.pagination?.total ?? stats.bazaarTotal;
    const items: any[] = page.items ?? [];
    for (const it of items) {
      const accept = (it.accepts ?? [])[0] ?? {};
      const info = it.extensions?.bazaar?.info;
      listings.push({
        source: "bazaar",
        url: it.resource ?? "",
        host: hostOf(it.resource ?? ""),
        method: info?.input?.method,
        description: String(it.description ?? ""),
        serviceName: it.serviceName,
        tags: Array.isArray(it.tags) ? it.tags.map(String) : [],
        schemaText: info ? JSON.stringify(info) : "",
        inputParams: inputParamsOf(info),
        payTo: String(accept.payTo ?? ""),
        network: String(accept.network ?? ""),
        asset: String(accept.asset ?? ""),
        amountAtomic: String(accept.amount ?? ""),
        priceUsd: usdFromAtomic(String(accept.asset ?? ""), String(accept.amount ?? "")),
        calls30d: it.quality?.l30DaysTotalCalls,
        payers30d: it.quality?.l30DaysUniquePayers,
        lastUpdated: it.lastUpdated,
      });
    }
    stats.bazaarFetched += items.length;
    offset += items.length;
    log(`bazaar: ${stats.bazaarFetched}/${stats.bazaarTotal}`);
    if (items.length < pageSize || offset >= Math.min(stats.bazaarTotal, max)) break;
    await new Promise((r) => setTimeout(r, 250)); // politeness
  }

  // --- 2. GoPlausible Algorand registry ---
  try {
    const algo = await fetchResources({ algorandOnly: true });
    for (const r of algo) {
      listings.push({
        source: "goplausible",
        url: r.resourceUrl,
        host: hostOf(r.resourceUrl),
        method: r.method,
        description: r.description ?? "",
        tags: [],
        schemaText: "",
        inputParams: [],
        payTo: r.payTo,
        network: r.network,
        asset: r.asset,
        amountAtomic: r.amount,
        priceUsd: usdFromAtomic(r.asset, r.amount),
        calls30d: r.settleCount, // lifetime settles — closest activity proxy
        lastUpdated: r.lastSeen,
      });
      stats.goplausibleFetched++;
    }
    log(`goplausible: ${stats.goplausibleFetched}`);
  } catch (e) {
    log(`goplausible fetch failed (continuing): ${(e as Error).message}`);
  }

  // --- dedupe by method+url (bazaar re-lists resources per facilitator) ---
  const seen = new Map<string, Listing>();
  for (const l of listings) {
    const key = `${l.method ?? "GET"} ${l.url}`;
    const prev = seen.get(key);
    if (!prev || (l.calls30d ?? 0) > (prev.calls30d ?? 0)) seen.set(key, l);
  }
  stats.deduped = listings.length - seen.size;
  return { listings: [...seen.values()], stats };
}
