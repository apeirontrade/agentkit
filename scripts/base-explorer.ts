/**
 * Base x402 explorer v1 — score real Base endpoints from the Coinbase Bazaar
 * with our wash-risk engine. Read-only, free public RPCs, no wallet.
 *
 *   pnpm tsx scripts/base-explorer.ts [maxEndpoints] [windowDays]
 *
 * v1 signals run on raw USDC transfers (payer counts, concentration, timing,
 * amounts); per-wallet forensics (age/funder) degrade gracefully and land in v2.
 * Block timestamps are derived from Base's fixed 2s cadence (no extra RPC).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";
import { base } from "viem/chains";
import { fetchBaseResources, groupByPayTo, mapPool, BASE_USDC } from "@agentkit/provenance";
import { assessWashRisk, type PaymentRecord } from "@agentkit/scoring";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
// publicnode gates getLogs behind a token; 1rpc caps ranges at 50 blocks.
// mainnet.base.org + drpc serve filtered getLogs fine.
const RPCS = ["https://mainnet.base.org", "https://base.drpc.org"];
const BLOCKS_PER_DAY = 43_200n; // Base: 2s blocks

async function main() {
  const maxEndpoints = Number(process.argv[2] ?? 8);
  const windowDays = BigInt(process.argv[3] ?? 14);

  console.log("Base x402 explorer — discovery via Coinbase Bazaar (open API)\n");
  const { routes, total } = await fetchBaseResources({ maxItems: 300, onProgress: (m) => console.log("  · " + m) });
  const byPayTo = groupByPayTo(routes);
  console.log(`  ${routes.length} Base-USDC routes across ${byPayTo.size} merchants (bazaar total: ${total})\n`);

  // one client per RPC; merchants rotate across them for throughput
  const clients = RPCS.map((u) => createPublicClient({ chain: base, transport: http(u) }));
  const head = await clients[0]!.getBlockNumber();
  const headTime = Date.now();
  const fromBlock = head - BLOCKS_PER_DAY * windowDays;
  const blockTime = (bn: bigint) => new Date(headTime - Number(head - bn) * 2000);

  // Prefer merchants with the most listed routes (proxy for seriousness).
  const merchants = [...byPayTo.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxEndpoints);
  console.log(`scoring ${merchants.length} merchants over ${windowDays}d (concurrency 4)…\n`);

  const out = await mapPool(merchants, 4, async ([payTo, rs], idx) => {
    const client = clients[idx % clients.length]!;
    const name = rs[0]?.serviceName || new URL(rs[0]?.resource || "http://x").host;
    try {
      // chunked getLogs; halve the chunk on RPC range errors
      const payments: PaymentRecord[] = [];
      let chunk = 10_000n;
      let cursor = fromBlock;
      while (cursor <= head) {
        const to = cursor + chunk - 1n > head ? head : cursor + chunk - 1n;
        try {
          const logs = await client.getLogs({
            address: BASE_USDC as `0x${string}`,
            event: TRANSFER,
            args: { to: payTo as `0x${string}` },
            fromBlock: cursor,
            toBlock: to,
          });
          for (const l of logs) {
            payments.push({
              payer: l.args.from!,
              amountUsdc: formatUnits(l.args.value ?? 0n, 6),
              blockTime: blockTime(l.blockNumber!),
              txHash: l.transactionHash!,
            });
          }
          cursor = to + 1n;
        } catch (e) {
          if (chunk > 2_000n) { chunk /= 2n; continue; }
          throw e;
        }
      }
      const wash = assessWashRisk({
        endpointId: payTo,
        payTo,
        windowStart: blockTime(fromBlock),
        windowEnd: new Date(headTime),
        payments,
      });
      console.log(
        `  ✓ ${name.slice(0, 32).padEnd(32)} WASH ${wash.level.toUpperCase().padEnd(8)} ${String(wash.score).padStart(3)}/100 · ${payments.length}p/${wash.nPayers} payers`,
      );
      return {
        payTo, name, routes: rs.length,
        washLevel: wash.level, washScore: wash.score,
        payments: payments.length, payers: wash.nPayers, clusters: wash.nPayerClusters,
        topFlags: wash.indicators.slice(0, 3).map((i) => i.detail),
        coinbaseQuality: rs[0]?.quality ?? null,
        sampleResource: rs[0]?.resource,
      } as Record<string, unknown>;
    } catch (e) {
      console.log(`  ✗ ${name.slice(0, 32)} error: ${(e as Error).message.slice(0, 60)}`);
      return { payTo, name, error: (e as Error).message } as Record<string, unknown>;
    }
  });

  mkdirSync("scratch", { recursive: true });
  writeFileSync("scratch/base-explorer.json", JSON.stringify({ takenAt: new Date().toISOString(), windowDays: Number(windowDays), chain: "base", rows: out }, null, 2));
  console.log(`\n→ scratch/base-explorer.json (${out.length} merchants scored)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
