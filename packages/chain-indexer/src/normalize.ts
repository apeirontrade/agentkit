import { formatUnits } from "viem";
import { classifySettlement, USDC } from "@agentkit/x402-core";
import type { Payment } from "./types.js";

/** A decoded USDC ERC-20 Transfer plus the tx context we need to classify it. */
export interface BaseTransfer {
  from: string;
  to: string;
  value: bigint; // atomic, 6-dp
  txHash: string;
  blockNumber: number;
  blockTime: Date;
  /** tx sender (tx.from) — the settlement submitter for facilitator matching. */
  submitter: string;
  /** all logs in the tx, for EIP-3009 AuthorizationUsed detection. */
  logs?: Array<{ topics: `0x${string}`[]; data: `0x${string}` }>;
  confirmationDepth: number;
}

export function normalizeBase(t: BaseTransfer): Payment {
  const cls = classifySettlement({
    chain: "base",
    submitter: t.submitter,
    logs: t.logs,
  });
  return {
    chain: "base",
    txHash: t.txHash,
    blockTime: t.blockTime,
    payer: t.from,
    payTo: t.to,
    amountUsdc: formatUnits(t.value, USDC.base.decimals),
    facilitator: cls.facilitator,
    settlementKind: cls.kind,
    confirmationDepth: t.confirmationDepth,
    raw: { blockNumber: t.blockNumber },
  };
}

/** A single transaction as returned by the Algorand (Nodely) indexer. */
export interface AlgoIndexerTxn {
  id: string;
  sender: string;
  "round-time": number; // unix seconds
  group?: string;
  "asset-transfer-transaction"?: {
    amount: number;
    receiver: string;
    "asset-id": number;
  };
}

export function normalizeAlgorand(txn: AlgoIndexerTxn): Payment | null {
  const axfer = txn["asset-transfer-transaction"];
  if (!axfer) return null;
  if (String(axfer["asset-id"]) !== USDC.algorand.address) return null;

  const cls = classifySettlement({
    chain: "algorand",
    submitter: txn.sender,
    isAtomicGroup: Boolean(txn.group),
  });
  return {
    chain: "algorand",
    txHash: txn.id,
    blockTime: new Date(txn["round-time"] * 1000),
    payer: txn.sender,
    payTo: axfer.receiver,
    amountUsdc: formatUnits(BigInt(axfer.amount), USDC.algorand.decimals),
    facilitator: cls.facilitator,
    settlementKind: cls.kind,
    confirmationDepth: 1, // Algorand finality is instant
    raw: { group: txn.group },
  };
}
