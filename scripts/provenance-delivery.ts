/**
 * Delivery-verification probe: pay each reachable Algorand-mainnet x402 endpoint
 * a real (capped) USDC amount and record what it actually delivers. Proves our
 * AVM payer across every live scheme variant and adds a "verified delivery"
 * dimension to Provenance — the thing settleCount can't tell you: does paying
 * actually return valid data?
 *
 *   pnpm tsx scripts/provenance-delivery.ts            # dry (quote only, no pay)
 *   pnpm tsx scripts/provenance-delivery.ts --send     # pay + verify delivery
 *
 * Our prober wallet is disclosed and excluded from all ratings (neutrality).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import algosdk from "algosdk";
import { createAvmPayer } from "@agentkit/x402-core";
import { fetchResources, distinctPayTos } from "@agentkit/provenance";

const MAX_USDC = 0.25; // per-endpoint spend cap
const SAMPLE_ADDR = "K5HIZPOUUUBQ5WJ6I3DT6NGIQUMALYJYSVVBY7CXA3BYBWY6225DNNBDSA";

function walletB64Sk(): string {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* optional */
  }
  const raw = process.env.ALGORAND_MNEMONIC;
  if (!raw) throw new Error("ALGORAND_MNEMONIC not set");
  const m = raw.replace(/[""'']/g, "").replace(/[^a-zA-Z\s]/g, " ").trim().toLowerCase().split(/\s+/).join(" ");
  return Buffer.from(algosdk.mnemonicToSecretKey(m).sk).toString("base64");
}

function reachable(url: string): boolean {
  return /^https?:\/\//.test(url) && !/localhost|127\.0\.0\.1/.test(url);
}

async function mainnetPrice(url: string): Promise<{ amount: number; payTo: string } | null> {
  const res = await fetch(url).catch(() => null);
  if (!res || res.status !== 402) return null;
  const hdr = res.headers.get("payment-required");
  if (!hdr) return null;
  const req = JSON.parse(Buffer.from(hdr, "base64").toString());
  const a = (req.accepts ?? []).find((x: { network?: string }) => x.network?.startsWith("algorand:wGHE"));
  return a ? { amount: Number(a.amount) / 1e6, payTo: a.payTo } : null;
}

async function main() {
  const send = process.argv.includes("--send");
  const payer = createAvmPayer({ base64SecretKey: walletB64Sk() });

  const resources = await fetchResources({ algorandOnly: true, limit: 200 });
  const byPayTo = distinctPayTos(resources);
  const targets = [...byPayTo.entries()]
    .map(([payTo, rs]) => ({ payTo, url: (rs.find((r) => reachable(r.resourceUrl)) ?? rs[0]!).resourceUrl }))
    .filter((t) => reachable(t.url));

  console.log(`Delivery probe — ${targets.length} reachable mainnet endpoints (cap ${MAX_USDC} USDC each)\n`);
  const results: Array<Record<string, unknown>> = [];

  for (const t of targets) {
    const url = t.url.replace(":address", SAMPLE_ADDR);
    const price = await mainnetPrice(url);
    if (!price) {
      console.log(`  ⃠  ${host(url)} — no mainnet 402 (testnet/down)`);
      results.push({ payTo: t.payTo, url, delivered: "no-mainnet-402" });
      continue;
    }
    if (price.amount > MAX_USDC) {
      console.log(`  ⃠  ${host(url)} — ${price.amount} USDC exceeds cap`);
      results.push({ payTo: t.payTo, url, priceUsdc: price.amount, delivered: "over-cap" });
      continue;
    }
    if (!send) {
      console.log(`  ·  ${host(url)} — ${price.amount} USDC (dry run, not paid)`);
      results.push({ payTo: t.payTo, url, priceUsdc: price.amount, delivered: "dry-run" });
      continue;
    }
    try {
      const res = await payer.payAndFetch(url);
      const body = await res.text();
      let valid = false;
      let snippet = body.slice(0, 140);
      try {
        const j = JSON.parse(body);
        valid = j && typeof j === "object" && Object.keys(j).length > 0;
        snippet = JSON.stringify(j).slice(0, 140);
      } catch {
        /* non-JSON */
      }
      const ok = res.status === 200 && valid;
      console.log(`  ${ok ? "✓" : "✗"}  ${host(url)} — paid ${price.amount} → HTTP ${res.status}${valid ? ", valid JSON" : ""}`);
      console.log(`       ${snippet}`);
      results.push({ payTo: t.payTo, url, priceUsdc: price.amount, httpStatus: res.status, delivered: ok, snippet });
    } catch (e) {
      console.log(`  ✗  ${host(url)} — payment/fetch failed: ${(e as Error).message.slice(0, 80)}`);
      results.push({ payTo: t.payTo, url, priceUsdc: price.amount, delivered: false, error: (e as Error).message });
    }
  }

  mkdirSync("scratch", { recursive: true });
  writeFileSync("scratch/provenance-delivery.json", JSON.stringify({ proberWallet: SAMPLE_ADDR, results }, null, 2));
  const delivered = results.filter((r) => r.delivered === true).length;
  console.log(`\n${delivered}/${results.length} endpoints delivered valid data for a real payment.`);
  console.log("→ scratch/provenance-delivery.json");
}

function host(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
