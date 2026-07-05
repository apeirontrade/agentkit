import { lookupFacilitator, type Chain } from "@agentkit/facilitators";
import type { Classification } from "./types.js";
import { decodeAuthorizationUsed } from "./eip3009.js";

export interface RawTransfer {
  chain: Chain;
  /** The tx submitter / fee-payer (EVM: tx.from; Solana: fee-payer; Algo: group signer). */
  submitter: string;
  /** All logs in the transaction (EVM), for EIP-3009 detection. */
  logs?: Array<{ topics: `0x${string}`[]; data: `0x${string}` }>;
  /** Whether the transfer is part of an Algorand atomic group (>1 txn). */
  isAtomicGroup?: boolean;
}

/**
 * Classify a raw USDC transfer as an x402 settlement (or not).
 *
 * Signals, in order of strength:
 *  1. Submitter is a known facilitator address (registry)          → high confidence
 *  2. (EVM) transaction emitted EIP-3009 `AuthorizationUsed`        → gasless settlement
 *  3. (Algorand) transfer sits inside an atomic group              → facilitator-shaped
 * A direct wallet-to-wallet transfer with none of these is kept but tagged
 * low-confidence `direct` — real x402 volume, but not provably facilitated.
 */
export function classifySettlement(tx: RawTransfer): Classification {
  const fac = lookupFacilitator(tx.chain, tx.submitter);
  if (fac) {
    return { isX402: true, kind: fac.settlement_kind, facilitator: fac.name, confidence: 0.95 };
  }

  if (tx.chain === "base" || tx.chain === "solana") {
    const hasAuth = (tx.logs ?? []).some((l) => decodeAuthorizationUsed(l) !== null);
    if (hasAuth) {
      // EIP-3009 gasless transfer by an unknown submitter — very likely an
      // as-yet-unregistered facilitator. Surface it as a registry candidate.
      return { isX402: true, kind: "eip3009", confidence: 0.7 };
    }
  }

  if (tx.chain === "algorand" && tx.isAtomicGroup) {
    return { isX402: true, kind: "atomic_group", confidence: 0.5 };
  }

  return { isX402: false, kind: "direct", confidence: 0.2 };
}
