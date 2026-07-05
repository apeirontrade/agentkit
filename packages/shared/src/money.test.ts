import { describe, it, expect } from "vitest";
import {
  parseUsdc,
  formatUsdc,
  addUsdc,
  subUsdc,
  cmpUsdc,
  exceeds,
  toUsdApprox,
} from "./money.js";

describe("parseUsdc / formatUsdc", () => {
  it("round-trips whole numbers", () => {
    expect(formatUsdc(parseUsdc("1"))).toBe("1");
    expect(formatUsdc(parseUsdc("150"))).toBe("150");
  });

  it("round-trips fractional values", () => {
    expect(formatUsdc(parseUsdc("1.5"))).toBe("1.5");
    expect(formatUsdc(parseUsdc("0.000001"))).toBe("0.000001"); // 1 base unit
    expect(formatUsdc(parseUsdc("0.20"))).toBe("0.2");
  });

  it("parses to correct base units (6 decimals)", () => {
    expect(parseUsdc("1")).toBe(1_000_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
    expect(parseUsdc("0.2")).toBe(200_000n);
  });

  it("handles negatives", () => {
    expect(parseUsdc("-1.5")).toBe(-1_500_000n);
    expect(formatUsdc(-1_500_000n)).toBe("-1.5");
  });

  it("rejects too many decimals", () => {
    expect(() => parseUsdc("0.0000001")).toThrow(/max 6 decimals/);
  });

  it("rejects garbage", () => {
    expect(() => parseUsdc("abc")).toThrow(/invalid/);
    expect(() => parseUsdc("1.2.3")).toThrow(/invalid/);
  });
});

describe("arithmetic (no float drift)", () => {
  it("adds without drift", () => {
    // 0.1 + 0.2 === 0.3 exactly (the classic float failure)
    expect(addUsdc("0.1", "0.2")).toBe("0.3");
  });

  it("sums many micropayments exactly", () => {
    let total = "0";
    for (let i = 0; i < 10_000; i++) total = addUsdc(total, "0.0002");
    expect(total).toBe("2"); // 10000 * 0.0002 = 2.0000
  });

  it("subtracts", () => {
    expect(subUsdc("49", "7.25")).toBe("41.75");
  });
});

describe("comparison / guards", () => {
  it("compares", () => {
    expect(cmpUsdc("1", "2")).toBe(-1);
    expect(cmpUsdc("2", "2")).toBe(0);
    expect(cmpUsdc("2.000001", "2")).toBe(1);
  });

  it("exceeds is strict", () => {
    expect(exceeds("7.01", "7")).toBe(true);
    expect(exceeds("7", "7")).toBe(false);
    expect(exceeds("6.99", "7")).toBe(false);
  });

  it("treasury guard scenario: block over-budget order", () => {
    const projectedCogs = "8.50";
    const maxCogs = "8.00";
    expect(exceeds(projectedCogs, maxCogs)).toBe(true); // order must abort
  });
});

describe("toUsdApprox (display only)", () => {
  it("pegs USDC to USD", () => {
    expect(toUsdApprox("1.5")).toBeCloseTo(1.5);
    expect(toUsdApprox("100", 0.9998)).toBeCloseTo(99.98);
  });
});
