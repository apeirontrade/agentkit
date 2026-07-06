/**
 * Bazaar Wash Report v1 — grade top Coinbase x402 Bazaar endpoints on
 * organic-vs-wash volume and quantify how much rank the wash buys them.
 *
 *   npx tsx scripts/wash-report.ts [maxEndpoints=25] [windowDays=30] [maxBazaarItems=all]
 *
 * Pipeline:
 *   1. Scan the FULL Bazaar discovery feed (open API, no key) and rank
 *      merchants by Coinbase's own volume signal (quality.l30DaysTotalCalls).
 *   2. For the top N merchants, pull observed on-chain USDC transfers to their
 *      payTo over the window (public Base RPCs, chunked getLogs).
 *   3. Score each with @agentkit/scoring assessWashRisk.
 *   4. Headline metric — WASH-RANK INFLATION: organicAdjustedRank − bazaarRank,
 *      where organicAdjustedCalls = bazaarCalls × (1 − washScore/100).
 *
 * Outputs: scratch/wash-report.json + scratch/wash-report.html (self-contained).
 * Read-only, no wallet, no new deps. Envio HyperSync skipped (no token in .env).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";
import { base } from "viem/chains";
import { fetchBaseResources, groupByPayTo, mapPool, BASE_USDC, type BaseResource } from "@agentkit/provenance";
import { assessWashRisk, type PaymentRecord } from "@agentkit/scoring";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
// Known-good filtered-getLogs public RPCs (publicnode gates getLogs; 1rpc caps ranges).
const RPCS = ["https://mainnet.base.org", "https://base.drpc.org"];
const BLOCKS_PER_DAY = 43_200n; // Base: 2s blocks

// ---------- helpers ----------

interface Quality { calls: number; payers: number; lastCalledAt?: string }

function parseQuality(q: unknown): Quality {
  const o = (q ?? {}) as Record<string, unknown>;
  return {
    calls: typeof o.l30DaysTotalCalls === "number" ? o.l30DaysTotalCalls : 0,
    payers: typeof o.l30DaysUniquePayers === "number" ? o.l30DaysUniquePayers : 0,
    lastCalledAt: typeof o.lastCalledAt === "string" ? o.lastCalledAt : undefined,
  };
}

/** Retry wrapper for the Bazaar fetch — the feed is 23K+ items / ~230 pages. */
const retryingFetch: typeof fetch = async (url, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init).catch((e) => {
      if (attempt >= 4) throw e;
      return null;
    });
    if (res && res.ok) return res;
    if (res && res.status < 500 && res.status !== 429) return res; // real client error — surface it
    if (attempt >= 4) return res ?? new Response(null, { status: 599 });
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
};

function grade(score: number): string {
  return score < 10 ? "A" : score < 20 ? "B" : score < 45 ? "C" : score < 70 ? "D" : "F";
}

function domainOf(resource?: string): string {
  try { return new URL(resource ?? "").host; } catch { return "unknown"; }
}

function truncAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function mondayOfWeek(d: Date): string {
  const m = new Date(d);
  m.setUTCDate(m.getUTCDate() - ((m.getUTCDay() + 6) % 7));
  return m.toISOString().slice(0, 10);
}

// ---------- main ----------

interface MerchantRow {
  payTo: string;
  name: string;
  domains: string[];
  routes: number;
  bazaarCalls: number;        // Coinbase quality.l30DaysTotalCalls (deduped, summed per merchant)
  bazaarClaimedPayers: number;
  bazaarRank: number;
  observedPayments: number;
  observedPayers: number;
  observedUsdc: number;
  washScore: number;
  washLevel: string;
  washGrade: string;
  topIndicators: string[];
  organicAdjCalls: number;
  organicRank: number;
  washRankInflation: number;  // organicRank − bazaarRank; +N = Bazaar over-ranks it by N positions
  sampleResource?: string;
  error?: string;
}

