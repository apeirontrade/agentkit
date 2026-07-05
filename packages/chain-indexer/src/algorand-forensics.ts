import { USDC } from "@agentkit/x402-core";
import { NODELY_MAINNET_INDEXER } from "./algorand.js";

/**
 * Wallet forensics over the Algorand indexer — the per-wallet metadata the
 * Provenance scoring engine needs (age, funder, asset diversity) and the
 * outbound flow edges self-dealing detection needs. Read-only; Nodely free tier.
 *
 * Verified live (2026-07) field names:
 *   GET /v2/accounts/{addr}          → account.created-at-round,
 *                                       account.total-assets-opted-in, auth-addr
 *   GET /v2/blocks/{round}           → timestamp (round → unix seconds)
 *   GET /v2/accounts/{addr}/transactions?address-role=receiver&min-round=…
 *                                     → earliest inbound tx sender = first funder
 */
export interface AlgorandForensicsConfig {
  indexerUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface AccountMeta {
  firstSeen?: Date;
  distinctTokens?: number; // total-assets-opted-in
  firstFunder?: string;
  isRekeyed: boolean; // auth-addr present → key control delegated (a wash tell)
  authAddr?: string; // the shared controlling key, for rekey-Sybil clustering
}

export interface FlowEdge {
  from: string;
  to: string;
}

export class AlgorandForensics {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private blockTimeCache = new Map<number, number>();

  constructor(config: AlgorandForensicsConfig = {}) {
    this.baseUrl = (config.indexerUrl ?? NODELY_MAINNET_INDEXER).replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`indexer ${res.status} for ${path}`);
    return (await res.json()) as T;
  }

  private async blockTime(round: number): Promise<number | undefined> {
    if (this.blockTimeCache.has(round)) return this.blockTimeCache.get(round);
    try {
      const b = await this.getJson<{ timestamp?: number }>(`/v2/blocks/${round}`);
      if (b.timestamp) this.blockTimeCache.set(round, b.timestamp);
      return b.timestamp;
    } catch {
      return undefined;
    }
  }

  /** Full per-wallet metadata: age, asset diversity, first funder, rekey status. */
  async accountMeta(address: string): Promise<AccountMeta> {
    const acct = await this.getJson<{
      account?: {
        "created-at-round"?: number;
        "total-assets-opted-in"?: number;
        "auth-addr"?: string;
      };
    }>(`/v2/accounts/${address}`);
    const a = acct.account ?? {};
    const createdRound = a["created-at-round"];
    const meta: AccountMeta = {
      distinctTokens: a["total-assets-opted-in"],
      isRekeyed: Boolean(a["auth-addr"]),
      authAddr: a["auth-addr"],
    };
    if (createdRound !== undefined) {
      const ts = await this.blockTime(createdRound);
      if (ts) meta.firstSeen = new Date(ts * 1000);
      meta.firstFunder = await this.firstFunder(address, createdRound);
    }
    return meta;
  }

  /** Earliest inbound payment/asset-transfer sender near account creation. */
  async firstFunder(address: string, createdRound: number): Promise<string | undefined> {
    const page = await this.getJson<{
      transactions?: Array<{ sender?: string; "round-time"?: number }>;
    }>(
      `/v2/accounts/${address}/transactions?address-role=receiver` +
        `&min-round=${createdRound}&max-round=${createdRound + 1000}&limit=10`,
    );
    const txns = (page.transactions ?? []).filter((t) => t["round-time"] !== undefined);
    txns.sort((x, y) => (x["round-time"] ?? 0) - (y["round-time"] ?? 0));
    return txns[0]?.sender;
  }

  /** Outbound USDC transfers FROM an address (payout edges for cycle detection). */
  async outboundEdges(
    address: string,
    from: Date,
    to: Date,
    maxPages = 5,
  ): Promise<FlowEdge[]> {
    const edges: FlowEdge[] = [];
    let next: string | undefined;
    let pages = 0;
    do {
      const url =
        `/v2/accounts/${address}/transactions?address-role=sender` +
        `&after-time=${from.toISOString()}&before-time=${to.toISOString()}` +
        (next ? `&next=${next}` : "");
      const page = await this.getJson<{
        transactions?: Array<{
          "asset-transfer-transaction"?: { receiver?: string; "asset-id"?: number };
        }>;
        "next-token"?: string;
      }>(url);
      for (const t of page.transactions ?? []) {
        const ax = t["asset-transfer-transaction"];
        if (ax && String(ax["asset-id"]) === USDC.algorand.address && ax.receiver) {
          edges.push({ from: address, to: ax.receiver });
        }
      }
      next = page["next-token"];
      pages++;
    } while (next && pages < maxPages);
    return edges;
  }
}
