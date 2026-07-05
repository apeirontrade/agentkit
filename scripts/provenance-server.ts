/**
 * Provenance as a PAID x402 endpoint: agents pay 0.01 USDC to get a wash-risk /
 * organic-revenue-quality score for any Algorand endpoint address. Settles real
 * USDC via the GoPlausible facilitator. This is the monetization core and a
 * Challenge-entry component (a paid x402 endpoint on Algorand mainnet).
 *
 *   pnpm tsx scripts/provenance-server.ts            # serve on :8402
 *
 * Payments go to OUR wallet (address below). Run the payer against
 * http://localhost:8402/score/<ALGORAND_ADDRESS> to exercise it.
 */
import http from "node:http";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402-avm/core/server";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/server";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402-avm/core/http";
import { assessWashRisk } from "@agentkit/scoring";
import { assembleInput } from "@agentkit/provenance";

const PORT = 8402;
const PAY_TO = "K5HIZPOUUUBQ5WJ6I3DT6NGIQUMALYJYSVVBY7CXA3BYBWY6225DNNBDSA";
const MAINNET = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const SPONSOR = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
const PRICE = "10000"; // 0.01 USDC (6 dp)

function requirementsFor(resourceUrl: string) {
  return {
    scheme: "exact",
    network: MAINNET,
    amount: PRICE,
    asset: "31566704",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    resource: resourceUrl,
    description: "Provenance wash-risk score for an Algorand x402 endpoint",
    mimeType: "application/json",
    extra: { name: "USDC", decimals: 6, feePayer: SPONSOR },
  };
}

async function main() {
  const facilitator = new HTTPFacilitatorClient({ url: "https://facilitator.goplausible.xyz" });
  const server = new x402ResourceServer(facilitator);
  registerExactAvmScheme(server, { networks: [MAINNET] });
  await server.initialize();
  console.log("facilitator support loaded; server ready");

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const m = url.pathname.match(/^\/score\/([A-Z2-7]{58})$/);
    if (!m) {
      res.writeHead(404).end("usage: GET /score/<ALGORAND_ADDRESS>");
      return;
    }
    const target = m[1]!;
    const resourceUrl = `http://localhost:${PORT}${url.pathname}`;
    const requirements = requirementsFor(resourceUrl);

    const paymentHeader = req.headers["payment-signature"] as string | undefined;
    if (!paymentHeader) {
      const required = {
        x402Version: 2,
        error: "Payment required",
        resource: { url: resourceUrl, description: requirements.description, mimeType: "application/json" },
        accepts: [requirements],
        extensions: {},
      };
      res.writeHead(402, {
        "content-type": "application/json",
        "payment-required": encodePaymentRequiredHeader(required as never),
      });
      res.end("{}");
      return;
    }

    try {
      const payload = decodePaymentSignatureHeader(paymentHeader);
      const settle = await server.settlePayment(payload as never, requirements as never);
      if (!settle.success) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "settlement failed", detail: settle }));
        return;
      }
      console.log(`paid: ${settle.transaction} — scoring ${target.slice(0, 10)}…`);
      const { input, stats } = await assembleInput(target, { windowDays: 730, maxEnrichedPayers: 60, now: new Date() });
      const wash = assessWashRisk(input);
      res.writeHead(200, { "content-type": "application/json", "x-payment-settled": settle.transaction ?? "" });
      res.end(JSON.stringify({
        endpoint: target,
        washRisk: { level: wash.level, score: wash.score, topIndicators: wash.indicators.slice(0, 3) },
        onChain: { payments: stats.nPayments, payers: stats.nPayers, clusters: wash.nPayerClusters },
        settlement: settle.transaction,
        methodology: "provenance v0.1 · organic-revenue-quality",
      }, null, 2));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });

  httpServer.listen(PORT, () => {
    console.log(`Provenance x402 API on http://localhost:${PORT}`);
    console.log(`  GET /score/<addr>  →  0.01 USDC → ${PAY_TO.slice(0, 10)}…`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
