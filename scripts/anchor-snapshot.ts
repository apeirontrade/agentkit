/**
 * Anchor a Provenance snapshot on Algorand: hash the snapshot and write the
 * digest into a 0-amount self-payment's note field, so the leaderboard's state
 * at a point in time is tamper-evident and independently verifiable by anyone —
 * without trusting our database.
 *
 *   pnpm tsx scripts/anchor-snapshot.ts            # SIMULATE only (no spend)
 *   pnpm tsx scripts/anchor-snapshot.ts --send     # broadcast (spends ~0.001 ALGO fee)
 *
 * Never prints the mnemonic; loads it read-only from gitignored .env.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import algosdk from "algosdk";

const ALGOD = "https://mainnet-api.4160.nodely.dev";
const SNAPSHOT = "scratch/provenance-snapshot.json";

function loadAccount(): algosdk.Account {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* optional */
  }
  const raw = process.env.ALGORAND_MNEMONIC;
  if (!raw) throw new Error("ALGORAND_MNEMONIC not set in .env");
  const mnemonic = raw
    .replace(/[""'']/g, "")
    .replace(/[^a-zA-Z\s]/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .join(" ");
  return algosdk.mnemonicToSecretKey(mnemonic);
}

async function main() {
  const send = process.argv.includes("--send");
  const acct = loadAccount();
  const addr = acct.addr.toString();

  const snapshotRaw = readFileSync(SNAPSHOT);
  const digest = createHash("sha256").update(snapshotRaw).digest("hex");
  const snap = JSON.parse(snapshotRaw.toString());
  // Structured, self-describing note: scheme:version:takenAt:rows:sha256
  const note = new TextEncoder().encode(
    `PROV1|${snap.takenAt}|rows=${snap.rows.length}|sha256=${digest}`,
  );

  const algod = new algosdk.Algodv2("", ALGOD, "");
  const sp = await algod.getTransactionParams().do();

  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: addr,
    receiver: addr, // anchor to self — 0 ALGO moved, only the fee is spent
    amount: 0,
    note,
    suggestedParams: sp,
  });

  console.log("Provenance snapshot anchor");
  console.log("  wallet:   ", addr);
  console.log("  snapshot: ", SNAPSHOT, `(${snapshotRaw.length} bytes, ${snap.rows.length} endpoints)`);
  console.log("  sha256:   ", digest);
  console.log("  note:     ", new TextDecoder().decode(note));
  console.log("  fee:      ", Number(sp.fee || 1000) / 1e6, "ALGO");

  // Always simulate first — verifies correctness before any spend.
  const signed = txn.signTxn(acct.sk);
  const sim = await algod
    .simulateRawTransactions([signed])
    .do()
    .catch((e: unknown) => ({ error: (e as Error).message }));
  const failed = (sim as { txnGroups?: Array<{ failureMessage?: string }> }).txnGroups?.[0]?.failureMessage;
  if ("error" in (sim as object) || failed) {
    console.error("\n✗ simulation failed:", failed ?? (sim as { error?: string }).error);
    process.exit(1);
  }
  console.log("\n✓ simulation OK — transaction is valid.");

  if (!send) {
    console.log("\n(DRY RUN — nothing broadcast. Re-run with --send to anchor on-chain.)");
    return;
  }

  const { txid } = await algod.sendRawTransaction(signed).do();
  console.log("\n→ broadcasting…  txid:", txid);
  const conf = await algosdk.waitForConfirmation(algod, txid, 6);
  console.log("✓ anchored in round", conf.confirmedRound);
  console.log("  explorer: https://allo.info/tx/" + txid);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
