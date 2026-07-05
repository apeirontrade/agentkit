/**
 * GoPlausible x402 discovery — the sole Algorand endpoint feed (Coinbase's
 * bazaar is EVM/Solana only). This registry is effectively the Global x402
 * Challenge leaderboard's raw source: each resource carries the facilitator's
 * own verifyCount/settleCount, which we diff against real on-chain volume to
 * compute organic-revenue quality. Verified live 2026-07-05.
 */
export const GOPLAUSIBLE_FACILITATOR = "https://facilitator.goplausible.xyz";
export const ALGORAND_MAINNET_NETWORK =
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
/** Facilitator sponsor/feePayer — filter from payer/counterparty graphs. */
export const GOPLAUSIBLE_SPONSOR =
  "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";

export interface X402Resource {
  resourceUrl: string;
  method?: string;
  description?: string;
  payTo: string;
  network: string;
  asset: string;
  amount: string;
  verifyCount: number;
  settleCount: number;
  firstSeen?: string;
  lastSeen?: string;
}

interface DiscoveryPage {
  x402Version?: number;
  items?: Array<{
    resourceUrl: string;
    method?: string;
    description?: string;
    verifyCount?: number;
    settleCount?: number;
    firstSeen?: string;
    lastSeen?: string;
    accepts?: Array<{
      scheme?: string;
      network?: string;
      asset?: string;
      amount?: string;
      payTo?: string;
    }>;
  }>;
  pagination?: { total?: number; nextOffset?: number };
}

export interface DiscoveryOptions {
  facilitatorUrl?: string;
  fetchImpl?: typeof fetch;
  /** Only Algorand-network resources (default true). */
  algorandOnly?: boolean;
  limit?: number;
}

/** Fetch the live x402 resource registry, flattened to one row per priced route. */
export async function fetchResources(opts: DiscoveryOptions = {}): Promise<X402Resource[]> {
  const base = (opts.facilitatorUrl ?? GOPLAUSIBLE_FACILITATOR).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? 200;
  const res = await fetchImpl(`${base}/discovery/resources?limit=${limit}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GoPlausible discovery ${res.status}`);
  const page = (await res.json()) as DiscoveryPage;
  const out: X402Resource[] = [];
  for (const it of page.items ?? []) {
    for (const a of it.accepts ?? []) {
      if (!a.payTo || !a.network) continue;
      if (opts.algorandOnly !== false && !a.network.startsWith("algorand:")) continue;
      out.push({
        resourceUrl: it.resourceUrl,
        method: it.method,
        description: it.description,
        payTo: a.payTo,
        network: a.network,
        asset: a.asset ?? "",
        amount: a.amount ?? "",
        verifyCount: it.verifyCount ?? 0,
        settleCount: it.settleCount ?? 0,
        firstSeen: it.firstSeen,
        lastSeen: it.lastSeen,
      });
    }
  }
  return out;
}

/** Distinct payTo addresses across the registry (dedup multi-endpoint merchants). */
export function distinctPayTos(resources: X402Resource[]): Map<string, X402Resource[]> {
  const m = new Map<string, X402Resource[]>();
  for (const r of resources) {
    const list = m.get(r.payTo) ?? [];
    list.push(r);
    m.set(r.payTo, list);
  }
  return m;
}
