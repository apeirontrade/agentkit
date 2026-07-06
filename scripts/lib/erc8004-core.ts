/**
 * ERC-8004 (Trustless Agents) — Base mainnet constants, ABIs, and the
 * Provenance registration/feedback document builders.
 *
 * Verified 2026-07-05 against:
 *   - spec:      https://eips.ethereum.org/EIPS/eip-8004  (Draft, deployed)
 *   - contracts: https://github.com/erc-8004/erc-8004-contracts
 *
 * Canonical singleton deployments (same vanity addresses on 35+ chains,
 * bytecode confirmed live on Base mainnet via eth_getCode):
 *   IdentityRegistry   0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
 *   ReputationRegistry 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
 *   ValidationRegistry — NOT deployed to mainnet yet (spec section still in
 *   revision with the TEE community), which is why Provenance publishes
 *   through the Reputation Registry.
 *
 * Mechanism notes that shape everything below:
 *   - register() is permissionless (ERC-721 mint, sequential agentId from 0,
 *     no fee). Anyone may mint an identity whose agentURI describes a service
 *     they do not operate — ownership of the NFT is disclosed on-chain.
 *   - giveFeedback() is unilateral: NO pre-authorization by the rated agent.
 *     The single integrity check is `isAuthorizedOrOwner(msg.sender, agentId)`
 *     must be false (owner/operators cannot rate their own agent). Hence the
 *     two-wallet pattern: the REGISTRAR mints endpoint identities, the
 *     ATTESTER (a different EOA, never approved on those tokens) rates them.
 */
import { parseAbi, keccak256, stringToHex } from "viem";

export const BASE_CHAIN_ID = 8453;
export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
export const REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as const;

export const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function isAuthorizedOrOwner(address spender, uint256 agentId) view returns (bool)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

export const reputationAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function revokeFeedback(uint256 agentId, uint64 feedbackIndex)",
  "function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);

/** One merchant row from scratch/provenance-snapshot.json. */
export interface SnapshotRow {
  payTo: string;
  resourceUrls: string[];
  description: string;
  facilitatorVerify: number;
  facilitatorSettle: number;
  onChainPayments: number;
  onChainPayers: number;
  nClusters: number;
  grade: string;
  orq: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  washLevel: string;
  washScore: number;
  topFlags: string[];
  drift: number;
}

export interface Snapshot {
  takenAt: string;
  windowDays: number;
  totalRoutes: number;
  rows: SnapshotRow[];
}

/** Persisted mapping payTo -> minted agentId, plus published-feedback dedupe. */
export interface PublishState {
  chainId: number;
  registrar?: string;
  attester?: string;
  agents: Record<string, { agentId: string; txHash: string; registeredAt: string }>;
  /** key: `${payTo}|${tag1}` -> last published feedbackHash (skip unchanged) */
  published: Record<string, string>;
}

export const emptyState = (): PublishState => ({
  chainId: BASE_CHAIN_ID,
  agents: {},
  published: {},
});

const dataUri = (json: unknown): string =>
  "data:application/json;base64," + Buffer.from(JSON.stringify(json)).toString("base64");

/** Detect the settlement chain of a payTo address (Algorand base32 vs EVM hex). */
export const payToChain = (payTo: string): "algorand" | "base" | "unknown" =>
  /^0x[0-9a-fA-F]{40}$/.test(payTo) ? "base" : /^[A-Z2-7]{58}$/.test(payTo) ? "algorand" : "unknown";

/**
 * ERC-8004 registration file for an *unclaimed* x402 endpoint identity.
 * Required fields per spec: type, name, description, image (+ services).
 * The `provenance` block discloses that Provenance (not the operator) minted
 * this identity purely as a rating subject, and how the operator can claim it.
 */
export function buildRegistrationFile(row: SnapshotRow) {
  const primary = row.resourceUrls[0] ?? "";
  const host = primary ? new URL(primary).host : row.payTo.slice(0, 12);
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: `x402 endpoint: ${host}`,
    description: row.description || `x402 machine-payable API at ${host}`,
    image: "https://provenance.apeiron.trade/badge.svg",
    active: true,
    x402Support: true,
    services: row.resourceUrls.map((u) => ({ name: "x402-resource", endpoint: u })),
    provenance: {
      role: "unclaimed-endpoint-identity",
      registeredBy: "Provenance — x402 revenue-quality ratings",
      notice:
        "Identity minted by Provenance as a rating subject for this x402 endpoint. " +
        "The endpoint operator did not create it and does not control it. " +
        "Operators can claim the ERC-721 (free transfer) by proving control of the payTo address.",
      payTo: row.payTo,
      payToChain: payToChain(row.payTo),
    },
  };
}

export const registrationAgentURI = (row: SnapshotRow): string => dataUri(buildRegistrationFile(row));

export interface PreparedFeedback {
  tag1: string;
  tag2: string;
  /** integer score, valueDecimals = 0 */
  value: bigint;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: `0x${string}`;
}

/**
 * Feedback entries for one merchant. Always one `provenance.wash-risk` entry
 * (0–100, higher = more wash-trading risk; tag2 = grade). When the merchant
 * has enough organic volume for a graded ORQ score we also emit the spec's
 * standard `starred` quality tag (0–100) so generic ERC-8004 consumers can
 * read us without knowing Provenance conventions.
 */
export function buildFeedbacks(row: SnapshotRow, snapshot: Snapshot): PreparedFeedback[] {
  const endpoint = row.resourceUrls[0] ?? "";
  const detail = {
    agentRegistry: `eip155:${BASE_CHAIN_ID}:${IDENTITY_REGISTRY}`,
    issuer: "Provenance — x402 revenue-quality ratings",
    methodology: "https://provenance.apeiron.trade/methodology",
    snapshotTakenAt: snapshot.takenAt,
    windowDays: snapshot.windowDays,
    payTo: row.payTo,
    resourceUrls: row.resourceUrls,
    grade: row.grade,
    orq: row.orq,
    ci: row.ciLow !== null && row.ciHigh !== null ? [row.ciLow, row.ciHigh] : null,
    washLevel: row.washLevel,
    washScore: row.washScore,
    topFlags: row.topFlags,
    drift: row.drift,
    evidence: {
      facilitatorVerify: row.facilitatorVerify,
      facilitatorSettle: row.facilitatorSettle,
      onChainPayments: row.onChainPayments,
      onChainPayers: row.onChainPayers,
      payerClusters: row.nClusters,
    },
  };
  const json = JSON.stringify(detail);
  const uri = "data:application/json;base64," + Buffer.from(json).toString("base64");
  const hash = keccak256(stringToHex(json));

  const out: PreparedFeedback[] = [
    {
      tag1: "provenance.wash-risk",
      tag2: row.grade,
      value: BigInt(Math.max(0, Math.min(100, Math.round(row.washScore)))),
      endpoint,
      feedbackURI: uri,
      feedbackHash: hash,
    },
  ];
  if (row.orq !== null && Number.isFinite(row.orq)) {
    out.push({
      tag1: "starred", // spec convention: generic 0–100 quality
      tag2: "provenance.orq",
      value: BigInt(Math.max(0, Math.min(100, Math.round(row.orq)))),
      endpoint,
      feedbackURI: uri,
      feedbackHash: hash,
    });
  }
  return out;
}
