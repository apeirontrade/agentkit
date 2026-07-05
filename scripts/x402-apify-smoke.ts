/**
 * TICKET 5 — the portfolio de-risking milestone.
 *
 * Gets a single Apify Actor call PAID via x402 on Base, end-to-end. Proves the
 * payer, the wallet ops, and the Base rail all work before anything is built on
 * top of them.
 *
 * Requirements (all real-world, cannot be stubbed):
 *   JOBSMITH_WALLET_PK  — a Base wallet private key (0x...), funded with a few
 *                         dollars of USDC + a little ETH for the initial token buy.
 *   SMOKE_AMOUNT_USD    — optional, default 1 (Apify minimum). Keep it small.
 *   SMOKE_ACTOR         — optional Actor id, default a cheap public scraper.
 *
 * Run:  pnpm tsx scripts/x402-apify-smoke.ts
 *
 * Until a funded key is present it prints exactly what's missing and exits 0 —
 * so CI stays green and the operator sees the checklist.
 */
import {
  createPayer,
  createApifyBuyer,
  APIFY,
  USDC,
} from "@agentkit/x402-core";

async function main() {
  const pk = process.env.JOBSMITH_WALLET_PK as `0x${string}` | undefined;
  const amountUsd = Number(process.env.SMOKE_AMOUNT_USD ?? APIFY.minPurchaseUsd);
  const actor = process.env.SMOKE_ACTOR ?? "apify~website-content-crawler";

  console.log("x402 ⇄ Apify smoke test");
  console.log("  network:", USDC.base.network, "USDC", USDC.base.address);
  console.log("  prepaid endpoint:", APIFY.prepaidTokenEndpoint);
  console.log("  amount:", amountUsd, "USD   actor:", actor);

  if (!pk) {
    console.log("\n⏸  JOBSMITH_WALLET_PK not set — nothing spent.");
    console.log("   To run for real:");
    console.log("   1) Create a Base wallet, fund with ~$" + (amountUsd + 1) + " USDC + a little ETH.");
    console.log("   2) export JOBSMITH_WALLET_PK=0x...");
    console.log("   3) pnpm tsx scripts/x402-apify-smoke.ts");
    console.log("\n   ⚠ VERIFY before first real run: Apify prepaid-token response field");
    console.log("     name (token vs prepaidToken) and the Actor run URL template.");
    return;
  }

  const payer = createPayer({ evmPrivateKey: pk });
  const buyer = createApifyBuyer({ payer, minBalanceUsd: amountUsd });

  console.log("\n→ buying prepaid token (this SPENDS real USDC)…");
  const token = await buyer.ensureToken(amountUsd);
  console.log("✓ token acquired:", token.slice(0, 8) + "…");

  console.log("→ running actor…");
  const result = await buyer.runActor(
    actor,
    { startUrls: [{ url: "https://example.com" }], maxCrawlPages: 1 },
    amountUsd,
  );
  console.log(result.ok ? "✓ actor returned" : "✗ actor failed", "items:", result.items.length);
  if (result.ok) {
    console.log("\n🎉 x402 payment rail proven end-to-end. Ticket 5 done.");
  } else {
    console.log("raw:", result.raw);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("smoke test error:", err);
  process.exit(1);
});
