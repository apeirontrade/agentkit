import { describe, it, expect } from "vitest";
import { scoreEndpoint } from "./compose.js";
import { UnionFind, clusterPayers } from "./graph.js";
import { benfordDeviation, coefficientOfVariation } from "./stats.js";
import type { ScoringInput, PaymentRecord, FlowEdge, WalletMeta } from "./types.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START = new Date("2026-05-01T00:00:00Z").getTime();
const DAY = 24 * 3600 * 1000;

/** An organic endpoint: many independent, aged, diverse payers; natural timing. */
function organicInput(): ScoringInput {
  const rng = mulberry32(42);
  const nPayers = 60;
  const payers = Array.from({ length: nPayers }, (_, i) => `ORGPAYER${i}`);
  const walletMeta: Record<string, WalletMeta> = {};
  for (const p of payers) {
    walletMeta[p] = {
      firstSeen: new Date(START - (30 + rng() * 400) * DAY), // aged 30–430 days
      distinctTokens: 3 + Math.floor(rng() * 12),
      distinctCounterparties: 5 + Math.floor(rng() * 25),
    };
  }
  const amounts = [0.05, 0.1, 0.25, 0.4, 0.75, 1.2, 2.5, 3.33, 4.9];
  const payments: PaymentRecord[] = [];
  for (let i = 0; i < 130; i++) {
    const payer = payers[Math.floor(rng() * nPayers)]!;
    const t = START + rng() * 42 * DAY; // scattered over 6 weeks
    payments.push({
      payer,
      amountUsdc: String(amounts[Math.floor(rng() * amounts.length)]),
      blockTime: new Date(t),
      txHash: `0xorg${i}`,
    });
  }
  return {
    endpointId: "organic",
    payTo: "ORGSELLER",
    windowStart: new Date(START),
    windowEnd: new Date(START + 42 * DAY),
    payments,
    walletMeta,
    // no funding edges (independent payers), no payout cycles
  };
}

/** A wash endpoint: metronomic timing, near-identical amounts, robotic weekly
 *  retention, funded rings, and payout money that cycles back to payers. */
function washInput(): ScoringInput {
  const nPayers = 30;
  const payers = Array.from({ length: nPayers }, (_, i) => `WASHPAYER${i}`);
  const funders = Array.from({ length: 15 }, (_, i) => `FUNDER${i}`);
  const walletMeta: Record<string, WalletMeta> = {};
  const fundingEdges: FlowEdge[] = [];
  const payoutEdges: FlowEdge[] = [];
  for (let i = 0; i < nPayers; i++) {
    const p = payers[i]!;
    const funder = funders[Math.floor(i / 2)]!; // 2 payers per funder → 15 clusters
    walletMeta[p] = {
      firstSeen: new Date(START - 0.2 * DAY), // freshly created
      firstFunder: funder,
      distinctTokens: 1,
      distinctCounterparties: 1,
    };
    fundingEdges.push({ from: funder, to: p });
    payoutEdges.push({ from: funder, to: p }); // funder → payer
  }
  for (const f of funders) payoutEdges.push({ from: "WASHSELLER", to: f }); // payTo → funder → payer (cycle)

  const payments: PaymentRecord[] = [];
  const interval = (28 * DAY) / 120; // identical metronomic gap
  for (let i = 0; i < 120; i++) {
    payments.push({
      payer: payers[i % nPayers]!, // each payer pays every "week" → robotic retention
      amountUsdc: i % 10 === 0 ? String(0.02 + (i % 5) * 0.01) : "0.01", // ~90% identical
      blockTime: new Date(START + i * interval),
      txHash: `0xwash${i}`,
      group: "WASHGROUP",
    });
  }
  return {
    endpointId: "wash",
    payTo: "WASHSELLER",
    windowStart: new Date(START),
    windowEnd: new Date(START + 28 * DAY),
    payments,
    walletMeta,
    fundingEdges,
    payoutEdges,
  };
}

