/**
 * Take a full snapshot of the live GoPlausible Algorand x402 registry: score
 * every endpoint, compute wash risk + facilitator drift, label via NFD, and
 * write a timestamped JSON snapshot. This is the leaderboard's data layer and
 * the drift monitor's per-run record.
 *
 *   pnpm provenance:snapshot [windowDays]
 * Output: scratch/provenance-snapshot.json
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { snapshotRegistry } from "@agentkit/provenance";

async function main() {
  const windowDays = Number(process.argv[2] ?? 400);
  const snap = await snapshotRegistry({
    windowDays,
    now: new Date(),
    onProgress: (m) => console.log("  · " + m),
  });

  mkdirSync("scratch", { recursive: true });
  const path = "scratch/provenance-snapshot.json";
  writeFileSync(path, JSON.stringify(snap, null, 2));

  console.log(`\nProvenance leaderboard — ${snap.rows.length} endpoints, ${snap.totalRoutes} routes\n`);
  for (const r of snap.rows) {
    const name = r.nfdName ?? r.payTo.slice(0, 14) + "…";
    const grade = r.grade === "INSUFFICIENT_DATA" ? "n/a" : `${r.grade} (${r.orq})`;
    const driftStr =
      r.drift !== null ? `  drift ${r.drift >= 0 ? "+" : ""}${r.drift}` : "";
    console.log(
      `  ${name.padEnd(18)}  grade ${grade.padEnd(9)}  WASH ${r.washLevel.toUpperCase().padEnd(8)} ${String(r.washScore).padStart(3)}/100` +
        `  ${r.onChainPayments}p/${r.onChainPayers}payers  fac.settle=${r.facilitatorSettle}${driftStr}`,
    );
    if (r.topFlags[0]) console.log(`     ⚑ ${r.topFlags[0]}`);
  }
  console.log(`\nsnapshot → ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
