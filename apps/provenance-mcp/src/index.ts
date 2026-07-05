/**
 * Provenance MCP server — puts endpoint wash-risk checks in front of every agent
 * stack (Claude Desktop/Code, Cursor, any MCP client). This is the distribution
 * lever: instead of hoping people find a paid API, Provenance becomes a tool an
 * agent reaches for whenever it's about to trust or pay an x402 endpoint.
 *
 * The quick check is free (drives adoption + becomes habit); deep reports point
 * to the paid x402 API. Add to a client via its MCP config:
 *   { "command": "pnpm", "args": ["--filter","provenance-mcp","start"] }
 */
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assembleInput } from "@agentkit/provenance";
import { assessWashRisk } from "@agentkit/scoring";

const ADDR_RE = /^[A-Z2-7]{58}$/;
const PAID_API = process.env.PROVENANCE_API_URL ?? "https://<deploy-me>/report/";

const server = new McpServer({ name: "provenance", version: "0.1.0" });

server.tool(
  "check_endpoint_risk",
  "Check the wash-traffic / organic-revenue risk of an Algorand x402 endpoint before trusting or paying it. Returns a risk level (low/medium/high/critical), a 0-100 score, and the specific on-chain red flags (few payers, self-dealing loops, fresh wallets, metronomic timing). Free quick check.",
  { address: z.string().describe("The Algorand endpoint payTo address (58 chars)") },
  async ({ address }) => {
    if (!ADDR_RE.test(address)) {
      return { content: [{ type: "text", text: "Invalid Algorand address (expected 58 chars, A-Z2-7)." }], isError: true };
    }
    try {
      const { input, stats } = await assembleInput(address, { windowDays: 730, maxEnrichedPayers: 50, now: new Date() });
      const wash = assessWashRisk(input);
      const verdict = {
        endpoint: address,
        washRisk: wash.level,
        score: `${wash.score}/100`,
        onChain: `${stats.nPayments} payments · ${stats.nPayers} distinct payers · ${wash.nPayerClusters} clusters`,
        redFlags: wash.indicators.slice(0, 4).map((i) => i.detail),
        interpretation:
          wash.level === "low" ? "Looks organic — many independent payers." :
          wash.level === "critical" ? "Almost certainly self-testing, not real demand. Payment does not imply the endpoint is a scam — it may deliver — but its 'revenue' is not organic." :
          "Concentrated / thin demand. Treat its usage numbers skeptically.",
        deeperReport: `For the full 8-signal grade + drift, pay 0.50 USDC: GET ${PAID_API}${address}`,
      };
      return { content: [{ type: "text", text: JSON.stringify(verdict, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Could not score ${address}: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "list_high_risk_endpoints",
  "List the current highest-wash-risk Algorand x402 endpoints from the latest Provenance snapshot, so an agent can avoid paying endpoints with fabricated revenue.",
  {},
  async () => {
    try {
      const snap = JSON.parse(readFileSync("scratch/provenance-snapshot.json", "utf8"));
      const rows = (snap.rows ?? [])
        .filter((r: { washLevel: string }) => r.washLevel === "high" || r.washLevel === "critical")
        .map((r: { payTo: string; nfdName?: string; washLevel: string; washScore: number; onChainPayers: number }) => ({
          endpoint: r.nfdName ?? r.payTo,
          risk: r.washLevel,
          score: r.washScore,
          payers: r.onChainPayers,
        }));
      return { content: [{ type: "text", text: JSON.stringify({ asOf: snap.takenAt, highRisk: rows }, null, 2) }] };
    } catch {
      return { content: [{ type: "text", text: "No snapshot available yet. Run the Provenance cycle first." }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Provenance MCP server ready (stdio).");
