import { decodeEventLog, parseAbiItem } from "viem";
import { AUTHORIZATION_USED_EVENT } from "./constants.js";

const authUsedAbi = parseAbiItem(AUTHORIZATION_USED_EVENT);

export interface AuthorizationUsed {
  authorizer: string;
  nonce: string;
}

/** Minimal log shape (an indexer row), looser than viem's tuple-typed Log. */
export interface EvmLogLike {
  topics: `0x${string}`[];
  data: `0x${string}`;
}

/**
 * Decode a USDC `AuthorizationUsed` log. Presence of this event in a USDC
 * transfer transaction is the on-chain signature of an EIP-3009 gasless
 * settlement — the mechanism x402 facilitators use on EVM chains.
 * Returns null if the log is not an AuthorizationUsed event.
 */
export function decodeAuthorizationUsed(
  log: EvmLogLike,
): AuthorizationUsed | null {
  try {
    const decoded = decodeEventLog({
      abi: [authUsedAbi],
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      data: log.data,
    });
    if (decoded.eventName !== "AuthorizationUsed") return null;
    const args = decoded.args as unknown as {
      authorizer: string;
      nonce: string;
    };
    return { authorizer: args.authorizer, nonce: args.nonce };
  } catch {
    return null;
  }
}
