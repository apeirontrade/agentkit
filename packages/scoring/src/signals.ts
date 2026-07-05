import type { ScoringInput, SubScore } from "./types.js";
import { clusterPayers, reachablePayers } from "./graph.js";
import {
  mean,
  median,
  coefficientOfVariation,
  hhi,
  shares,
  normalizedEntropy,
  benfordDeviation,
  clamp01,
  weekIndex,
} from "./stats.js";

const amt = (s: string) => Number(s);
const backed = (value: number, dataBacked: boolean): SubScore => ({
  value: clamp01(value),
  dataBacked,
});

/** Distinct payers and their total revenue. */
function payerRevenue(input: ScoringInput): Map<string, number> {
  const rev = new Map<string, number>();
  for (const p of input.payments) {
    rev.set(p.payer, (rev.get(p.payer) ?? 0) + amt(p.amountUsdc));
  }
  return rev;
}

/** payer → auth-addr map, for rekey-based clustering. */
function authAddrMap(input: ScoringInput): Map<string, string> {
  const m = new Map<string, string>();
  for (const [payer, meta] of Object.entries(input.walletMeta ?? {})) {
    if (meta.authAddr) m.set(payer, meta.authAddr);
  }
  return m;
}

/** Revenue grouped by cluster root. */
function clusterRevenue(input: ScoringInput): { revByCluster: number[]; nClusters: number } {
  const rev = payerRevenue(input);
  const payers = [...rev.keys()];
  const clusters = clusterPayers(payers, input.fundingEdges, authAddrMap(input));
  const byCluster = new Map<string, number>();
  for (const [payer, r] of rev) {
    const root = clusters.get(payer)!;
    byCluster.set(root, (byCluster.get(root) ?? 0) + r);
  }
  return { revByCluster: [...byCluster.values()], nClusters: byCluster.size };
}

/** 1. Funding-graph clustering — is revenue from independently-funded payers? */
export function fundingGraph(input: ScoringInput, flags: string[]): SubScore {
  const rev = payerRevenue(input);
  const payers = [...rev.keys()];
  const authMap = authAddrMap(input);
  const hasEdges = (input.fundingEdges?.length ?? 0) > 0 || authMap.size > 0;
  const clusters = clusterPayers(payers, input.fundingEdges, authMap);
  const distinctRoots = new Set(clusters.values()).size;
  const sharedFundingRatio = payers.length > 0 ? 1 - distinctRoots / payers.length : 0;

  // Hard flag: any payer funded (directly) by the endpoint's own deployer.
  let deployerLinked = false;
  if (input.deployer) {
    for (const e of input.fundingEdges ?? []) {
      if (e.from === input.deployer && rev.has(e.to)) deployerLinked = true;
    }
    if (rev.has(input.deployer)) deployerLinked = true; // deployer paying itself
  }
  if (deployerLinked) {
    flags.push("payers funded by the endpoint's own deployer wallet (self-dealing lineage)");
    return backed(0.03, hasEdges);
  }
  if (sharedFundingRatio > 0.5) {
    flags.push(
      `${Math.round(sharedFundingRatio * 100)}% of payers collapse into shared funding clusters`,
    );
  }
  return backed(1 - sharedFundingRatio, hasEdges);
}

/** 2. Self-dealing cycle detection — does payout money return to payers? */
export function selfDealing(input: ScoringInput, flags: string[]): SubScore {
  const edges = input.payoutEdges ?? [];
  if (edges.length === 0) return backed(0.6, false); // unknown: mild benefit of the doubt
  const rev = payerRevenue(input);
  const total = [...rev.values()].reduce((a, b) => a + b, 0);
  const reached = reachablePayers(input.payTo, new Set(rev.keys()), edges);
  let cycleRev = 0;
  for (const p of reached) cycleRev += rev.get(p) ?? 0;
  const cycleShare = total > 0 ? cycleRev / total : 0;
  if (cycleShare > 0.2) {
    flags.push(
      `${Math.round(cycleShare * 100)}% of revenue returns to payers via payout loops`,
    );
  }
  return backed(1 - cycleShare, true);
}

/** 3. Payer retention — organic decays; wash is robotic (always-on) or one-shot. */
export function retention(input: ScoringInput, flags: string[]): SubScore {
  const weeksByPayer = new Map<string, Set<number>>();
  const allWeeks = new Set<number>();
  for (const p of input.payments) {
    const w = weekIndex(p.blockTime);
    allWeeks.add(w);
    const set = weeksByPayer.get(p.payer) ?? new Set<number>();
    set.add(w);
    weeksByPayer.set(p.payer, set);
  }
  const totalWeeks = allWeeks.size;
  if (totalWeeks < 3) return backed(0.5, false); // not enough history to judge a curve

  const payers = [...weeksByPayer.values()];
  const activeWeeks = payers.map((s) => s.size);
  // Robotic: a large share of payers active in nearly every week.
  const alwaysOn = activeWeeks.filter((a) => a >= 0.9 * totalWeeks).length / payers.length;
  // One-shot army: almost nobody returns for a 2nd week.
  const repeatRate = activeWeeks.filter((a) => a > 1).length / payers.length;

  let value = 1;
  if (alwaysOn > 0.5) {
    flags.push(`${Math.round(alwaysOn * 100)}% of payers active in ~every week (robotic retention)`);
    value = Math.min(value, 1 - alwaysOn);
  }
  if (repeatRate < 0.02) {
    flags.push("almost no payer returns after their first week (one-shot army)");
    value = Math.min(value, 0.4);
  }
  return backed(value, true);
}

