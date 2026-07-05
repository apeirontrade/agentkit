/**
 * Score a LIVE Algorand x402 endpoint by its receiving (payTo) address.
 * Read-only — assembles real indexer data and runs the ORQ engine.
 *
 *   pnpm provenance:score <ALGORAND_PAYTO_ADDRESS> [windowDays]
 *
 * Prints the grade, ORQ, confidence interval, subscores, and evidence flags.
 */
import { scoreLiveEndpoint } from "@agentkit/provenance";

async function main() {
  const payTo = process.argv[2];
  const windowDays = Number(process.argv[3] ?? 365);
  if (!payTo) {
    console.log("usage: pnpm provenance:score <ALGORAND_PAYTO_ADDRESS> [windowDays]");
    console.log("       (read-only; scores real on-chain USDC activity to that address)");
    return;
  }

  console.log(`Scoring Algorand endpoint ${payTo} over ${windowDays}d…\n`);
  const { result, stats } = await scoreLiveEndpoint(payTo, {
    windowDays,
    maxEnrichedPayers: 150,
    scoreOptions: { bootstrapRounds: 200, seed: 1 },
    onProgress: (m) => console.log("  · " + m),
  });

  console.log(
    `\n${payTo}\n  grade ${result.grade}   ORQ ${result.orq ?? "—"}` +
      (result.orq !== null ? `  (CI ${result.ciLow}–${result.ciHigh})` : "") +
      `\n  ${stats.nPayments} payments · ${stats.nPayers} payers` +
      `${stats.truncated ? ` (enriched top ${stats.nEnriched})` : ""}` +
      ` · ${result.nPayerClusters} clusters`,
  );
  console.log(
    "  " +
      Object.entries(result.subscores)
        .map(([k, v]) => `${k}=${v.value.toFixed(2)}${v.dataBacked ? "" : "*"}`)
        .join("  "),
  );
  if (result.flags.length) for (const f of result.flags) console.log("   • " + f);
  console.log("\n  (* = signal ran on absent/optional data)");
}

main().catch((e) => {
  console.error("score error:", e);
  process.exit(1);
});
