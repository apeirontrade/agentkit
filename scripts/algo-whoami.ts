/**
 * Safely verify the configured Algorand wallet: derives ONLY the public address
 * and reads its on-chain balance. Never prints, logs, or transmits the mnemonic.
 *
 *   pnpm algo:whoami
 */
import algosdk from "algosdk";

const INDEXER = "https://mainnet-idx.4160.nodely.dev";
const USDC_ASA = 31566704;

async function main() {
  try {
    process.loadEnvFile(".env");
  } catch {
    // .env optional; mnemonic may be exported directly
  }
  const rawMnemonic = process.env.ALGORAND_MNEMONIC;
  if (!rawMnemonic || rawMnemonic.trim() === "") {
    console.log("ALGORAND_MNEMONIC not set in ~/agentkit/.env — nothing to verify.");
    return;
  }
  // Sanitize common paste artifacts (smart quotes, punctuation, case, extra spaces)
  // WITHOUT ever printing the words themselves.
  const mnemonic = rawMnemonic
    .replace(/[""'']/g, "")
    .replace(/[^a-zA-Z\s]/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .join(" ");
  const words = mnemonic.split(" ").filter(Boolean);

  let addr: string;
  try {
    addr = algosdk.mnemonicToSecretKey(mnemonic).addr.toString();
  } catch (e) {
    // Safe diagnostics only — never echo the words.
    const wordlist: string[] = (algosdk as unknown as { _wordlist?: string[] })._wordlist ?? [];
    const invalidCount = wordlist.length
      ? words.filter((w) => !wordlist.includes(w)).length
      : "unknown";
    console.error(
      `could not derive address. Word count: ${words.length} (expected 25). ` +
        `Words not in the Algorand wordlist: ${invalidCount}. ` +
        `Error: ${(e as Error).message}`,
    );
    console.error(
      "Check ~/agentkit/.env line 41: the phrase should be exactly 25 lowercase words " +
        "separated by single spaces, no quotes or punctuation. TextEdit sometimes autocorrects — " +
        "paste as plain text (Edit ▸ Paste and Match Style).",
    );
    process.exit(1);
  }

  console.log("Algorand wallet (public address):");
  console.log("  " + addr);

  try {
    const res = await fetch(`${INDEXER}/v2/accounts/${addr}`);
    if (!res.ok) {
      console.log(`  (indexer ${res.status} — account may be brand new / unfunded)`);
      return;
    }
    const body = (await res.json()) as {
      account?: { amount?: number; "total-assets-opted-in"?: number; assets?: Array<{ "asset-id": number; amount: number }> };
    };
    const a = body.account ?? {};
    const algo = (a.amount ?? 0) / 1e6;
    const usdc = (a.assets ?? []).find((x) => x["asset-id"] === USDC_ASA);
    console.log(`  ALGO balance:   ${algo}`);
    console.log(`  USDC balance:   ${usdc ? usdc.amount / 1e6 : "0 (not opted in)"}`);
    console.log(`  assets opted-in: ${a["total-assets-opted-in"] ?? 0}`);
    console.log(
      algo > 0
        ? "\n✓ wallet is funded and ready."
        : "\n⏸ address derived OK but ALGO balance is 0 — fund it to transact.",
    );
  } catch (e) {
    console.log("  (could not reach indexer: " + (e as Error).message + ")");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
