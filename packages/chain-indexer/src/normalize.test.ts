import { describe, it, expect } from "vitest";
import { AUTHORIZATION_USED_TOPIC0 } from "@agentkit/x402-core";
import { normalizeBase, normalizeAlgorand } from "./normalize.js";
import { isConfirmed, depthFor } from "./reorg.js";
import type { Payment } from "./types.js";

describe("normalizeBase", () => {
  it("maps a plain USDC Transfer to a 0.2 USDC direct payment", () => {
    const p = normalizeBase({
      from: "0xPayer",
      to: "0xSeller",
      value: 200_000n, // 0.2 USDC (6 dp)
      txHash: "0xdeadbeef",
      blockNumber: 100,
      blockTime: new Date("2026-07-04T00:00:00Z"),
      submitter: "0xPayer",
      logs: [],
      confirmationDepth: 10,
    });
    expect(p.amountUsdc).toBe("0.2");
    expect(p.payer).toBe("0xPayer");
    expect(p.payTo).toBe("0xSeller");
    expect(p.settlementKind).toBe("direct");
    expect(p.chain).toBe("base");
  });

  it("classifies an EIP-3009 gasless transfer as an x402 settlement", () => {
    const p = normalizeBase({
      from: "0xPayer",
      to: "0xSeller",
      value: 10_000n, // 0.01 USDC
      txHash: "0xfeed",
      blockNumber: 200,
      blockTime: new Date("2026-07-04T01:00:00Z"),
      submitter: "0xUnknownFacilitator",
      logs: [
        {
          topics: [
            AUTHORIZATION_USED_TOPIC0 as `0x${string}`,
            "0x0000000000000000000000001111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222222222222222222222222222",
          ],
          data: "0x",
        },
      ],
      confirmationDepth: 6,
    });
    expect(p.settlementKind).toBe("eip3009");
    expect(p.amountUsdc).toBe("0.01");
  });
});

describe("normalizeAlgorand", () => {
  it("maps a USDC ASA transfer (atomic units → decimal) with group→atomic_group", () => {
    const p = normalizeAlgorand({
      id: "TXID123",
      sender: "PAYERADDR",
      "round-time": 1_780_000_000,
      group: "Z29ncm91cA==",
      "asset-transfer-transaction": {
        amount: 500_000, // 0.5 USDC
        receiver: "SELLERADDR",
        "asset-id": 31566704,
      },
    });
    expect(p).not.toBeNull();
    expect(p!.amountUsdc).toBe("0.5");
    expect(p!.payTo).toBe("SELLERADDR");
    expect(p!.settlementKind).toBe("atomic_group");
    expect(p!.confirmationDepth).toBe(1);
  });

  it("ignores non-USDC ASA transfers", () => {
    const p = normalizeAlgorand({
      id: "TX",
      sender: "A",
      "round-time": 1,
      "asset-transfer-transaction": { amount: 1, receiver: "B", "asset-id": 999 },
    });
    expect(p).toBeNull();
  });

  it("ignores non-asset-transfer transactions", () => {
    expect(normalizeAlgorand({ id: "TX", sender: "A", "round-time": 1 })).toBeNull();
  });
});

describe("reorg gating", () => {
  const base = (depth: number): Payment => ({
    chain: "base",
    txHash: "0x",
    blockTime: new Date(),
    payer: "a",
    payTo: "b",
    amountUsdc: "1",
    settlementKind: "direct",
    confirmationDepth: depth,
  });

  it("requires 5 confirmations on Base", () => {
    expect(isConfirmed(base(4))).toBe(false);
    expect(isConfirmed(base(5))).toBe(true);
  });

  it("depthFor never goes negative on a reorg", () => {
    expect(depthFor("base", 105, 100)).toBe(0);
    expect(depthFor("base", 90, 100)).toBe(10);
  });
});
