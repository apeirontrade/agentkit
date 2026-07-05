import { x402Client, x402HTTPClient } from "@x402-avm/core/client";
import { toClientAvmSigner } from "@x402-avm/avm";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/client";

/** Nodely mainnet algod — pins suggested-params to the mainnet genesis hash. */
export const ALGORAND_MAINNET_ALGOD = "https://mainnet-api.4160.nodely.dev";
export const ALGORAND_MAINNET_CAIP2 =
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";

export interface AvmPayerOptions {
  /** Base64-encoded 64-byte Algorand secret key (seed+pubkey). */
  base64SecretKey: string;
  /** Algod URL; defaults to Nodely mainnet. MUST match the payment network. */
  algodUrl?: string;
}

export interface AvmPayer {
  readonly address: string;
  /** GET a resource, paying an x402 challenge via GoPlausible if one is returned. */
  payAndFetch(url: string, init?: RequestInit): Promise<Response>;
}

/**
 * The Algorand (AVM) x402 payer — proven end-to-end on mainnet via GoPlausible.
 * Builds the atomic group (facilitator fee-payer + our USDC transfer), signs our
 * half, and lets the facilitator co-sign + settle. Verified 2026-07-05.
 *
 * NOTE: the algod URL must match the payment's network or settlement fails with
 * "genesis hash does not match expected network".
 */
export function createAvmPayer(opts: AvmPayerOptions): AvmPayer {
  const signer = toClientAvmSigner(opts.base64SecretKey);
  const client = new x402Client();
  registerExactAvmScheme(client, {
    signer,
    algodConfig: { algodUrl: opts.algodUrl ?? ALGORAND_MAINNET_ALGOD },
  });
  const http = new x402HTTPClient(client);

  return {
    address: signer.address,
    async payAndFetch(url, init) {
      const challenge = await fetch(url, init);
      if (challenge.status !== 402) return challenge;
      const text = await challenge.text();
      const paymentRequired = http.getPaymentRequiredResponse(
        (n) => challenge.headers.get(n),
        text ? JSON.parse(text || "{}") : undefined,
      );
      const payload = await http.createPaymentPayload(paymentRequired);
      const payHeaders = http.encodePaymentSignatureHeader(payload);
      return fetch(url, {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), ...payHeaders },
      });
    },
  };
}
