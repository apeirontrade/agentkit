/**
 * Pull the live GoPlausible x402 registry (the Algorand Challenge's raw feed)
 * and score each real endpoint's on-chain revenue quality. Diffs the
 * facilitator's settleCount against actual USDC volume we observe.
 *
 *   pnpm provenance:registry [windowDays] [maxEndpoints]
 */
import { fetchResources, distinctPayTos, scoreLiveEndpoint } from "@agentkit/provenance";

async function main() {
  const windowDays = Number(process.argv[2] ?? 400);
  const maxEndpoints = Number(process.argv[3] ?? 8);

  console.log("Fetching GoPlausible Algorand x402 registry…");
  const resources = await fetchResources({ algorandOnly: true, limit: 200 });
  const byPayTo = distinctPayTos(resources);
  console.log(`${resources.length} Algorand routes across ${byPayTo.size} distinct payTo addresses.\n`);

  // Rank merchants by facilitator settleCount (the leaderboard's own metric).
  const merchants = [...byPayTo.entries()]
    .map(([payTo, rs]) => ({
      payTo,
      settleCount: rs.reduce((a, r) => a + r.settleCount, 0),
      verifyCount: rs.reduce((a, r) => a + r.verifyCount, 0),
      urls: rs.map((r) => r.resourceUrl),
    }))
    .sort((a, b) => b.settleCount - a.settleCount)
    .slice(0, maxEndpoints);

  for (const m of merchants) {
    process.stdout.write(`\n▸ ${m.payTo.slice(0, 14)}…  facilitator: verify=${m.verifyCount} settle=${m.settleCount}\n  ${m.urls[0]}\n`);
    try {
      const { result, stats } = await scoreLiveEndpoint(m.payTo, {
        windowDays,
        maxEnrichedPayers: 100,
        scoreOptions: { bootstrapRounds: 150, seed: 1 },
      });
      const onChain = stats.nPayments;
      const drift = m.settleCount > 0 ? ` (facilitator claims ${m.settleCount}, on-chain ${onChain})` : "";
      console.log(
        `  → grade ${result.grade}  ORQ ${result.orq ?? "—"}` +
          (result.orq !== null ? ` (CI ${result.ciLow}–${result.ciHigh})` : "") +
          `  ${onChain} payments / ${stats.nPayers} payers / ${result.nPayerClusters} clusters${drift}`,
      );
      for (const f of result.flags.slice(0, 3)) console.log(`     • ${f}`);
    } catch (e) {
      console.log(`  → error: ${(e as Error).message}`);
    }
  }
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