describe("graph utilities", () => {
  it("union-find groups transitively", () => {
    const uf = new UnionFind();
    uf.union("a", "b");
    uf.union("b", "c");
    expect(uf.find("a")).toBe(uf.find("c"));
    expect(uf.find("a")).not.toBe(uf.find("z"));
  });

  it("clusterPayers merges payers sharing a funder", () => {
    const clusters = clusterPayers(
      ["p1", "p2", "p3"],
      [
        { from: "F", to: "p1" },
        { from: "F", to: "p2" },
      ],
    );
    expect(clusters.get("p1")).toBe(clusters.get("p2"));
    expect(clusters.get("p1")).not.toBe(clusters.get("p3"));
  });
});

describe("ORQ scoring — organic vs wash", () => {
  const organic = scoreEndpoint(organicInput(), { bootstrapRounds: 100, seed: 1 });
  const wash = scoreEndpoint(washInput(), { bootstrapRounds: 100, seed: 1 });

  it("grades an organic endpoint highly", () => {
    expect(organic.grade).not.toBe("INSUFFICIENT_DATA");
    expect(organic.orq).not.toBeNull();
    expect(organic.orq!).toBeGreaterThan(55);
    expect(["A", "B", "C"]).toContain(organic.grade);
  });

  it("grades a wash endpoint poorly", () => {
    expect(wash.grade).not.toBe("INSUFFICIENT_DATA"); // 15 clusters clears the floor
    expect(wash.orq!).toBeLessThan(35);
    expect(["D", "F"]).toContain(wash.grade);
  });

  it("separates them by a wide margin", () => {
    expect(organic.orq! - wash.orq!).toBeGreaterThan(30);
  });

  it("surfaces human-readable wash evidence", () => {
    const joined = wash.flags.join(" | ");
    expect(joined).toMatch(/metronomic|identical interval/);
    expect(joined).toMatch(/payout loops|self-dealing|fresh|robotic/);
  });

  it("reports a bootstrap confidence interval bracketing the score (both)", () => {
    for (const r of [organic, wash]) {
      expect(r.ciLow!).toBeLessThanOrEqual(r.orq!);
      expect(r.ciHigh!).toBeGreaterThanOrEqual(r.orq!);
    }
  });

  it("applies the data floor", () => {
    const tiny = scoreEndpoint({
      ...organicInput(),
      payments: organicInput().payments.slice(0, 10),
    });
    expect(tiny.grade).toBe("INSUFFICIENT_DATA");
    expect(tiny.orq).toBeNull();
  });

  it("computes wash risk even below the grading floor", () => {
    // A tiny single-payer endpoint: no grade, but wash risk must fire.
    const p0 = organicInput().payments[0]!;
    const singlePayer = scoreEndpoint({
      ...organicInput(),
      payments: Array.from({ length: 8 }, (_, i) => ({ ...p0, txHash: `x${i}` })),
    });
    expect(singlePayer.grade).toBe("INSUFFICIENT_DATA");
    expect(singlePayer.washRisk.level).toBe("critical");
    expect(singlePayer.washRisk.nPayers).toBe(1);
    expect(singlePayer.washRisk.indicators.some((i) => i.name === "few_payers")).toBe(true);
  });

  it("rates organic low-risk and wash high-risk", () => {
    expect(["low", "medium"]).toContain(organic.washRisk.level);
    expect(["high", "critical"]).toContain(wash.washRisk.level);
    expect(wash.washRisk.score).toBeGreaterThan(organic.washRisk.score + 25);
  });
});

describe("stats sanity", () => {
  it("Benford deviation is low for a Benford-ish set, high for uniform", () => {
    const benfordish = [1, 1, 1, 2, 2, 3, 10, 11, 20, 100, 150, 4, 5];
    const uniform = Array(50).fill(9);
    expect(benfordDeviation(benfordish)).toBeLessThan(benfordDeviation(uniform));
  });

  it("CV is ~0 for metronomic, higher for bursty", () => {
    expect(coefficientOfVariation([10, 10, 10, 10])).toBeCloseTo(0);
    expect(coefficientOfVariation([1, 20, 2, 40, 3])).toBeGreaterThan(0.5);
  });
});
