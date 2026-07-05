import type { Payment, Chain } from "@agentkit/x402-core";

export type { Payment, Chain };

export type Unsub = () => void;

export interface Indexer {
  readonly chain: Chain;
  /** Backfill a historical window for a set of receiving addresses. */
  backfill(payTo: string[], from: Date, to: Date): AsyncIterable<Payment>;
  /** Stream new payments to a handler; returns an unsubscribe function. */
  subscribe(
    payTo: string[],
    onPayment: (p: Payment) => Promise<void>,
  ): Promise<Unsub>;
}

/** Minimum confirmations before a payment is promoted for downstream use. */
export const MIN_CONFIRMATIONS: Record<Chain, number> = {
  base: 5,
  solana: 32, // ~finalized commitment as a depth proxy
  algorand: 1, // instant finality
};
