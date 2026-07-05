import {
  AlgorandIndexer,
  AlgorandForensics,
  type AlgorandIndexerConfig,
} from "@agentkit/chain-indexer";
import {
  scoreEndpoint,
  type ScoringInput,
  type ScoreResult,
  type PaymentRecord,
  type WalletMeta,
  type FlowEdge,
  type ScoreOptions,
} from "@agentkit/scoring";
import { mapPool } from "./pool.js";

export interface AssembleOptions {
  endpointId?: string;
  deployer?: string;
  windowDays?: number; // default 90
  /** Cap payers enriched with per-wallet forensics (indexer-call budget). */
  maxEnrichedPayers?: number; // default 200
  concurrency?: number; // default 4
  indexer?: AlgorandIndexerConfig;
  now?: Date; // injectable clock for determinism
  onProgress?: (msg: string) => void;
}

export interface AssembleResult {
  input: ScoringInput;
  stats: {
    nPayments: number;
    nPayers: number;
    nEnriched: number;
    truncated: boolean;
    windowStart: Date;
    windowEnd: Date;
  };
}

/**
 * Assemble a live Algorand x402 endpoint into a ScoringInput:
 *  1. backfill USDC payments to payTo over the window
 *  2. enrich the top-N payers with wallet forensics (age, funder, diversity)
 *  3. build funding edges (firstFunder → payer) for clustering
 *  4. pull payTo outbound USDC flow as payout edges (self-dealing detection)
 *
 * Read-only; makes real indexer calls. Costs ~2 calls per enriched payer plus
 * a paged outbound scan, so maxEnrichedPayers bounds the request budget.
 */
export async function assembleInput(
  payTo: string,
  opts: AssembleOptions = {},
): Promise<AssembleResult> {
  const log = opts.onProgress ?? (() => {});
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 90;
  const windowStart = new Date(now.getTime() - windowDays * 24 * 3600 * 1000);
  const windowEnd = now;

  const indexer = new AlgorandIndexer(opts.indexer);
  const forensics = new AlgorandForensics(opts.indexer);

  log(`backfilling payments to ${payTo} (${windowDays}d)…`);
  const payments: PaymentRecord[] = [];
  for await (const p of indexer.backfill([payTo], windowStart, windowEnd)) {
    payments.push({
      payer: p.payer,
      amountUsdc: p.amountUsdc,
      blockTime: p.blockTime,
      txHash: p.txHash,
      group: (p.raw as { group?: string } | undefined)?.group,
    });
  }
  log(`${payments.length} payments from ${new Set(payments.map((p) => p.payer)).size} payers`);

  // Rank payers by payment count; enrich the busiest up to the cap.
  const countByPayer = new Map<string, number>();
  for (const p of payments) countByPayer.set(p.payer, (countByPayer.get(p.payer) ?? 0) + 1);
  const rankedPayers = [...countByPayer.keys()].sort(
    (a, b) => (countByPayer.get(b) ?? 0) - (countByPayer.get(a) ?? 0),
  );
  const cap = opts.maxEnrichedPayers ?? 200;
  const toEnrich = rankedPayers.slice(0, cap);
  const truncated = rankedPayers.length > cap;

  log(`enriching ${toEnrich.length} payers with wallet forensics…`);
  const walletMeta: Record<string, WalletMeta> = {};
  const fundingEdges: FlowEdge[] = [];
  await mapPool(toEnrich, opts.concurrency ?? 4, async (payer) => {
    try {
      const meta = await forensics.accountMeta(payer);
      walletMeta[payer] = {
        firstSeen: meta.firstSeen,
        firstFunder: meta.firstFunder,
        distinctTokens: meta.distinctTokens,
      };
      if (meta.firstFunder) fundingEdges.push({ from: meta.firstFunder, to: payer });
    } catch {
      // a wallet we can't enrich is left without meta; signals degrade gracefully
    }
  });

  log(`scanning ${payTo} outbound flow for payout edges…`);
  let payoutEdges: FlowEdge[] = [];
  try {
    payoutEdges = await forensics.outboundEdges(payTo, windowStart, windowEnd);
  } catch {
    // outbound scan optional; self-dealing signal degrades if absent
  }

  const input: ScoringInput = {
    endpointId: opts.endpointId ?? payTo,
    payTo,
    deployer: opts.deployer,
    windowStart,
    windowEnd,
    payments,
    walletMeta,
    fundingEdges,
    payoutEdges,
  };

  return {
    input,
    stats: {
      nPayments: payments.length,
      nPayers: rankedPayers.length,
      nEnriched: toEnrich.length,
      truncated,
      windowStart,
      windowEnd,
    },
  };
}

/** Assemble + score a live Algorand x402 endpoint in one call. */
export async function scoreLiveEndpoint(
  payTo: string,
  opts: AssembleOptions & { scoreOptions?: ScoreOptions } = {},
): Promise<{ result: ScoreResult; stats: AssembleResult["stats"] }> {
  const { input, stats } = await assembleInput(payTo, opts);
  const result = scoreEndpoint(input, opts.scoreOptions);
  return { result, stats };
}
