import {
  type ScoringInput,
  type ScoreResult,
  type Grade,
  type SubScore,
  METHODOLOGY_VERSION,
  MIN_PAYMENTS,
  MIN_PAYER_CLUSTERS,
} from "./types.js";
import { runSignals, SIGNAL_WEIGHTS, clusterRevenue } from "./signals.js";
import { assessWashRisk } from "./wash-risk.js";
import { percentile } from "./stats.js";

const EPS = 0.02; // floor for ln() so one zero signal caps, not annihilates, the score

/** Weighted geometric mean of subscores → 0..100. */
export function composeOrq(subscores: Record<string, SubScore>): number {
  let acc = 0;
  let wsum = 0;
  for (const [name, weight] of Object.entries(SIGNAL_WEIGHTS)) {
    const s = subscores[name];
    if (!s) continue;
    const v = Math.max(EPS, Math.min(1, s.value));
    acc += weight * Math.log(v);
    wsum += weight;
  }
  if (wsum === 0) return 0;
  return Math.exp(acc / wsum) * 100;
}

export function gradeOf(orq: number): Grade {
  if (orq >= 85) return "A";
  if (orq >= 70) return "B";
  if (orq >= 50) return "C";
  if (orq >= 30) return "D";
  return "F";
}

/** Deterministic PRNG (mulberry32) so bootstrap CIs are reproducible. */
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

export interface ScoreOptions {
  bootstrapRounds?: number; // default 200; lower for speed
  seed?: number;
}

export function scoreEndpoint(input: ScoringInput, opts: ScoreOptions = {}): ScoreResult {
  const flags: string[] = [];
  const subscores = runSignals(input, flags);
  const { nClusters } = clusterRevenue(input);
  const nPayments = input.payments.length;

  const base: Omit<ScoreResult, "grade" | "orq" | "ciLow" | "ciHigh"> = {
    endpointId: input.endpointId,
    subscores,
    washRisk: assessWashRisk(input), // always available, even below the grading floor
    nPayments,
    nPayerClusters: nClusters,
    methodologyVersion: METHODOLOGY_VERSION,
    flags,
  };

  if (nPayments < MIN_PAYMENTS || nClusters < MIN_PAYER_CLUSTERS) {
    flags.push(
      `insufficient data: ${nPayments} payments / ${nClusters} payer clusters ` +
        `(need ≥${MIN_PAYMENTS} and ≥${MIN_PAYER_CLUSTERS})`,
    );
    return { ...base, grade: "INSUFFICIENT_DATA", orq: null, ciLow: null, ciHigh: null };
  }

  const orq = composeOrq(subscores);

  // Bootstrap CI: resample at the PAYER level (payers are the independent unit),
  // pulling each drawn payer's full payment sequence. Resampling individual
  // payments would destroy per-payer temporal/amount structure and bias the
  // timing signals — so we resample payers and keep their sequences intact.
  const byPayer = new Map<string, typeof input.payments>();
  for (const p of input.payments) {
    const list = byPayer.get(p.payer) ?? [];
    list.push(p);
    byPayer.set(p.payer, list);
  }
  const payerList = [...byPayer.keys()];
  const rounds = opts.bootstrapRounds ?? 200;
  const rng = mulberry32(opts.seed ?? 0x9e3779b9);
  const samples: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const resampled: typeof input.payments = [];
    for (let k = 0; k < payerList.length; k++) {
      const payer = payerList[Math.floor(rng() * payerList.length)]!;
      resampled.push(...byPayer.get(payer)!);
    }
    const s = runSignals({ ...input, payments: resampled }, []);
    samples.push(composeOrq(s));
  }
  // The observed score can sit at an edge of the resample distribution (e.g. a
  // perfectly metronomic wash endpoint that any perturbation softens). Widen the
  // interval to always contain the observation — an honest CI includes what we saw.
  const ciLow = Math.min(percentile(samples, 5), orq);
  const ciHigh = Math.max(percentile(samples, 95), orq);

  return { ...base, grade: gradeOf(orq), orq: round1(orq), ciLow: round1(ciLow), ciHigh: round1(ciHigh) };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
