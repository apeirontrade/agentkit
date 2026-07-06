/**
 * Dry-run: prove the Bazaar discovery extension and the Base rail's 402 are
 * CDP-compliant WITHOUT deploying or paying.
 *
 *   pnpm --filter provenance-api dry-run                 # validate extensions only
 *   pnpm --filter provenance-api dry-run <402-url>       # + probe a live 402
 *
 * 1. Builds the exact `bazaar` extension the server ships and validates it
 *    with @x402/extensions' own validator (ajv, strict 2020-12 JSON Schema) —
 *    the same check the CDP facilitator runs before cataloging.
 * 2. If a URL is given, GETs it unauthenticated, decodes the PAYMENT-REQUIRED
 *    header, and prints the accepts[] (is eip155:8453 advertised? correct USDC
 *    asset/payTo?) plus the extension actually on the wire.
 */
import { validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { BAZAAR_EXTENSIONS, type Depth } from "../src/bazaar.js";

let failed = false;

for (const depth of ["quick", "full", "deep"] as Depth[]) {
  const ext = BAZAAR_EXTENSIONS[depth].bazaar!;
  const result = validateDiscoveryExtension(ext as never);
  const ok = result.valid;
  if (!ok) failed = true;
  console.log(`${ok ? "✓" : "✗"} bazaar extension (${depth}): ${ok ? "valid — strict JSON Schema passes" : JSON.stringify(result)}`);
}
console.log("\nwire shape (quick tier):");
console.log(JSON.stringify(BAZAAR_EXTENSIONS.quick, null, 2));

const url = process.argv[2];
if (url) {
  const res = await fetch(url);
  console.log(`\nGET ${url} → ${res.status}`);
  const header = res.headers.get("payment-required");
  if (res.status !== 402 || !header) {
    console.error("✗ expected a 402 with a PAYMENT-REQUIRED header");
    process.exit(1);
  }
  const required = decodePaymentRequiredHeader(header) as {
    accepts: { network: string; asset: string; amount: string; payTo: string }[];
    extensions?: Record<string, unknown>;
  };
  for (const a of required.accepts) {
    console.log(`  accepts: ${a.network} · ${a.amount} of ${a.asset} → ${a.payTo}`);
  }
  const base = required.accepts.find((a) => a.network === "eip155:8453");
  console.log(base ? "✓ Base rail advertised (CDP settlement live)" : "○ Base rail not advertised (set BASE_PAYTO + CDP_API_KEY_ID/SECRET)");
  const wireExt = required.extensions?.bazaar;
  if (wireExt) {
    const v = validateDiscoveryExtension(wireExt as never);
    if (!v.valid) failed = true;
    console.log(`${v.valid ? "✓" : "✗"} on-the-wire bazaar extension ${v.valid ? "valid" : JSON.stringify(v)}`);
  } else {
    failed = true;
    console.error("✗ no bazaar extension in the 402");
  }
}

process.exit(failed ? 1 : 0);
