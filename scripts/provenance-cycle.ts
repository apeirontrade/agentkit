/**
 * One full Provenance monitoring cycle: re-snapshot the live registry, score +
 * wash-risk + drift every endpoint, then anchor the new snapshot's hash on
 * Algorand. Run on a schedule (launchd) to build the tamper-evident time-series
 * that shows organic-vs-wash revenue evolving through the Challenge window.
 *
 *   pnpm tsx scripts/provenance-cycle.ts            # snapshot only
 *   pnpm tsx scripts/provenance-cycle.ts --anchor   # snapshot + on-chain anchor
 *
 * Anchoring loads the wallet read-only from gitignored .env; never prints it.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import algosdk from "algosdk";
import { snapshotRegistry } from "@agentkit/provenance";

const ALGOD = "https://mainnet-api.4160.nodely.dev";

async function anchor(snapshotBytes: Buffer, takenAt: string, rows: number): Promise<string> {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* optional */
  }
  const raw = process.env.ALGORAND_MNEMONIC;
  if (!raw) throw new Error("ALGORAND_MNEMONIC not set");
  const mnemonic = raw.replace(/[""'']/g, "").replace(/[^a-zA-Z\s]/g, " ").trim().toLowerCase().split(/\s+/).join(" ");
  const acct = algosdk.mnemonicToSecretKey(mnemonic);
  const addr = acct.addr.toString();

  const digest = createHash("sha256").update(snapshotBytes).digest("hex");
  const note = new TextEncoder().encode(`PROV1|${takenAt}|rows=${rows}|sha256=${digest}`);
  const algod = new algosdk.Algodv2("", ALGOD, "");
  const sp = await algod.getTransactionParams().do();
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: addr,
    receiver: addr,
    amount: 0,
    note,
    suggestedParams: sp,
  });
  const { txid } = await algod.sendRawTransaction(txn.signTxn(acct.sk)).do();
  await algosdk.waitForConfirmation(algod, txid, 6);
  return txid;
}

async function main() {
  const doAnchor = process.argv.includes("--anchor");
  const now = new Date();
  console.log(`[${now.toISOString()}] Provenance cycle starting…`);

  const snap = await snapshotRegistry({ windowDays: 400, now, onProgress: (m) => console.log("  · " + m) });
  const bytes = Buffer.from(JSON.stringify(snap, null, 2));

  mkdirSync("scratch/history", { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  writeFileSync(`scratch/history/snapshot-${stamp}.json`, bytes);
  writeFileSync("scratch/provenance-snapshot.json", bytes); // latest, for the leaderboard

  const counts = { low: 0, medium: 0, high: 0, critical: 0 } as Record<string, number>;
  for (const r of snap.rows) counts[r.washLevel] = (counts[r.washLevel] ?? 0) + 1;
  console.log(`  ${snap.rows.length} endpoints · wash: ${counts.critical}C/${counts.high}H/${counts.medium}M/${counts.low}L`);

  if (doAnchor) {
    const txid = await anchor(bytes, snap.takenAt.toISOString(), snap.rows.length);
    console.log(`  anchored on-chain: ${txid}`);
    console.log(`  https://allo.info/tx/${txid}`);
  } else {
    console.log("  (snapshot saved; pass --anchor to also anchor on-chain)");
  }
  console.log(`[${new Date().toISOString()}] cycle complete.`);
}

main().catch((e) => {
  console.error("cycle error:", e);
  process.exit(1);
});
