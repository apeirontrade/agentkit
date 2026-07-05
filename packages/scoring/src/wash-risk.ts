import type {
  ScoringInput,
  WashRiskAssessment,
  WashIndicator,
  WashLevel,
} from "./types.js";
import { clusterPayers, reachablePayers } from "./graph.js";
import { coefficientOfVariation, median, shares, hhi } from "./stats.js";

const amt = (s: string) => Number(s);

/**
 * Wash-risk assessment — runs on raw facts and is meaningful at ANY size,
 * including endpoints far below the ORQ grading floor. Each indicator adds a
 * weighted contribution to a 0..100 risk score; the raw weights sum past 100 so
 * that several critical tells saturate to CRITICAL. This is the pre-Challenge
 * useful output: it flags "many payments, one fresh wallet" that grading hides.
 */
export function assessWashRisk(input: ScoringInput): WashRiskAssessment {
  const indicators: WashIndicator[] = [];
  const rev = new Map<string, number>();
  for (const p of input.payments) rev.set(p.payer, (rev.get(p.payer) ?? 0) + amt(p.amountUsdc));
  const payers = [...rev.keys()];
  const nPayers = payers.length;

  const authMap = new Map<string, string>();
  for (const [payer, meta] of Object.entries(input.walletMeta ?? {})) {
    if (meta.authAddr) authMap.set(payer, meta.authAddr);
  }
  const clusters = clusterPayers(payers, input.fundingEdges, authMap);
  const nClusters = new Set(clusters.values()).size;

  const add = (name: string, contribution: number, weight: number, detail: string) => {
    if (contribution > 0.05) indicators.push({ name, contribution, detail });
    return contribution * weight;
  };

  let raw = 0;

  // 1. Too few distinct payers — the dominant pre-Challenge tell. One payer is
  // definitionally not organic multi-party demand → weight it to saturate CRITICAL.
  const payerSev = nPayers <= 1 ? 1 : nPayers <= 2 ? 0.9 : nPayers <= 4 ? 0.65 : nPayers <= 9 ? 0.35 : 0;
  raw += add("few_payers", payerSev, 45, `${nPayers} distinct payer${nPayers === 1 ? "" : "s"} — self-testing, not organic demand`);

  // 2. Revenue concentration across clusters.
  if (nClusters > 0) {
    const revByCluster = new Map<string, number>();
    for (const [payer, r] of rev) {
      const root = clusters.get(payer)!;
      revByCluster.set(root, (revByCluster.get(root) ?? 0) + r);
    }
    const sh = shares([...revByCluster.values()]).sort((a, b) => b - a);
    const topShare = sh[0] ?? 0;
    const conc = Math.max(0, (hhi(sh) - 0.1) / 0.9);
    raw += add("concentration", conc, 20, `top cluster holds ${Math.round(topShare * 100)}% of revenue (HHI ${hhi(sh).toFixed(2)})`);
  }

  // 3. Self-dealing payout loops.
  if ((input.payoutEdges?.length ?? 0) > 0) {
    const reached = reachablePayers(input.payTo, new Set(payers), input.payoutEdges!);
    const total = [...rev.values()].reduce((a, b) => a + b, 0);
    let cyc = 0;
    for (const p of reached) cyc += rev.get(p) ?? 0;
    const cycleShare = total > 0 ? cyc / total : 0;
    raw += add("self_dealing", cycleShare, 25, `${Math.round(cycleShare * 100)}% of revenue returns to payers via payout loops`);
  }

  // 4. Freshly created payer wallets.
  const meta = input.walletMeta;
  if (meta) {
    const firstPay = new Map<string, number>();
    for (const p of input.payments) {
      const t = p.blockTime.getTime();
      const prev = firstPay.get(p.payer);
      if (prev === undefined || t < prev) firstPay.set(p.payer, t);
    }
    const ages: number[] = [];
    for (const [payer, fp] of firstPay) {
      const fs = meta[payer]?.firstSeen;
      if (fs) ages.push((fp - fs.getTime()) / (24 * 3600 * 1000));
    }
    if (ages.length > 0) {
      const medAge = median(ages);
      const sev = medAge < 1 ? 1 : medAge < 3 ? 0.7 : medAge < 7 ? 0.4 : medAge < 30 ? 0.15 : 0;
      raw += add("fresh_wallets", sev, 15, `median payer wallet age ${medAge.toFixed(1)}d`);
    }
  }

  // 5. Metronomic timing.
  if (input.payments.length >= 5) {
    const times = input.payments.map((p) => p.blockTime.getTime()).sort((a, b) => a - b);
    const deltas: number[] = [];
    for (let i = 1; i < times.length; i++) deltas.push((times[i]! - times[i - 1]!) / 1000);
    const cv = coefficientOfVariation(deltas);
    const counts = new Map<number, number>();
    for (const d of deltas) counts.set(Math.round(d), (counts.get(Math.round(d)) ?? 0) + 1);
    const identical = Math.max(...counts.values()) / deltas.length;
    const sev = Math.max(cv < 0.3 ? 1 - cv / 0.3 : 0, identical > 0.5 ? identical : 0);
    raw += add("metronomic", sev, 15, `timing CV ${cv.toFixed(2)}, ${Math.round(identical * 100)}% identical-interval gaps`);
  }

  // 6. Rekey Sybil — payers sharing a controlling auth-addr.
  if (authMap.size > 0) {
    const byAuth = new Map<string, number>();
    for (const a of authMap.values()) byAuth.set(a, (byAuth.get(a) ?? 0) + 1);
    const shared = [...byAuth.values()].filter((c) => c > 1).reduce((a, b) => a + b, 0);
    const frac = nPayers > 0 ? shared / nPayers : 0;
    raw += add("rekey_sybil", frac, 20, `${Math.round(frac * 100)}% of payers share a controlling auth-addr`);
  }

  // 7. Single-funder ring.
  if ((input.fundingEdges?.length ?? 0) > 0) {
    const byFunder = new Map<string, Set<string>>();
    const payerSet = new Set(payers);
    for (const e of input.fundingEdges!) {
      if (payerSet.has(e.to)) {
        const s = byFunder.get(e.from) ?? new Set();
        s.add(e.to);
        byFunder.set(e.from, s);
      }
    }
    const topFunder = Math.max(0, ...[...byFunder.values()].map((s) => s.size));
    const frac = nPayers > 0 ? topFunder / nPayers : 0;
    if (frac > 0.3)
      raw += add("single_funder", frac, 15, `${Math.round(frac * 100)}% of payers funded by one wallet`);
  }

  const score = Math.min(100, Math.round(raw));
  const level: WashLevel = score >= 70 ? "critical" : score >= 45 ? "high" : score >= 20 ? "medium" : "low";
  indicators.sort((a, b) => b.contribution - a.contribution);
  return { level, score, indicators, nPayers, nPayerClusters: nClusters };
}
