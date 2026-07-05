import { describe, it, expect } from "vitest";
import { toEventSelector } from "viem";
import {
  AUTHORIZATION_USED_EVENT,
  AUTHORIZATION_USED_TOPIC0,
  USDC,
} from "./constants.js";
import { parsePrices } from "./probe.js";
import { classifySettlement } from "./classify.js";

describe("constants", () => {
  it("AUTHORIZATION_USED_TOPIC0 matches the event signature hash", () => {
    // Self-verifying: the hardcoded topic0 must equal viem's computed selector.
    expect(toEventSelector(AUTHORIZATION_USED_EVENT)).toBe(AUTHORIZATION_USED_TOPIC0);
  });

  it("Base USDC is the canonical 6-decimal contract", () => {
    expect(USDC.base.address).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(USDC.base.decimals).toBe(6);
    expect(USDC.base.network).toBe("eip155:8453");
  });
});

describe("parsePrices", () => {
  it("decimalizes a Base 402 body (200000 atomic → 0.2 USDC)", () => {
    const rows = parsePrices({
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          payTo: "0xSeller",
          asset: USDC.base.address,
          maxAmountRequired: "200000",
          resource: "https://api.example.com/data",
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.maxAmountRequiredUsdc).toBe("0.2");
    expect(rows[0]!.payTo).toBe("0xSeller");
  });

  it("returns empty for a non-x402 body", () => {
    expect(parsePrices({ foo: "bar" })).toEqual([]);
  });
});

describe("classifySettlement", () => {
  it("flags an EIP-3009 gasless transfer as x402 even from an unknown submitter", () => {
    const c = classifySettlement({
      chain: "base",
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
    });
    expect(c.isX402).toBe(true);
    expect(c.kind).toBe("eip3009");
    expect(c.confidence).toBeGreaterThan(0.5);
  });

  it("tags a bare direct transfer as low-confidence non-x402", () => {
    const c = classifySettlement({ chain: "base", submitter: "0xrandom", logs: [] });
    expect(c.isX402).toBe(false);
    expect(c.kind).toBe("direct");
  });

  it("treats an Algorand atomic-group transfer as facilitator-shaped", () => {
    const c = classifySettlement({
      chain: "algorand",
      submitter: "ALGOADDR",
      isAtomicGroup: true,
    });
    expect(c.isX402).toBe(true);
    expect(c.kind).toBe("atomic_group");
  });
});
