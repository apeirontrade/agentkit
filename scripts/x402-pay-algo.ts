/**
 * Make a REAL x402 payment to a live Algorand mainnet endpoint via GoPlausible.
 * Proves the AVM payer path end-to-end (the Algorand equivalent of ticket 5).
 *
 *   pnpm tsx scripts/x402-pay-algo.ts <url>        # SIMULATE-ish: builds payment, does NOT send unless --send
 *   pnpm tsx scripts/x402-pay-algo.ts <url> --send # actually pay (spends real USDC, ~$0.05)
 *
 * Loads the wallet read-only from gitignored .env; never prints the mnemonic.
 */
import algosdk from "algosdk";
import { x402Client, x402HTTPClient } from "@x402-avm/core/client";
import { toClientAvmSigner } from "@x402-avm/avm";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/client";

function loadSk(): { addr: string; b64sk: string } {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* optional */
  }
  const raw = process.env.ALGORAND_MNEMONIC;
  if (!raw) throw new Error("ALGORAND_MNEMONIC not set");
  const mnemonic = raw
    .replace(/[""'']/g, "")
    .replace(/[^a-zA-Z\s]/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .join(" ");
  const acct = algosdk.mnemonicToSecretKey(mnemonic);
  return { addr: acct.addr.toString(), b64sk: Buffer.from(acct.sk).toString("base64") };
}

async function main() {
  const url = process.argv[2];
  const send = process.argv.includes("--send");
  if (!url) {
    console.log("usage: pnpm tsx scripts/x402-pay-algo.ts <url> [--send]");
    return;
  }

  const { addr, b64sk } = loadSk();
  console.log("payer wallet:", addr);
  console.log("target:", url, "\n");

  // Inspect the 402 challenge first (no payment).
  const probe = await fetch(url);
  if (probe.status === 402) {
    const hdr = probe.headers.get("payment-required");
    if (hdr) {
      const req = JSON.parse(Buffer.from(hdr, "base64").toString());
      const algo = (req.accepts ?? []).find((a: { network?: string }) =>
        a.network?.startsWith("algorand:wGHE"),
      );
      if (algo) {
        console.log(
          `price: ${Number(algo.amount) / 1e6} USDC → ${algo.payTo.slice(0, 12)}…  (asset ${algo.asset})`,
        );
      } else {
        console.log("⚠ no Algorand MAINNET payment option on this endpoint — aborting.");
        return;
      }
    }
  } else {
    console.log(`endpoint returned ${probe.status} (not a 402) — nothing to pay.`);
    return;
  }

  if (!send) {
    console.log("\n(DRY RUN — inspected the 402 but did not pay. Re-run with --send to pay.)");
    return;
  }

  const signer = toClientAvmSigner(b64sk);
  const client = new x402Client();
  // Pin the client to MAINNET algod so suggested-params carry the mainnet
  // genesis hash (default fell back to testnet → genesis-hash mismatch).
  // Pass a URL (not an algosdk instance) so the SDK builds its own compatible client.
  registerExactAvmScheme(client, {
    signer,
    algodConfig: { algodUrl: "https://mainnet-api.4160.nodely.dev" },
  });
  const http = new x402HTTPClient(client);

  console.log("\n→ building + signing payment…");
  // Re-read the 402 (fresh challenge), parse it, build the signed payment header.
  const challenge = await fetch(url);
  const chalBodyText = await challenge.text();
  const paymentRequired = http.getPaymentRequiredResponse(
    (n) => challenge.headers.get(n),
    chalBodyText ? JSON.parse(chalBodyText || "{}") : undefined,
  );
  console.log(
    "  parsed accepts:",
    (paymentRequired.accepts ?? []).map((a: { network?: string; asset?: string }) => `${a.network?.slice(0, 18)}…/${a.asset}`).join("  "),
  );
  // Call the lower-level path directly so real errors surface (handlePaymentRequired swallows them).
  const payload = await http.createPaymentPayload(paymentRequired);
  const payHeaders = http.encodePaymentSignatureHeader(payload);
  console.log("  payment header keys:", Object.keys(payHeaders).join(", "));

  console.log("→ settling on-chain + fetching resource…");
  const res = await fetch(url, { headers: payHeaders });
  console.log("HTTP", res.status);
  if (res.status === 402) {
    const err = res.headers.get("payment-required") || res.headers.get("x-payment-error") || res.headers.get("x-payment-response");
    if (err) {
      try {
        console.log("  server said:", JSON.stringify(JSON.parse(Buffer.from(err, "base64").toString())).slice(0, 300));
      } catch {
        console.log("  server error header:", err.slice(0, 200));
      }
    }
  }
  try {
    const settle = http.getPaymentSettleResponse((n) => res.headers.get(n));
    console.log("settlement:", JSON.stringify(settle).slice(0, 260));
  } catch {
    /* settlement header may be absent on some servers */
  }
  const body = await res.text();
  console.log("resource:", body.slice(0, 500));
  if (res.ok) console.log("\n🎉 real x402 payment settled on Algorand mainnet. AVM payer proven.");
}

main().catch((e) => {
  console.error("payment error:", e?.message ?? e);
  process.exit(1);
});
