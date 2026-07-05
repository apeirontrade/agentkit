import type { Grade, WashLevel } from "@agentkit/scoring";
import { fetchResources, distinctPayTos, type DiscoveryOptions } from "./discovery.js";
import { scoreLiveEndpoint, type AssembleOptions } from "./assemble.js";
import { labelAddresses } from "./nfd.js";

export interface SnapshotRow {
  payTo: string;
  nfdName?: string;
  resourceUrls: string[];
  description?: string;
  facilitatorVerify: number;
  facilitatorSettle: number;
  onChainPayments: number;
  onChainPayers: number;
  nClusters: number;
  grade: Grade;
  orq: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  washLevel: WashLevel;
  washScore: number;
  topFlags: string[];
  /**
   * Facilitator-vs-onchain drift: on-chain USDC payments minus the facilitator's
   * self-reported settleCount. Large positive = direct (unfacilitated) volume;
   * negative/zero-with-high-settle = the facilitator counter can't be corroborated
   * on-chain (a leaderboard-gaming tell). Null when settleCount is 0.
   */
  drift: number | null;
}

export interface Snapshot {
  takenAt: Date;
  windowDays: number;
  totalRoutes: number;
  rows: SnapshotRow[];
}

export interface SnapshotOptions extends AssembleOptions {
  discovery?: DiscoveryOptions;
  windowDays?: number;
  maxEndpoints?: number;
  label?: boolean; // NFD labeling (default true)
  now: Date; // explicit clock (Date.now is unavailable in some contexts)
  onProgress?: (msg: string) => void;
}

/**
 * Score every distinct payTo in the GoPlausible Algorand registry and assemble a
 * ranked snapshot with wash risk + facilitator drift. This is the leaderboard's
 * data layer and the drift monitor's per-run record.
 */
export async function snapshotRegistry(opts: SnapshotOptions): Promise<Snapshot> {
  const log = opts.onProgress ?? (() => {});
  const windowDays = opts.windowDays ?? 400;

  const resources = await fetchResources({ algorandOnly: true, limit: 200, ...opts.discovery });
  const byPayTo = distinctPayTos(resources);
  log(`${resources.length} routes across ${byPayTo.size} payTo addresses`);

  const merchants = [...byPayTo.entries()]
    .map(([payTo, rs]) => ({
      payTo,
      resourceUrls: rs.map((r) => r.resourceUrl),
      description: rs[0]?.description,
      facilitatorVerify: rs.reduce((a, r) => a + r.verifyCount, 0),
      facilitatorSettle: rs.reduce((a, r) => a + r.settleCount, 0),
    }))
    .sort((a, b) => b.facilitatorSettle - a.facilitatorSettle)
    .slice(0, opts.maxEndpoints ?? byPayTo.size);

  const rows: SnapshotRow[] = [];
  for (const m of merchants) {
    log(`scoring ${m.payTo.slice(0, 12)}…`);
    try {
      const { result, stats } = await scoreLiveEndpoint(m.payTo, {
        windowDays,
        maxEnrichedPayers: opts.maxEnrichedPayers ?? 100,
        concurrency: opts.concurrency,
        now: opts.now,
        scoreOptions: { bootstrapRounds: 150, seed: 1 },
      });
      rows.push({
        payTo: m.payTo,
        resourceUrls: m.resourceUrls,
        description: m.description,
        facilitatorVerify: m.facilitatorVerify,
        facilitatorSettle: m.facilitatorSettle,
        onChainPayments: stats.nPayments,
        onChainPayers: stats.nPayers,
        nClusters: result.nPayerClusters,
        grade: result.grade,
        orq: result.orq,
        ciLow: result.ciLow,
        ciHigh: result.ciHigh,
        washLevel: result.washRisk.level,
        washScore: result.washRisk.score,
        topFlags: result.washRisk.indicators.slice(0, 3).map((i) => i.detail),
        drift: m.facilitatorSettle > 0 ? stats.nPayments - m.facilitatorSettle : null,
      });
    } catch (e) {
      log(`  skip ${m.payTo.slice(0, 12)}: ${(e as Error).message}`);
    }
  }

  if (opts.label !== false) {
    log(`labeling ${rows.length} addresses via NFD…`);
    const labels = await labelAddresses(rows.map((r) => r.payTo));
    for (const r of rows) r.nfdName = labels.get(r.payTo);
  }

  // Rank: gradeable organic first (by ORQ desc), then ungraded by ascending wash score.
  const washOrder: Record<WashLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
  rows.sort((a, b) => {
    if (a.orq !== null && b.orq !== null) return b.orq - a.orq;
    if (a.orq !== null) return -1;
    if (b.orq !== null) return 1;
    return washOrder[a.washLevel] - washOrder[b.washLevel] || a.washScore - b.washScore;
  });

  return { takenAt: opts.now, windowDays, totalRoutes: resources.length, rows };
}
