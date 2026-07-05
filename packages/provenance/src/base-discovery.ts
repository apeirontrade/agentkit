/**
 * Coinbase Bazaar discovery — the Base x402 endpoint feed (verified open, no
 * auth; 23K+ resources, offset pagination). Flattened to Base-USDC routes for
 * the explorer. Includes Coinbase's own `quality` signal so our independent
 * wash-risk can be compared against the marketplace's self-grading.
 */
export const BAZAAR_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
export const BASE_NETWORK = "eip155:8453";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export interface BaseResource {
  resource: string;
  serviceName?: string;
  description?: string;
  payTo: string;
  amountAtomic: string;
  lastUpdated?: string;
  quality?: unknown; // Coinbase's own signal, kept verbatim for comparison
}

interface BazaarPage {
  items?: Array<{
    resource?: string;
    serviceName?: string;
    description?: string;
    lastUpdated?: string;
    quality?: unknown;
    accepts?: Array<{ network?: string; asset?: string; payTo?: string; amount?: string; scheme?: string }>;
  }>;
  pagination?: { limit?: number; offset?: number; total?: number };
}

export interface BazaarFetchOptions {
  maxItems?: number; // stop after this many raw items (default 200)
  fetchImpl?: typeof fetch;
  onProgress?: (msg: string) => void;
}

/** Fetch Bazaar resources (paged) and flatten to Base-USDC routes. */
export async function fetchBaseResources(opts: BazaarFetchOptions = {}): Promise<{
  routes: BaseResource[];
  total: number;
}> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxItems = opts.maxItems ?? 200;
  const routes: BaseResource[] = [];
  let offset = 0;
  let total = 0;
  while (offset < maxItems) {
    const res = await fetchImpl(`${BAZAAR_URL}?limit=100&offset=${offset}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Bazaar discovery ${res.status}`);
    const page = (await res.json()) as BazaarPage;
    total = page.pagination?.total ?? total;
    const items = page.items ?? [];
    if (items.length === 0) break;
    for (const it of items) {
      for (const a of it.accepts ?? []) {
        if (a.network !== BASE_NETWORK || !a.payTo) continue;
        if (a.asset && a.asset.toLowerCase() !== BASE_USDC.toLowerCase()) continue;
        routes.push({
          resource: it.resource ?? "",
          serviceName: it.serviceName,
          description: it.description,
          payTo: a.payTo,
          amountAtomic: a.amount ?? "0",
          lastUpdated: it.lastUpdated,
          quality: it.quality,
        });
      }
    }
    opts.onProgress?.(`bazaar: ${offset + items.length}/${total} items scanned, ${routes.length} Base-USDC routes`);
    offset += items.length;
    if (offset >= total) break;
  }
  return { routes, total };
}

/** Group routes by payTo (a merchant may expose many routes). */
export function groupByPayTo(routes: BaseResource[]): Map<string, BaseResource[]> {
  const m = new Map<string, BaseResource[]>();
  for (const r of routes) {
    const list = m.get(r.payTo) ?? [];
    list.push(r);
    m.set(r.payTo, list);
  }
  return m;
}
