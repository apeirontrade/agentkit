import type { Chain, PriceRow, ProbeResult } from "./types.js";
import { USDC } from "./constants.js";

/** The shape of an x402 402 response body (`accepts` per the spec). */
interface X402Body {
  x402Version?: number;
  accepts?: Array<{
    scheme?: string;
    network?: string;
    payTo?: string;
    asset?: string;
    maxAmountRequired?: string;
    resource?: string;
    description?: string;
  }>;
  error?: string;
}

function networkToChain(network: string | undefined): Chain | undefined {
  if (!network) return undefined;
  if (network.startsWith("eip155:")) return "base"; // 8453; refine per chainId if needed
  if (network.startsWith("solana:")) return "solana";
  if (network.startsWith("algorand:")) return "algorand";
  return undefined;
}

/** Decimalize an atomic amount for a chain's USDC decimals. */
function decimalize(atomic: string, chain: Chain | undefined): string {
  const decimals = chain ? USDC[chain].decimals : 6;
  const neg = atomic.startsWith("-");
  const digits = (neg ? atomic.slice(1) : atomic).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  const body = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${body}` : body;
}

/** Parse the priced routes out of a 402 response body. */
export function parsePrices(body: unknown): PriceRow[] {
  const b = body as X402Body;
  if (!b?.accepts?.length) return [];
  return b.accepts.map((a) => {
    const chain = networkToChain(a.network);
    const atomic = a.maxAmountRequired ?? "0";
    return {
      scheme: a.scheme ?? "exact",
      network: a.network ?? "",
      payTo: a.payTo ?? "",
      asset: a.asset ?? "",
      maxAmountRequiredAtomic: atomic,
      maxAmountRequiredUsdc: decimalize(atomic, chain),
      resource: a.resource,
      description: a.description,
    };
  });
}

/**
 * Probe an endpoint: an unauthenticated GET should yield a 402 whose body
 * declares payTo + prices. Returns null if the endpoint is not x402-gated.
 */
export async function probePayTo(url: string): Promise<ProbeResult | null> {
  const res = await fetch(url);
  if (res.status !== 402) return null;
  const prices = parsePrices(await res.json());
  const first = prices.find((p) => p.payTo);
  if (!first) return null;
  const chain = networkToChain(first.network) ?? "base";
  return { payTo: first.payTo, chain, prices };
}
