import type { Indexer, Payment, Unsub } from "./types.js";

/**
 * Solana USDC indexer — scheduled for week 6 (Provenance Solana coverage).
 * Planned impl: Helius enhanced-transactions webhooks (live) + backfill API,
 * filtering USDC SPL transfers, classifying facilitators by fee-payer/signers.
 * VERIFY at build time: Token2022/ATA edge cases.
 *
 * Stubbed to keep the Indexer interface complete without pulling the Helius
 * dependency before it is needed.
 */
export class SolanaIndexer implements Indexer {
  readonly chain = "solana" as const;

  // eslint-disable-next-line require-yield
  async *backfill(): AsyncIterable<Payment> {
    throw new Error("SolanaIndexer.backfill not implemented (planned week 6)");
  }

  async subscribe(): Promise<Unsub> {
    throw new Error("SolanaIndexer.subscribe not implemented (planned week 6)");
  }
}
