/**
 * Organic Revenue Quality (ORQ) scoring — inputs and outputs.
 *
 * The engine is a PURE function of a `ScoringInput` so it is fully testable
 * against fixtures. The data-gathering (querying @agentkit/db payments,
 * per-wallet lookups via the indexer, funding-edge assembly) is a separate
 * concern that assembles this input; see assembleInput in the app layer.
 */

/** One inbound payment to the endpoint under analysis. */
export interface PaymentRecord {
  payer: string;
  amountUsdc: string; // decimal string
  blockTime: Date;
  txHash: string;
  /** Algorand: present when the payment was in an atomic group (facilitator-shaped). */
  group?: string;
}

/** Per-payer-wallet fingerprint (optional; signals degrade gracefully if absent). */
export interface WalletMeta {
  /** When the wallet was first seen on-chain. */
  firstSeen?: Date;
  /** Funding-graph root: the wallet that first funded this payer. */
  firstFunder?: string;
  /** Distinct non-USDC assets/tokens the wallet has held. */
  distinctTokens?: number;
  /** Distinct counterparties the wallet has transacted with. */
  distinctCounterparties?: number;
  /**
   * Algorand rekey target (auth-addr). Wallets sharing one auth-addr are
   * provably controlled by the same key → the same entity. The strongest
   * Algorand-native Sybil signal (no EVM equivalent).
   */
  authAddr?: string;
}

/** A directed value-flow edge (funding or payout), used for clustering + cycles. */
export interface FlowEdge {
  from: string;
  to: string;
}

export interface ScoringInput {
  endpointId: string;
  /** The endpoint's receiving address. */
  payTo: string;
  /** The endpoint owner/deployer wallet, if known (self-dealing lineage). */
  deployer?: string;
  /** Rolling analysis window. */
  windowStart: Date;
  windowEnd: Date;
  payments: PaymentRecord[];
  /** Optional per-payer metadata, keyed by address. */
  walletMeta?: Record<string, WalletMeta>;
  /** Optional funding edges among/into payers (for clustering). */
  fundingEdges?: FlowEdge[];
  /** Optional outbound flow edges FROM payTo (for self-dealing cycle detection). */
  payoutEdges?: FlowEdge[];
  /** Optional: payer → set of other endpoints they pay, for cross-endpoint rings. */
  crossEndpoint?: Record<string, string[]>;
  /** Optional: endpoints sharing this endpoint's deployer (for ring detection). */
  siblingEndpoints?: string[];
}

export type Grade = "A" | "B" | "C" | "D" | "F" | "INSUFFICIENT_DATA";

export interface SubScore {
  value: number; // 0..1, 1 = organic-consistent
  dataBacked: boolean; // false when the signal ran on absent/optional data
}

export interface ScoreResult {
  endpointId: string;
  grade: Grade;
  orq: number | null; // 0..100, null when INSUFFICIENT_DATA
  ciLow: number | null;
  ciHigh: number | null;
  subscores: Record<string, SubScore>;
  nPayments: number;
  nPayerClusters: number;
  methodologyVersion: string;
  flags: string[]; // human-readable evidence notes
}

export const METHODOLOGY_VERSION = "0.1.0";

/** Data floor — below this, we report INSUFFICIENT_DATA rather than grade. */
export const MIN_PAYMENTS = 50;
export const MIN_PAYER_CLUSTERS = 10;
