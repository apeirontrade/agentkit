import raw from "../data/facilitators.json" with { type: "json" };

export type Chain = "base" | "solana" | "algorand";
export type SettlementKind =
  | "eip3009"
  | "direct"
  | "atomic_group"
  | "spl_transfer"
  | "unknown";

export interface Facilitator {
  name: string;
  chain: Chain;
  settlement_kind: SettlementKind;
  addresses: string[];
  verified: boolean;
  docs: string;
}

const facilitators: Facilitator[] = raw.facilitators as Facilitator[];

/** Case-insensitive address → facilitator lookup, indexed once at load. */
const byAddress = new Map<string, Facilitator>();
for (const f of facilitators) {
  for (const addr of f.addresses) {
    byAddress.set(key(f.chain, addr), f);
  }
}

function key(chain: Chain, address: string): string {
  return `${chain}:${address.toLowerCase()}`;
}

export function lookupFacilitator(
  chain: Chain,
  address: string,
): Facilitator | undefined {
  return byAddress.get(key(chain, address));
}

export function isFacilitatorAddress(chain: Chain, address: string): boolean {
  return byAddress.has(key(chain, address));
}

export function facilitatorsForChain(chain: Chain): Facilitator[] {
  return facilitators.filter((f) => f.chain === chain);
}

export function allFacilitators(): Facilitator[] {
  return facilitators;
}