/** 4. Temporal autocorrelation — metronomic inter-arrivals signal a scheduler/bot. */
export function temporal(input: ScoringInput, flags: string[]): SubScore {
  if (input.payments.length < 5) return backed(0.5, false);
  const times = input.payments.map((p) => p.blockTime.getTime()).sort((a, b) => a - b);
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i++) deltas.push((times[i]! - times[i - 1]!) / 1000);
  const cv = coefficientOfVariation(deltas);
  // Identical-interval fraction (rounded to the second) — a hard metronome tell.
  const counts = new Map<number, number>();
  for (const d of deltas) counts.set(Math.round(d), (counts.get(Math.round(d)) ?? 0) + 1);
  const modal = Math.max(...counts.values());
  const identicalShare = modal / deltas.length;
  if (cv < 0.3) flags.push(`near-metronomic timing (CV=${cv.toFixed(2)})`);
  if (identicalShare > 0.5)
    flags.push(`${Math.round(identicalShare * 100)}% of gaps are an identical interval`);
  // Organic inter-arrivals are bursty (CV≳1). Penalize low CV and high identical share.
  const value = Math.min(clamp01(cv), 1 - Math.max(0, identicalShare - 0.3));
  return backed(value, true);
}

/** 5. Wallet-age & activity diversity of payers. */
export function walletFingerprint(input: ScoringInput, flags: string[]): SubScore {
  const meta = input.walletMeta;
  if (!meta) return backed(0.5, false);
  const firstPaymentByPayer = new Map<string, number>();
  for (const p of input.payments) {
    const t = p.blockTime.getTime();
    const prev = firstPaymentByPayer.get(p.payer);
    if (prev === undefined || t < prev) firstPaymentByPayer.set(p.payer, t);
  }
  const ages: number[] = [];
  const tokens: number[] = [];
  const counterparties: number[] = [];
  for (const [payer, firstPay] of firstPaymentByPayer) {
    const m = meta[payer];
    if (!m) continue;
    if (m.firstSeen) ages.push((firstPay - m.firstSeen.getTime()) / (24 * 3600 * 1000));
    if (m.distinctTokens !== undefined) tokens.push(m.distinctTokens);
    if (m.distinctCounterparties !== undefined) counterparties.push(m.distinctCounterparties);
  }
  if (ages.length === 0 && tokens.length === 0) return backed(0.5, false);
  // Older wallets score higher (30d ~ full credit); more diversity scores higher.
  const ageScore = ages.length ? clamp01(median(ages) / 30) : 0.5;
  const tokenScore = tokens.length ? clamp01(median(tokens) / 4) : 0.5;
  const cpScore = counterparties.length ? clamp01(median(counterparties) / 8) : 0.5;
  if (ages.length && median(ages) < 3)
    flags.push(`payer wallets are freshly created (median age ${median(ages).toFixed(1)}d)`);
  return backed(mean([ageScore, tokenScore, cpScore]), true);
}

/** 6. Amount-distribution tests (Benford + entropy + identical-amount share). */
export function amountDistribution(input: ScoringInput): SubScore {
  const amounts = input.payments.map((p) => amt(p.amountUsdc));
  const distinct = new Set(amounts).size;
  // A fixed-price endpoint legitimately has one amount — don't punish that alone.
  if (distinct <= 2) return backed(0.6, false);
  const benDev = benfordDeviation(amounts);
  const counts = new Map<number, number>();
  for (const a of amounts) counts.set(a, (counts.get(a) ?? 0) + 1);
  const entropy = normalizedEntropy([...counts.values()]);
  // Good = low Benford deviation + healthy entropy.
  const value = mean([1 - benDev, entropy]);
  return backed(value, true);
}

/** 7. Payer concentration — HHI over clusters; top-heavy revenue caps the score. */
export function concentration(input: ScoringInput, flags: string[]): SubScore {
  const { revByCluster } = clusterRevenue(input);
  if (revByCluster.length === 0) return backed(0.5, false);
  const sh = shares(revByCluster).sort((a, b) => b - a);
  const h = hhi(sh);
  const top3 = sh.slice(0, 3).reduce((a, b) => a + b, 0);
  if (top3 >= 0.8) {
    flags.push(`top 3 payer clusters account for ${Math.round(top3 * 100)}% of revenue`);
    return backed(Math.min(1 - h, 0.25), true);
  }
  return backed(1 - h, true);
}

/** 8. Cross-endpoint rings — payers rotating only among the deployer's own endpoints. */
export function crossEndpoint(input: ScoringInput): SubScore {
  const cross = input.crossEndpoint;
  const siblings = new Set(input.siblingEndpoints ?? []);
  if (!cross || siblings.size === 0) return backed(0.7, false);
  const payers = Object.keys(cross);
  if (payers.length === 0) return backed(0.7, false);
  let ringPayers = 0;
  for (const p of payers) {
    const others = cross[p] ?? [];
    if (others.length > 0 && others.every((e) => siblings.has(e))) ringPayers++;
  }
  const ringFraction = ringPayers / payers.length;
  return backed(1 - ringFraction, true);
}

export const SIGNAL_WEIGHTS: Record<string, number> = {
  fundingGraph: 0.2,
  selfDealing: 0.2,
  retention: 0.15,
  temporal: 0.15,
  walletFingerprint: 0.1,
  amountDistribution: 0.08,
  concentration: 0.07,
  crossEndpoint: 0.05,
};

export function runSignals(
  input: ScoringInput,
  flags: string[],
): Record<string, SubScore> {
  return {
    fundingGraph: fundingGraph(input, flags),
    selfDealing: selfDealing(input, flags),
    retention: retention(input, flags),
    temporal: temporal(input, flags),
    walletFingerprint: walletFingerprint(input, flags),
    amountDistribution: amountDistribution(input),
    concentration: concentration(input, flags),
    crossEndpoint: crossEndpoint(input),
  };
}

export { payerRevenue, clusterRevenue };
