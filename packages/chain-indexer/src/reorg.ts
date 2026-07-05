import type { Chain, Payment } from "./types.js";
import { MIN_CONFIRMATIONS } from "./types.js";

/**
 * Reorg safety: a payment is only "confirmed" (safe for scoring/booking) once
 * it is buried under MIN_CONFIRMATIONS. Below that it is staged and may still
 * be reorged out on Base/Solana. Algorand has instant finality (depth 1).
 */
export function isConfirmed(p: Payment): boolean {
  return p.confirmationDepth >= MIN_CONFIRMATIONS[p.chain];
}

/** Compute confirmation depth from the current head. */
export function depthFor(
  chain: Chain,
  itemBlock: number,
  headBlock: number,
): number {
  const depth = headBlock - itemBlock;
  return depth < 0 ? 0 : depth;
}

export function confirmationsRequired(chain: Chain): number {
  return MIN_CONFIRMATIONS[chain];
}