async function main() {
  const maxEndpoints = Number(process.argv[2] ?? 25);
  const windowDays = BigInt(process.argv[3] ?? 30);
  const maxBazaarItems = Number(process.argv[4] ?? 1_000_000);

  console.log("Bazaar Wash Report v1 — full Bazaar scan via Coinbase discovery API\n");
  const t0 = Date.now();
  const { routes, total } = await fetchBaseResources({
    maxItems: maxBazaarItems,
    fetchImpl: retryingFetch,
    onProgress: (m) => { const n = Number(m.match(/bazaar: (\d+)\//)?.[1] ?? 0); if (n % 2000 === 0) console.log("  · " + m); },
  });
  console.log(`  scanned ${total} Bazaar items → ${routes.length} Base-USDC routes in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  // Dedupe duplicate listings of the same resource under the same payTo,
  // keeping the MAX call count (conservative — never double-counts volume).
  const dedup = new Map<string, BaseResource>();
  for (const r of routes) {
    const key = `${r.payTo.toLowerCase()}|${r.resource}`;
    const prev = dedup.get(key);
    if (!prev || parseQuality(r.quality).calls > parseQuality(prev.quality).calls) dedup.set(key, r);
  }
  const byPayTo = groupByPayTo([...dedup.values()]);

  // Merchant volume = sum of Coinbase's 30d call counts across its routes.
  const merchants = [...byPayTo.entries()]
    .map(([payTo, rs]) => {
      let calls = 0, payers = 0;
      for (const r of rs) { const q = parseQuality(r.quality); calls += q.calls; payers += q.payers; }
      const best = [...rs].sort((a, b) => parseQuality(b.quality).calls - parseQuality(a.quality).calls)[0]!;
      return { payTo, rs, calls, payers, best };
    })
    .filter((m) => m.calls > 0)
    .sort((a, b) => b.calls - a.calls)
    .slice(0, maxEndpoints);

  console.log(`top ${merchants.length} merchants by Bazaar 30d call volume — scoring over ${windowDays}d of on-chain USDC…\n`);

  const clients = RPCS.map((u) => createPublicClient({ chain: base, transport: http(u) }));
  const head = await clients[0]!.getBlockNumber();
  const headTime = Date.now();
  const fromBlock = head - BLOCKS_PER_DAY * windowDays;
  const blockTime = (bn: bigint) => new Date(headTime - Number(head - bn) * 2000);

  const scored = await mapPool(merchants, 4, async (m, idx) => {
    const name = m.best.serviceName || domainOf(m.best.resource);
    const domains = [...new Set(m.rs.map((r) => domainOf(r.resource)))];
    const row: MerchantRow = {
      payTo: m.payTo, name, domains, routes: m.rs.length,
      bazaarCalls: m.calls, bazaarClaimedPayers: m.payers, bazaarRank: 0,
      observedPayments: 0, observedPayers: 0, observedUsdc: 0,
      washScore: 0, washLevel: "low", washGrade: "A", topIndicators: [],
      organicAdjCalls: 0, organicRank: 0, washRankInflation: 0,
      sampleResource: m.best.resource,
    };
    try {
      const payments: PaymentRecord[] = [];
      let chunk = 10_000n;
      let cursor = fromBlock;
      let rpcIdx = idx % clients.length;
      let consecErrs = 0;
      while (cursor <= head) {
        const to = cursor + chunk - 1n > head ? head : cursor + chunk - 1n;
        try {
          const logs = await clients[rpcIdx]!.getLogs({
            address: BASE_USDC as `0x${string}`,
            event: TRANSFER,
            args: { to: m.payTo as `0x${string}` },
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
          consecErrs = 0;
        } catch (e) {
          consecErrs++;
          if (consecErrs >= 12) throw e;
          if (chunk > 1_000n) { chunk /= 2n; continue; }
          rpcIdx = (rpcIdx + 1) % clients.length; // rotate RPC and back off
          await new Promise((r) => setTimeout(r, 800 * consecErrs));
        }
      }
      const wash = assessWashRisk({
        endpointId: m.payTo,
        payTo: m.payTo,
        windowStart: blockTime(fromBlock),
        windowEnd: new Date(headTime),
        payments,
      });
      row.observedPayments = payments.length;
      row.observedPayers = wash.nPayers;
      row.observedUsdc = payments.reduce((a, p) => a + Number(p.amountUsdc), 0);
      row.washScore = wash.score;
      row.washLevel = wash.level;
      row.washGrade = grade(wash.score);
      row.topIndicators = wash.indicators.slice(0, 3).map((i) => i.detail);
      if (payments.length === 0)
        row.topIndicators.unshift(`no on-chain USDC transfers to payTo observed in ${windowDays}d window despite ${m.calls} claimed 30d calls`);
      console.log(
        `  ✓ ${name.slice(0, 30).padEnd(30)} bazaar ${String(m.calls).padStart(6)} calls · WASH ${wash.level.toUpperCase().padEnd(8)} ${String(wash.score).padStart(3)}/100 (${row.washGrade}) · ${payments.length}tx/${wash.nPayers} payers`,
      );
    } catch (e) {
      row.error = (e as Error).message.slice(0, 120);
      row.washScore = -1; row.washGrade = "?"; row.washLevel = "unscored";
      console.log(`  ✗ ${name.slice(0, 30)} error: ${row.error.slice(0, 60)}`);
    }
    return row;
  });

  // ---------- ranks + Wash-Rank Inflation ----------
  const ok = scored.filter((r) => !r.error);
  ok.sort((a, b) => b.bazaarCalls - a.bazaarCalls);
  ok.forEach((r, i) => { r.bazaarRank = i + 1; });
  for (const r of ok) r.organicAdjCalls = Math.round(r.bazaarCalls * (1 - r.washScore / 100));
  const organic = [...ok].sort((a, b) => b.organicAdjCalls - a.organicAdjCalls || a.bazaarRank - b.bazaarRank);
  organic.forEach((r, i) => { r.organicRank = i + 1; });
  for (const r of ok) r.washRankInflation = r.organicRank - r.bazaarRank;

  const report = {
    title: "The Bazaar Wash Report",
    weekOf: mondayOfWeek(new Date()),
    takenAt: new Date().toISOString(),
    methodology: "provenance v0.1 organic-revenue-quality",
    chain: "base (eip155:8453)",
    asset: `USDC ${BASE_USDC}`,
    windowDays: Number(windowDays),
    bazaarItemsScanned: total,
    merchantsScored: ok.length,
    metricDefinition:
      "washRankInflation = organicAdjustedRank − bazaarVolumeRank, where organicAdjustedCalls = bazaarL30dCalls × (1 − washScore/100). Positive = the endpoint ranks that many positions higher on raw volume than its organic-adjusted volume supports.",
    rows: [...ok].sort((a, b) => b.washRankInflation - a.washRankInflation || a.bazaarRank - b.bazaarRank),
    errors: scored.filter((r) => r.error).map((r) => ({ payTo: r.payTo, name: r.name, error: r.error })),
  };

  mkdirSync("scratch", { recursive: true });
  writeFileSync("scratch/wash-report.json", JSON.stringify(report, null, 2));
  writeFileSync("scratch/wash-report.html", renderHtml(report));
  console.log(`\n→ scratch/wash-report.json + scratch/wash-report.html (${ok.length} merchants, ${report.errors.length} errors)`);
  const top = report.rows.slice(0, 3);
  for (const r of top) console.log(`  most inflated: ${r.name} (${truncAddr(r.payTo)}) +${r.washRankInflation} positions, wash ${r.washScore}/100 (${r.washGrade})`);
}

// ---------- HTML ----------

function renderHtml(report: {
  weekOf: string; takenAt: string; windowDays: number; bazaarItemsScanned: number;
  merchantsScored: number; rows: MerchantRow[]; metricDefinition: string;
}): string {
  const { rows } = report;
  const flagged = rows.filter((r) => r.washScore >= 20).length;
  const maxInfl = rows.length ? Math.max(...rows.map((r) => r.washRankInflation)) : 0;
  const totalClaimed = rows.reduce((a, r) => a + r.bazaarCalls, 0);
  const totalOrganic = rows.reduce((a, r) => a + r.organicAdjCalls, 0);
  const washShare = totalClaimed > 0 ? Math.round((1 - totalOrganic / totalClaimed) * 100) : 0;

  const gradeColor: Record<string, string> = { A: "#3fb950", B: "#8bc34a", C: "#d29922", D: "#f0883e", F: "#f85149" };

  const tr = rows.map((r) => {
    const inflStr = r.washRankInflation > 0 ? `+${r.washRankInflation}` : `${r.washRankInflation}`;
    const inflClass = r.washRankInflation > 0 ? "infl-pos" : r.washRankInflation < 0 ? "infl-neg" : "infl-zero";
    const gc = gradeColor[r.washGrade] ?? "#8b949e";
    const indicator = r.topIndicators[0] ?? "none observed";
    return `<tr>
      <td class="mono dim">#${r.bazaarRank}</td>
      <td><div class="ep-name">${esc(r.name)}</div><div class="ep-meta mono">${esc(truncAddr(r.payTo))} · ${esc(r.domains[0] ?? "")}</div></td>
      <td class="num">${r.bazaarCalls.toLocaleString()}<div class="ep-meta">rank #${r.bazaarRank}</div></td>
      <td class="num">${r.organicAdjCalls.toLocaleString()}<div class="ep-meta">rank #${r.organicRank}</div></td>
      <td class="center"><span class="grade" style="color:${gc};border-color:${gc}55">${r.washGrade}</span><div class="ep-meta">${r.washScore}/100 ${esc(r.washLevel)}</div></td>
      <td class="center"><span class="${inflClass}">${inflStr}</span></td>
      <td class="ind">${esc(indicator)}</td>
    </tr>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Bazaar Wash Report — week of ${report.weekOf}</title>
<style>
  :root{color-scheme:light dark;
    --bg:#0d1117;--panel:#161b22;--border:#30363d;--fg:#e6edf3;--dim:#8b949e;--accent:#58a6ff;}
  @media (prefers-color-scheme: light){:root{--bg:#f6f8fa;--panel:#ffffff;--border:#d0d7de;--fg:#1f2328;--dim:#57606a;--accent:#0969da;}}
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;padding:2.5rem 1rem 4rem}
  .wrap{max-width:1060px;margin:0 auto}
  h1{font-size:1.7rem;letter-spacing:-.01em}
  .sub{color:var(--dim);margin:.4rem 0 1.6rem}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.8rem;margin-bottom:1.8rem}
  .tile{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:.9rem 1rem}
  .tile b{display:block;font-size:1.45rem;font-weight:600}
  .tile span{color:var(--dim);font-size:.82rem}
  .tblwrap{overflow-x:auto;border:1px solid var(--border);border-radius:8px;background:var(--panel)}
  table{border-collapse:collapse;width:100%;min-width:880px;font-size:.9rem}
  th{color:var(--dim);font-weight:600;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;text-align:left;padding:.7rem .8rem;border-bottom:1px solid var(--border)}
  td{padding:.65rem .8rem;border-bottom:1px solid var(--border);vertical-align:top}
  tr:last-child td{border-bottom:none}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem}
  .dim{color:var(--dim)}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .center{text-align:center}
  .ep-name{font-weight:600}
  .ep-meta{color:var(--dim);font-size:.76rem;margin-top:.15rem}
  .grade{display:inline-block;border:1px solid;border-radius:6px;padding:.05rem .55rem;font-weight:700;font-size:1rem}
  .infl-pos{color:#f85149;font-weight:700;font-variant-numeric:tabular-nums}
  .infl-neg{color:#3fb950;font-weight:600;font-variant-numeric:tabular-nums}
  .infl-zero{color:var(--dim)}
  .ind{font-size:.82rem;color:var(--dim);max-width:280px}
  .note,.foot{color:var(--dim);font-size:.82rem;margin-top:1.4rem;line-height:1.6}
  .foot{border-top:1px solid var(--border);padding-top:1rem;margin-top:2rem}
  a{color:var(--accent);text-decoration:none}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em}
</style></head><body><div class="wrap">
  <h1>The Bazaar Wash Report — week of ${report.weekOf}</h1>
  <p class="sub">Independent organic-volume grading of the top ${report.merchantsScored} Coinbase x402 Bazaar endpoints on Base, ranked by <b>Wash-Rank Inflation</b> — how many leaderboard positions raw volume buys beyond what organic-adjusted volume supports. Bazaar ranks by volume and recency with no fraud filtering; this report quantifies the gap.</p>
  <div class="tiles">
    <div class="tile"><b>${report.bazaarItemsScanned.toLocaleString()}</b><span>Bazaar listings scanned</span></div>
    <div class="tile"><b>${report.merchantsScored}</b><span>top merchants scored on-chain</span></div>
    <div class="tile"><b>${flagged}/${report.merchantsScored}</b><span>graded C or worse (wash risk ≥ 20)</span></div>
    <div class="tile"><b>${washShare}%</b><span>of top-tier claimed volume estimated non-organic</span></div>
    <div class="tile"><b>+${maxInfl}</b><span>max wash-rank inflation (positions)</span></div>
  </div>
  <div class="tblwrap"><table>
    <thead><tr>
      <th>Bazaar rank</th><th>Endpoint</th><th>Bazaar 30d calls</th><th>Organic-adjusted</th><th>Wash grade</th><th>Wash-rank inflation</th><th>Top wash indicator</th>
    </tr></thead>
    <tbody>${tr}</tbody>
  </table></div>
  <p class="note"><b>Reading the table:</b> rows are sorted by wash-rank inflation (most over-ranked first). “Bazaar 30d calls” is Coinbase’s own published <code>quality.l30DaysTotalCalls</code> signal, summed per receiving wallet. “Organic-adjusted” discounts that volume by the endpoint’s wash-risk score, computed independently from ${report.windowDays} days of on-chain USDC transfers to its <code>payTo</code> address: distinct-payer count, payer revenue concentration (HHI), metronomic payment timing, and funding-cluster analysis. <span class="infl-pos">+N</span> means the endpoint sits N positions higher on the volume leaderboard than its organic-adjusted volume supports.</p>
  <p class="note"><b>Disclaimer:</b> all scores are statistical estimates derived from public on-chain data and Coinbase’s public discovery feed. A high wash-risk score indicates payment patterns inconsistent with organic multi-party demand (e.g. self-testing, load generation, or a single dominant payer) — it is <b>not</b> an accusation of fraud against any party. Low payer diversity can also reflect a young service or one large legitimate customer. Transfers to a <code>payTo</code> wallet may include non-x402 USDC receipts.</p>
  <p class="foot">Provenance v0.1 · organic-revenue-quality · <code>provenance-mcp</code> on npm · data window ${report.windowDays}d ending ${report.takenAt.slice(0, 10)} · chain Base (eip155:8453) · generated ${report.takenAt}</p>
</div></body></html>`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
