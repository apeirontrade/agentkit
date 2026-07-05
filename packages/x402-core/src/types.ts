import type { Chain, SettlementKind } from "@agentkit/facilitators";

export type { Chain, SettlementKind };

/** A canonical observed payment (mirrors @agentkit/db payments, kept dep-free here). */
export interface Payment {
  chain: Chain;
  txHash: string;
  blockTime: Date;
  payer: string;
  payTo: string;
  amountUsdc: string; // decimal string, 6-dp
  facilitator?: string;
  settlementKind: SettlementKind;
  confirmationDepth: number;
  raw?: unknown;
}

/** A single priced route parsed from an x402 402 response's `accepts`. */
export interface PriceRow {
  scheme: string;
  network: string;
  payTo: string;
  asset: string;
  maxAmountRequiredAtomic: string; // atomic units as returned by the server
  maxAmountRequiredUsdc: string; // decimalized (6-dp) for convenience
  resource?: string;
  description?: string;
}

/** Result of probing an endpoint's 402 response. */
export interface ProbeResult {
  payTo: string;
  chain: Chain;
  prices: PriceRow[];
}

/** Result of classifying a raw transfer as (or not) an x402 settlement. */
export interface Classification {
  isX402: boolean;
  kind: SettlementKind;
  facilitator?: string;
  confidence: number; // 0..1
}
