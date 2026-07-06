/**
 * erc8004-publish — publish Provenance x402 endpoint ratings on-chain via the
 * canonical ERC-8004 registries on Base mainnet.
 *
 *   pnpm tsx scripts/erc8004-publish.ts [snapshot.json] [--broadcast]
 *
 * Default mode PREPARES ONLY: builds every transaction (identity mints for
 * unregistered endpoints + one giveFeedback per rating), simulates them
 * against Base via eth_estimateGas, and prints a costed plan. Nothing is
 * signed or sent.
 *
 * --broadcast additionally requires TWO funded EOAs (the Reputation Registry
 * rejects feedback from an agent's owner/operator, so the minting wallet can
 * never be the rating wallet):
 *   ERC8004_REGISTRAR_KEY  0x-prefixed private key — mints endpoint identities
 *   ERC8004_ATTESTER_KEY   0x-prefixed private key — publishes feedback
 *
 * Env: BASE_RPC_URL (default https://mainnet.base.org)
 * State: scratch/erc8004-state.json (payTo -> agentId, dedupe of published hashes)
 *
 * See scratch/erc8004-plan.md for verified facts, costs, and the runbook.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, formatEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  IDENTITY_REGISTRY,
  REPUTATION_REGISTRY,
  BASE_CHAIN_ID,
  identityAbi,
  reputationAbi,
  emptyState,
  registrationAgentURI,
  buildFeedbacks,
  type Snapshot,
  type SnapshotRow,
  type PublishState,
  type PreparedFeedback,
} from "./lib/erc8004-core.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "scratch/erc8004-state.json");
const DEFAULT_SNAPSHOT = resolve(ROOT, "scratch/provenance-snapshot.json");

// Balance-less placeholders so eth_estimateGas works before wallets exist.
const SIM_REGISTRAR: Address = "0x1111111111111111111111111111111111111111";
const SIM_ATTESTER: Address = "0x2222222222222222222222222222222222222222";
// Conservative fallback when no live agentId is available to simulate against.
const FALLBACK_FEEDBACK_GAS = 160_000n;
const FALLBACK_REGISTER_GAS = 220_000n;

const makePublicClient = (rpcUrl: string) => createPublicClient({ chain: base, transport: http(rpcUrl) });
type BaseClient = ReturnType<typeof makePublicClient>;

interface PlannedTx {
  kind: "register" | "feedback";
  label: string;
  payTo: string;
  gas: bigint;
  estimated: boolean; // false = fallback constant, not a live simulation
}

function loadState(): PublishState {
  if (!existsSync(STATE_PATH)) return emptyState();
  const s = JSON.parse(readFileSync(STATE_PATH, "utf8")) as PublishState;
  if (s.chainId !== BASE_CHAIN_ID) throw new Error(`state file is for chain ${s.chainId}, expected Base (${BASE_CHAIN_ID})`);
  return s;
}
const saveState = (s: PublishState) => {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + "\n");
};

/** Newest Registered agentId on Base — a real token to simulate feedback against. */
async function findProbeAgentId(client: BaseClient): Promise<bigint | undefined> {
  const head = await client.getBlockNumber();
  const CHUNK = 9_999n; // public Base RPCs cap getLogs ranges around 10k blocks
  const MAX_CHUNKS = 90; // ~900k blocks ≈ 21 days of Base history
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const hi = head - CHUNK * BigInt(i);
    const lo = hi - CHUNK + 1n > 0n ? hi - CHUNK + 1n : 0n;
    if (hi <= 0n) break;
    try {
      const logs = await client.getContractEvents({
        address: IDENTITY_REGISTRY,
        abi: identityAbi,
        eventName: "Registered",
        fromBlock: lo,
        toBlock: hi,
      });
      const last = logs[logs.length - 1];
      if (last?.args.agentId !== undefined) return last.args.agentId;
    } catch {
      /* RPC range hiccup — keep walking back */
    }
  }
  return undefined;
}

/** Endpoints we refuse to mint identities for (placeholder junk on-chain). */
const isPublicUrl = (u: string): boolean => {
  try {
    const h = new URL(u).hostname;
    return h !== "localhost" && h !== "127.0.0.1" && h !== "0.0.0.0" && !h.endsWith(".local");
  } catch {
    return false;
  }
};

async function estimateRegister(client: BaseClient, from: Address, agentURI: string): Promise<{ gas: bigint; estimated: boolean }> {
  try {
    const gas = await client.estimateContractGas({
      address: IDENTITY_REGISTRY,
      abi: identityAbi,
      functionName: "register",
      args: [agentURI],
      account: from,
    });
    return { gas, estimated: true };
  } catch {
    return { gas: FALLBACK_REGISTER_GAS, estimated: false };
  }
}

