/**
 * chain-indexer smoke test. Backfills recent USDC payments to a given address
 * on Base (and/or Algorand) and prints the normalized, classified results.
 * Read-only — spends nothing, needs no wallet.
 *
 * Base needs an RPC:   BASE_RPC_URL=https://... PAY_TO=0xSeller pnpm tsx scripts/indexer-smoke.ts
 * Algorand uses Nodely by default:  PAY_TO_ALGO=SELLERADDR pnpm tsx scripts/indexer-smoke.ts
 */
import { BaseIndexer, AlgorandIndexer, isConfirmed } from "@agentkit/chain-indexer";

async function main() {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const now = new Date();

  const payToBase = process.env.PAY_TO;
  if (payToBase && process.env.BASE_RPC_URL) {
    console.log(`\nBase: backfilling USDC → ${payToBase} (last 24h)…`);
    const idx = new BaseIndexer({ rpcUrl: process.env.BASE_RPC_URL });
    let n = 0;
    for await (const p of idx.backfill([payToBase], since, now)) {
      n++;
      console.log(
        `  ${p.amountUsdc} USDC  ${p.settlementKind}${p.facilitator ? ` (${p.facilitator})` : ""}  ${isConfirmed(p) ? "✓" : "…"}  ${p.txHash.slice(0, 12)}`,
      );
      if (n >= 20) break;
    }
    console.log(`  ${n} payment(s).`);
  } else {
    console.log("\nBase: set BASE_RPC_URL + PAY_TO to run.");
  }

  const payToAlgo = process.env.PAY_TO_ALGO;
  if (payToAlgo) {
    console.log(`\nAlgorand: backfilling USDC → ${payToAlgo} (last 24h)…`);
    const idx = new AlgorandIndexer();
    let n = 0;
    for await (const p of idx.backfill([payToAlgo], since, now)) {
      n++;
      console.log(
        `  ${p.amountUsdc} USDC  ${p.settlementKind}  ${p.txHash.slice(0, 12)}`,
      );
      if (n >= 20) break;
    }
    console.log(`  ${n} payment(s).`);
  } else {
    console.log("Algorand: set PAY_TO_ALGO to run (uses Nodely indexer).");
  }
}

main().catch((err) => {
  console.error("indexer smoke error:", err);
  process.exit(1);
});
