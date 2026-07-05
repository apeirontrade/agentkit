import type { Chain } from "@agentkit/facilitators";

/** USDC token addresses per chain. Base confirmed; others VERIFY before use. */
export const USDC: Record<Chain, { address: string; decimals: number; network: string }> = {
  // Base mainnet USDC, 6 decimals, CAIP-2 network eip155:8453 (confirmed).
  base: {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    network: "eip155:8453",
  },
  // Solana mainnet USDC SPL mint (confirmed well-known); network per x402 CAIP-2.
  solana: {
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
    network: "solana:mainnet",
  },
  // Algorand mainnet USDC ASA 31566704, 6 decimals (confirmed).
  algorand: {
    address: "31566704",
    decimals: 6,
    network: "algorand:mainnet",
  },
};

/**
 * EIP-3009 `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)`.
 * Emitted by USDC when a facilitator settles an x402 payment via
 * transferWithAuthorization — the on-chain fingerprint of a gasless x402
 * settlement on EVM chains. topic0 = keccak256 of the signature.
 */
export const AUTHORIZATION_USED_EVENT =
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)";
export const AUTHORIZATION_USED_TOPIC0 =
  "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

/** x402 payment header (renamed from X-PAYMENT ~Jan 2026). */
export const PAYMENT_HEADER = "PAYMENT-SIGNATURE";

/** Apify agentic-payments (confirmed 2026-07 against docs.apify.com/platform/integrations/x402). */
export const APIFY = {
  prepaidTokenEndpoint: "https://agi.apify.com/protocols/x402/prepaid-tokens",
  minPurchaseUsd: 1,
  tokenTtlDays: 14, // unused balance non-refundable — buy small tranches
  network: "eip155:8453", // USDC on Base
  actorRunTemplate:
    "https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items",
} as const;
