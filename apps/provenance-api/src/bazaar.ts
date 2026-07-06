/**
 * Bazaar discovery extension for the Provenance API — shared by the server
 * (rides in every 402 + settle-time declaration) and the dry-run validator.
 *
 * Built with @x402/extensions/bazaar's declareDiscoveryExtension so the shape
 * is exactly what Coinbase's CDP facilitator strict-validates on settle:
 * `{ bazaar: { info, schema } }` with a 2020-12 JSON Schema whose
 * `properties.input` must validate the declared `info.input`. A valid
 * extension + first successful settlement through CDP = auto-listed in the
 * x402 Bazaar (no registration). GoPlausible reads the same extension for the
 * Global x402 Challenge leaderboard.
 */
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

export type Depth = "quick" | "full" | "deep";

const EXAMPLE_ADDR = "K5HIZPOUUUBQ5WJ6I3DT6NGIQUMALYJYSVVBY7CXA3BYBWY6225DNNBDSA";

// The Input type omits `method` (the express middleware injects it from route
// config via bazaarResourceServerExtension.enrichDeclaration); we hand-roll
// HTTP, so we inject it ourselves — the runtime spreads it through, and the
// schema requires it, so the cast is load-bearing, not a lie.
type DeclareConfig = Parameters<typeof declareDiscoveryExtension>[0] & { method: "GET" };

export const bazaarExtension = (depth: Depth) =>
  declareDiscoveryExtension({
    method: "GET",
    pathParams: { address: EXAMPLE_ADDR },
    pathParamsSchema: {
      properties: {
        address: { type: "string", pattern: "^[A-Z2-7]{58}$", description: "Algorand payTo address of the x402 endpoint to score" },
      },
      required: ["address"],
    },
    output: {
      example: {
        endpoint: EXAMPLE_ADDR,
        tier: depth,
        washRisk: { level: "critical", score: 98 },
        onChain: { payments: 207, payers: 2, clusters: 1 },
        methodology: "provenance v0.1 · organic-revenue-quality",
      },
    },
  } as DeclareConfig);

// Built once — the declaration must be identical between 402 and settle-time.
export const BAZAAR_EXTENSIONS: Record<Depth, ReturnType<typeof bazaarExtension>> = {
  quick: bazaarExtension("quick"),
  full: bazaarExtension("full"),
  deep: bazaarExtension("deep"),
};
