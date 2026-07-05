/**
 * Provenance ORQ scoring demo. Scores two synthetic Algorand endpoints — one
 * organic, one wash — and prints the grade, ORQ, confidence interval, every
 * subscore, and the human-readable evidence flags. Shows the product working
 * without any chain access. Pure logic; run: pnpm tsx scripts/scoring-demo.ts
 */
import { scoreEndpoint, type ScoringInput, type PaymentRecord, type FlowEdge, type WalletMeta } from "@agentkit/scoring";

function rng32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const START = new Date("2026-05-01T00:00:00Z").getTime();
const DAY = 86_400_000;

function organic(): ScoringInput {
  const rng = rng32(42);
  const payers = Array.from({ length: 60 }, (_, i) => `O${i}`);
  const wm: Record<string, WalletMeta> = {};
  for (const p of payers) wm[p] = { firstSeen: new Date(START - (30 + rng() * 400) * DAY), distinctTokens: 3 + Math.floor(rng() * 12), distinctCounterparties: 5 + Math.floor(rng() * 25) };
  const amts = [0.05, 0.1, 0.25, 0.4, 0.75, 1.2, 2.5, 3.33, 4.9];
  const pays: PaymentRecord[] = [];
  for (let i = 0; i < 130; i++) pays.push({ payer: payers[Math.floor(rng() * 60)]!, amountUsdc: String(amts[Math.floor(rng() * amts.length)]), blockTime: new Date(START + rng() * 42 * DAY), txHash: `o${i}` });
  return { endpointId: "organic-demo", payTo: "OSELL", windowStart: new Date(START), windowEnd: new Date(START + 42 * DAY), payments: pays, walletMeta: wm };
}
function wash(): ScoringInput {
  const payers = Array.from({ length: 30 }, (_, i) => `W${i}`);
  const funders = Array.from({ length: 15 }, (_, i) => `F${i}`);
  const wm: Record<string, WalletMeta> = {}; const fe: FlowEdge[] = []; const pe: FlowEdge[] = [];
  for (let i = 0; i < 30; i++) { const p = payers[i]!; const f = funders[Math.floor(i / 2)]!; wm[p] = { firstSeen: new Date(START - 0.2 * DAY), firstFunder: f, distinctTokens: 1, distinctCounterparties: 1 }; fe.push({ from: f, to: p }); pe.push({ from: f, to: p }); }
  for (const f of funders) pe.push({ from: "WSELL", to: f });
  const pays: PaymentRecord[] = []; const iv = (28 * DAY) / 120;
  for (let i = 0; i < 120; i++) pays.push({ payer: payers[i % 30]!, amountUsdc: i % 10 === 0 ? String(0.02 + (i % 5) * 0.01) : "0.01", blockTime: new Date(START + i * iv), txHash: `w${i}`, group: "G" });
  return { endpointId: "wash-demo", payTo: "WSELL", windowStart: new Date(START), windowEnd: new Date(START + 28 * DAY), payments: pays, walletMeta: wm, fundingEdges: fe, payoutEdges: pe };
}

for (const [name, inp] of [["ORGANIC", organic()], ["WASH", wash()]] as const) {
  const r = scoreEndpoint(inp, { bootstrapRounds: 300, seed: 1 });
  console.log(`\n${name}  →  grade ${r.grade}   ORQ ${r.orq}  (CI ${r.ciLow}–${r.ciHigh})   ${r.nPayments} payments / ${r.nPayerClusters} clusters`);
  console.log("  " + Object.entries(r.subscores).map(([k, v]) => `${k}=${v.value.toFixed(2)}${v.dataBacked ? "" : "*"}`).join("  "));
  if (r.flags.length) for (const f of r.flags.slice(0, 5)) console.log("   • " + f);
}
console.log("\n(* = signal ran on absent/optional data; methodology v0.1)");