async function estimateFeedback(
  client: BaseClient,
  from: Address,
  agentId: bigint | undefined,
  fb: PreparedFeedback,
): Promise<{ gas: bigint; estimated: boolean }> {
  if (agentId === undefined) return { gas: FALLBACK_FEEDBACK_GAS, estimated: false };
  try {
    const gas = await client.estimateContractGas({
      address: REPUTATION_REGISTRY,
      abi: reputationAbi,
      functionName: "giveFeedback",
      args: [agentId, fb.value, 0, fb.tag1, fb.tag2, fb.endpoint, fb.feedbackURI, fb.feedbackHash],
      account: from,
    });
    return { gas, estimated: true };
  } catch {
    return { gas: FALLBACK_FEEDBACK_GAS, estimated: false };
  }
}

async function ethUsd(): Promise<number | undefined> {
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot");
    const j = (await r.json()) as { data?: { amount?: string } };
    const n = Number(j.data?.amount);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const broadcast = args.includes("--broadcast");
  const snapshotPath = args.find((a) => !a.startsWith("--")) ?? DEFAULT_SNAPSHOT;
  const rpcUrl = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";

  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;
  const allRows = snapshot.rows.filter((r): r is SnapshotRow => Boolean(r?.payTo));
  const rows: SnapshotRow[] = [];
  for (const r of allRows) {
    const publicUrls = r.resourceUrls.filter(isPublicUrl);
    if (publicUrls.length === 0) {
      console.log(`skip ${r.payTo.slice(0, 12)}… — no publicly reachable resource URL (${r.resourceUrls[0] ?? "none"})`);
      continue;
    }
    rows.push({ ...r, resourceUrls: publicUrls });
  }
  console.log(`ERC-8004 publisher — Base mainnet (${rpcUrl})`);
  console.log(`snapshot: ${snapshotPath} (${rows.length} merchants, taken ${snapshot.takenAt})`);
  console.log(`identity  ${IDENTITY_REGISTRY}\nreputation ${REPUTATION_REGISTRY}\n`);

  const client = makePublicClient(rpcUrl);
  const chainId = await client.getChainId();
  if (chainId !== BASE_CHAIN_ID) throw new Error(`RPC is chain ${chainId}, expected Base mainnet ${BASE_CHAIN_ID}`);

  // ---- wallets ------------------------------------------------------------
  const regKey = process.env.ERC8004_REGISTRAR_KEY;
  const attKey = process.env.ERC8004_ATTESTER_KEY;
  const registrarAccount = regKey ? privateKeyToAccount(regKey as `0x${string}`) : undefined;
  const attesterAccount = attKey ? privateKeyToAccount(attKey as `0x${string}`) : undefined;
  const registrar: Address = registrarAccount?.address ?? SIM_REGISTRAR;
  const attester: Address = attesterAccount?.address ?? SIM_ATTESTER;
  if (registrar.toLowerCase() === attester.toLowerCase())
    throw new Error("registrar and attester must be DIFFERENT wallets (self-feedback is rejected on-chain)");
  if (broadcast && (!registrarAccount || !attesterAccount))
    throw new Error("--broadcast needs ERC8004_REGISTRAR_KEY and ERC8004_ATTESTER_KEY env vars");
  console.log(`registrar ${registrar}${registrarAccount ? "" : " (placeholder — no key set)"}`);
  console.log(`attester  ${attester}${attesterAccount ? "" : " (placeholder — no key set)"}\n`);

  const state = loadState();
  state.registrar = registrar;
  state.attester = attester;

  // ---- plan ---------------------------------------------------------------
  const planned: PlannedTx[] = [];
  const toRegister: { row: SnapshotRow; agentURI: string }[] = [];
  const toRate: { row: SnapshotRow; agentId: bigint | undefined; fb: PreparedFeedback }[] = [];

  const probeAgentId = await findProbeAgentId(client);
  if (probeAgentId !== undefined) console.log(`simulation probe: live agentId ${probeAgentId}\n`);

  for (const row of rows) {
    const known = state.agents[row.payTo];
    const agentId = known ? BigInt(known.agentId) : undefined;
    if (!known) toRegister.push({ row, agentURI: registrationAgentURI(row) });
    for (const fb of buildFeedbacks(row, snapshot)) {
      if (state.published[`${row.payTo}|${fb.tag1}`] === fb.feedbackHash) continue; // unchanged since last publish
      toRate.push({ row, agentId, fb });
    }
  }

  for (const r of toRegister) {
    const { gas, estimated } = await estimateRegister(client, registrar, r.agentURI);
    planned.push({ kind: "register", label: r.row.resourceUrls[0] ?? r.row.payTo.slice(0, 12), payTo: r.row.payTo, gas, estimated });
  }
  for (const t of toRate) {
    const { gas, estimated } = await estimateFeedback(client, attester, t.agentId ?? probeAgentId, t.fb);
    planned.push({
      kind: "feedback",
      label: `${t.fb.tag1}=${t.fb.value} [${t.fb.tag2}] ${t.fb.endpoint || t.row.payTo.slice(0, 12)}`,
      payTo: t.row.payTo,
      gas,
      estimated,
    });
  }

  // ---- report -------------------------------------------------------------
  const gasPrice = await client.getGasPrice();
  const totalGas = planned.reduce((a, p) => a + p.gas, 0n);
  const l2Wei = totalGas * gasPrice;
  const usd = await ethUsd();
  console.log(`plan: ${toRegister.length} identity mints + ${toRate.length} feedback txs`);
  for (const p of planned)
    console.log(`  ${p.kind.padEnd(8)} ~${String(p.gas).padStart(7)} gas${p.estimated ? "" : " (fallback)"}  ${p.label}`);
  console.log(`\ngas price ${formatEther(gasPrice, "gwei")} gwei | total ~${totalGas} gas`);
  console.log(`L2 execution cost ~${formatEther(l2Wei)} ETH${usd ? ` (~$${(Number(formatEther(l2Wei)) * usd).toFixed(4)})` : ""}`);
  console.log(`(+ Base L1 data fee, typically < 30% extra at current blob prices)\n`);

  if (!broadcast) {
    console.log("prepare-only mode — nothing sent. Re-run with --broadcast once wallets are funded.");
    saveState(state);
    return;
  }

  // ---- broadcast ----------------------------------------------------------
  const regWallet = createWalletClient({ account: registrarAccount!, chain: base, transport: http(rpcUrl) });
  const attWallet = createWalletClient({ account: attesterAccount!, chain: base, transport: http(rpcUrl) });

  for (const r of toRegister) {
    const { request } = await client.simulateContract({
      address: IDENTITY_REGISTRY,
      abi: identityAbi,
      functionName: "register",
      args: [r.agentURI],
      account: registrarAccount!,
    });
    const txHash = await regWallet.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    const ev = (
      await client.getContractEvents({
        address: IDENTITY_REGISTRY,
        abi: identityAbi,
        eventName: "Registered",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      })
    ).find((e) => e.transactionHash === txHash);
    if (ev?.args.agentId === undefined) throw new Error(`no Registered event in ${txHash}`);
    state.agents[r.row.payTo] = { agentId: ev.args.agentId.toString(), txHash, registeredAt: new Date().toISOString() };
    saveState(state);
    console.log(`registered agentId ${ev.args.agentId} for ${r.row.payTo.slice(0, 12)}… (${txHash})`);
  }

  for (const t of toRate) {
    const known = state.agents[t.row.payTo];
    if (!known) {
      console.warn(`skip feedback — no agentId for ${t.row.payTo.slice(0, 12)}…`);
      continue;
    }
    const agentId = BigInt(known.agentId);
    const selfRated = await client.readContract({
      address: IDENTITY_REGISTRY,
      abi: identityAbi,
      functionName: "isAuthorizedOrOwner",
      args: [attester, agentId],
    });
    if (selfRated) throw new Error(`attester ${attester} owns/operates agentId ${agentId} — feedback would revert`);
    const { request } = await client.simulateContract({
      address: REPUTATION_REGISTRY,
      abi: reputationAbi,
      functionName: "giveFeedback",
      args: [agentId, t.fb.value, 0, t.fb.tag1, t.fb.tag2, t.fb.endpoint, t.fb.feedbackURI, t.fb.feedbackHash],
      account: attesterAccount!,
    });
    const txHash = await attWallet.writeContract(request);
    await client.waitForTransactionReceipt({ hash: txHash });
    state.published[`${t.row.payTo}|${t.fb.tag1}`] = t.fb.feedbackHash;
    saveState(state);
    console.log(`feedback ${t.fb.tag1}=${t.fb.value} -> agentId ${agentId} (${txHash})`);
  }
  console.log("\ndone — all ratings on-chain.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
