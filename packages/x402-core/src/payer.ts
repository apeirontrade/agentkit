import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { USDC } from "./constants.js";
import type { PriceRow } from "./types.js";
import { parsePrices } from "./probe.js";

export interface PayerOptions {
  /** EVM private key (0x...) for the hot wallet. Keep the balance thin. */
  evmPrivateKey: `0x${string}`;
  /** CAIP-2 networks to enable. Defaults to Base mainnet. */
  networks?: string[];
}

export interface PayOptions {
  /** Hard per-call ceiling in USDC (decimal string). Aborts if the endpoint
   *  demands more. This is enforced by a preflight, independent of the
   *  library's own selection, so an over-priced endpoint can never overspend. */
  maxAmountUsdc: string;
  init?: RequestInit;
}

export interface Payer {
  /** Fetch a paid resource, enforcing a hard per-call USDC ceiling. */
  fetchWithPayment(url: string, opts: PayOptions): Promise<Response>;
  /** Inspect what an endpoint would charge, without paying. */
  quote(url: string): Promise<PriceRow[]>;
}

/**
 * The x402 payer — the client half of x402-core (Jobsmith buys; every product
 * dogfoods). Built on Coinbase's @x402/fetch v2 `.register(network, scheme)`
 * builder. A viem LocalAccount is a valid ClientEvmSigner directly.
 */
export function createPayer(options: PayerOptions): Payer {
  const account = privateKeyToAccount(options.evmPrivateKey);
  const networks = options.networks ?? [USDC.base.network];

  const client = new x402Client();
  for (const network of networks) {
    // EVM schemes only for now; SVM/AVM registered here as those rails land.
    if (network.startsWith("eip155:")) {
      client.register(network as `${string}:${string}`, new ExactEvmScheme(account));
    }
  }
  const paidFetch = wrapFetchWithPayment(fetch, client);

  async function quote(url: string): Promise<PriceRow[]> {
    const res = await fetch(url);
    if (res.status !== 402) return [];
    return parsePrices(await res.json());
  }

  async function fetchWithPayment(url: string, opts: PayOptions): Promise<Response> {
    // Preflight: read the demanded price and enforce our ceiling BEFORE paying.
    const prices = await quote(url);
    if (prices.length > 0) {
      const cheapest = prices
        .map((p) => p.maxAmountRequiredUsdc)
        .sort((a, b) => Number(a) - Number(b))[0]!;
      if (Number(cheapest) > Number(opts.maxAmountUsdc)) {
        throw new PaymentCeilingExceeded(url, cheapest, opts.maxAmountUsdc);
      }
    }
    return paidFetch(url, opts.init);
  }

  return { fetchWithPayment, quote };
}

export class PaymentCeilingExceeded extends Error {
  constructor(
    readonly url: string,
    readonly demandedUsdc: string,
    readonly ceilingUsdc: string,
  ) {
    super(
      `endpoint ${url} demands ${demandedUsdc} USDC, exceeds ceiling ${ceilingUsdc}`,
    );
    this.name = "PaymentCeilingExceeded";
  }
}
