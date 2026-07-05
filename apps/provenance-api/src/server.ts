/**
 * Provenance x402 API — a deployable, secret-free service that sells organic-
 * revenue-quality / wash-risk scores for Algorand x402 endpoints.
 *
 * Holds NO private keys: the resource server never signs — the GoPlausible
 * facilitator settles payments to our public payTo address. Safe to deploy
 * anywhere. Includes a `bazaar` discovery extension so GoPlausible auto-lists
 * this endpoint on the Global x402 Challenge leaderboard once it's public and
 * receives its first payment.
 *
 * Config (env): PORT, PROVENANCE_PAYTO, PRICE_USDC, FACILITATOR_URL, NETWORK.
 */
import http from "node:http";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402-avm/core/server";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/server";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402-avm/core/http";
import { assessWashRisk } from "@agentkit/scoring";
import { assembleInput } from "@agentkit/provenance";

const PORT = Number(process.env.PORT ?? 8402);
const PAY_TO = process.env.PROVENANCE_PAYTO ?? "K5HIZPOUUUBQ5WJ6I3DT6NGIQUMALYJYSVVBY7CXA3BYBWY6225DNNBDSA";
const PRICE_USDC = process.env.PRICE_USDC ?? "0.01";
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://facilitator.goplausible.xyz";
const NETWORK = process.env.NETWORK ?? "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const SPONSOR = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
const PRICE_ATOMIC = String(Math.round(Number(PRICE_USDC) * 1e6));
const ADDR_RE = /^[A-Z2-7]{58}$/;

const BAZAAR_EXTENSION = {
  bazaar: {
    info: {
      input: { type: "http", method: "GET", pathParams: { address: "Algorand endpoint payTo address" } },
      output: {
        type: "json",
        example: {
          endpoint: "MERCHANT_ADDRESS",
          washRisk: { level: "critical", score: 98, topIndicators: [{ name: "concentration", detail: "top cluster holds 100% of revenue" }] },
          onChain: { payments: 207, payers: 2, clusters: 1 },
        },
      },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: { address: { type: "string", description: "58-char Algorand address to score" } },
          required: ["address"],
        },
      },
    },
  },
};

function requirementsFor(resourceUrl: string) {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: PRICE_ATOMIC,
    asset: "31566704",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    resource: resourceUrl,
    description: "Provenance organic-revenue-quality / wash-risk score for an Algorand x402 endpoint",
    mimeType: "application/json",
    extra: { name: "USDC", decimals: 6, feePayer: SPONSOR },
  };
}

function baseUrl(req: http.IncomingMessage): string {
  const host = req.headers.host ?? `localhost:${PORT}`;
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "http";
  return `${proto}://${host}`;
}

async function main() {
  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const server = new x402ResourceServer(facilitator);
  registerExactAvmScheme(server, { networks: [NETWORK as `${string}:${string}`] });
  await server.initialize();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", baseUrl(req));

    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          service: "Provenance x402 API",
          description: "Pay to get an organic-revenue-quality / wash-risk score for any Algorand x402 endpoint.",
          usage: `GET /score/<ALGORAND_ADDRESS>  →  ${PRICE_USDC} USDC via x402 (GoPlausible)`,
          network: NETWORK,
          payTo: PAY_TO,
          methodology: "provenance v0.1 · 8-signal ORQ + wash-risk",
        }, null, 2),
      );
      return;
    }

    const m = url.pathname.match(/^\/score\/(.+)$/);
    if (!m || !ADDR_RE.test(m[1]!)) {
      res.writeHead(404, { "content-type": "application/json" }).end(
        JSON.stringify({ error: "GET /score/<58-char Algorand address>" }),
      );
      return;
    }
    const target = m[1]!;
    const resourceUrl = `${baseUrl(req)}${url.pathname}`;
    const requirements = requirementsFor(resourceUrl);

    const paymentHeader = req.headers["payment-signature"] as string | undefined;
    if (!paymentHeader) {
      const required = {
        x402Version: 2,
        error: "Payment required",
        resource: { url: resourceUrl, description: requirements.description, mimeType: "application/json" },
        accepts: [requirements],
        extensions: BAZAAR_EXTENSION,
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
        res.writeHead(402, { "content-type": "application/json" }).end(
          JSON.stringify({ error: "settlement failed", detail: settle }),
        );
        return;
      }
      const { input, stats } = await assembleInput(target, { windowDays: 730, maxEnrichedPayers: 60, now: new Date() });
      const wash = assessWashRisk(input);
      res.writeHead(200, { "content-type": "application/json", "x-payment-settled": settle.transaction ?? "" }).end(
        JSON.stringify({
          endpoint: target,
          washRisk: { level: wash.level, score: wash.score, topIndicators: wash.indicators.slice(0, 3) },
          onChain: { payments: stats.nPayments, payers: stats.nPayers, clusters: wash.nPayerClusters },
          settlement: settle.transaction,
          methodology: "provenance v0.1 · organic-revenue-quality",
        }, null, 2),
      );
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
    }
  });

  httpServer.listen(PORT, () => {
    console.log(`Provenance x402 API :${PORT} · ${PRICE_USDC} USDC/score · payTo ${PAY_TO.slice(0, 10)}…`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
