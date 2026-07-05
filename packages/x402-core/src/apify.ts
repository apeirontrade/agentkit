import type { Payer } from "./payer.js";
import { APIFY } from "./constants.js";

export interface ApifyBuyerOptions {
  payer: Payer;
  /** Keep a live prepaid token with at least this USD balance available. */
  minBalanceUsd?: number;
}

export interface RunResult {
  ok: boolean;
  items: unknown[];
  costUsd?: string;
  raw?: unknown;
}

/**
 * Apify's x402 flow (confirmed 2026-07):
 *  1. POST {APIFY.prepaidTokenEndpoint}?amount=N&currency=usd  → pays via x402
 *     (USDC on Base), returns a prepaid Bearer token. Min $1; 14-day expiry;
 *     unused balance NON-REFUNDABLE → buy small tranches sized to a few days.
 *  2. Call any Actor with `Authorization: Bearer <token>`.
 *
 * This is NOT generic x402 per-call: it is prepaid-token, so `ensureToken`
 * maintains a small pool rather than paying per Actor run.
 */
export function createApifyBuyer(options: ApifyBuyerOptions): ApifyBuyer {
  return new ApifyBuyer(options.payer, options.minBalanceUsd ?? 5);
}

export class ApifyBuyer {
  private token: string | undefined;

  constructor(
    private readonly payer: Payer,
    private readonly minBalanceUsd: number,
  ) {}

  /** Buy (or reuse) a prepaid token with at least minBalanceUsd available. */
  async ensureToken(amountUsd = Math.max(this.minBalanceUsd, APIFY.minPurchaseUsd)): Promise<string> {
    if (this.token) return this.token;
    const url = `${APIFY.prepaidTokenEndpoint}?amount=${amountUsd}&currency=usd`;
    const res = await this.payer.fetchWithPayment(url, {
      maxAmountUsdc: String(amountUsd),
      init: { method: "POST" },
    });
    if (!res.ok) {
      throw new Error(`Apify prepaid-token purchase failed: ${res.status} ${await safeText(res)}`);
    }
    const body = (await res.json()) as { token?: string; prepaidToken?: string };
    const token = body.token ?? body.prepaidToken;
    if (!token) throw new Error("Apify prepaid-token response had no token field"); // VERIFY field name
    this.token = token;
    return token;
  }

  /** Run an Actor synchronously and return its dataset items. */
  async runActor(actorId: string, input: unknown, _budgetUsd: number): Promise<RunResult> {
    const token = await this.ensureToken();
    const url = APIFY.actorRunTemplate.replace("{actor}", encodeURIComponent(actorId));
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      return { ok: false, items: [], raw: await safeText(res) };
    }
    const items = (await res.json()) as unknown[];
    return { ok: true, items };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}
