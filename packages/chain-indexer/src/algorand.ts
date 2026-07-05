import { USDC } from "@agentkit/x402-core";
import type { Indexer, Payment, Unsub } from "./types.js";
import { normalizeAlgorand, type AlgoIndexerTxn } from "./normalize.js";

/** Nodely mainnet indexer (verified reachable 2026-07; the .nodely.io host does not resolve). */
export const NODELY_MAINNET_INDEXER = "https://mainnet-idx.4160.nodely.dev";

export interface AlgorandIndexerConfig {
  /** Algorand indexer base URL. Defaults to Nodely mainnet. */
  indexerUrl?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  pollMs?: number;
}

interface IndexerPage {
  transactions?: AlgoIndexerTxn[];
  "next-token"?: string;
}

/**
 * Algorand USDC (ASA 31566704) indexer via the Nodely indexer REST API.
 * Pages `/v2/assets/{asset}/transactions?address={payTo}&address-role=receiver`
 * and normalizes each asset-transfer. GoPlausible atomic-group settlements are
 * detected downstream by the classifier (group presence + facilitator address).
 */
export class AlgorandIndexer implements Indexer {
  readonly chain = "algorand" as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollMs: number;

  constructor(config: AlgorandIndexerConfig = {}) {
    this.baseUrl = (
      config.indexerUrl ??
      process.env.ALGOD_INDEXER_URL ??
      NODELY_MAINNET_INDEXER
    ).replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.pollMs = config.pollMs ?? 60_000;
  }

  async *backfill(
    payTo: string[],
    from: Date,
    to: Date,
  ): AsyncIterable<Payment> {
    for (const addr of payTo) {
      let next: string | undefined;
      do {
        const page = await this.fetchPage(addr, {
          afterTime: from.toISOString(),
          beforeTime: to.toISOString(),
          next,
        });
        for (const txn of page.transactions ?? []) {
          const p = normalizeAlgorand(txn);
          if (p) yield p;
        }
        next = page["next-token"];
      } while (next);
    }
  }

  async subscribe(
    payTo: string[],
    onPayment: (p: Payment) => Promise<void>,
  ): Promise<Unsub> {
    let since = new Date();
    const timer = setInterval(async () => {
      const now = new Date();
      try {
        for (const addr of payTo) {
          let next: string | undefined;
          do {
            const page = await this.fetchPage(addr, {
              afterTime: since.toISOString(),
              next,
            });
            for (const txn of page.transactions ?? []) {
              const p = normalizeAlgorand(txn);
              if (p) await onPayment(p);
            }
            next = page["next-token"];
          } while (next);
        }
        since = now;
      } catch {
        // transient; next tick retries from the same `since`
      }
    }, this.pollMs);
    return () => clearInterval(timer);
  }

  private async fetchPage(
    address: string,
    opts: { afterTime?: string; beforeTime?: string; next?: string },
  ): Promise<IndexerPage> {
    const url = new URL(
      `${this.baseUrl}/v2/assets/${USDC.algorand.address}/transactions`,
    );
    url.searchParams.set("address", address);
    url.searchParams.set("address-role", "receiver");
    if (opts.afterTime) url.searchParams.set("after-time", opts.afterTime);
    if (opts.beforeTime) url.searchParams.set("before-time", opts.beforeTime);
    if (opts.next) url.searchParams.set("next", opts.next);
    const res = await this.fetchImpl(url.toString());
    if (!res.ok) {
      throw new Error(`Algorand indexer ${res.status} for ${address}`);
    }
    return (await res.json()) as IndexerPage;
  }
}
