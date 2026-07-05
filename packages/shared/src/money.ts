/**
 * USDC money math. USDC has 6 decimals; 1 USDC = 1_000_000 base units.
 *
 * All internal arithmetic uses BigInt on base units to avoid float drift.
 * Human-facing values are decimal strings ("1.50"), never JS numbers, except
 * where an explicit approximate USD number is requested for display.
 */

export const USDC_DECIMALS = 6;
const SCALE = 10n ** BigInt(USDC_DECIMALS); // 1_000_000n

/** Parse a decimal USDC string ("1.5", "0.000001") into base units (BigInt). */
export function parseUsdc(value: string): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`invalid USDC amount: ${value}`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const parts = unsigned.split(".");
  const whole = parts[0] ?? "0";
  const frac = parts[1] ?? "";
  if (frac.length > USDC_DECIMALS) {
    throw new Error(
      `USDC supports max ${USDC_DECIMALS} decimals, got "${value}"`,
    );
  }
  const paddedFrac = frac.padEnd(USDC_DECIMALS, "0");
  const base = BigInt(whole) * SCALE + BigInt(paddedFrac);
  return negative ? -base : base;
}

/** Format base units (BigInt) back to a canonical decimal string. */
export function formatUsdc(base: bigint): string {
  const negative = base < 0n;
  const abs = negative ? -base : base;
  const whole = abs / SCALE;
  const frac = abs % SCALE;
  const fracStr = frac.toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  const body = fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/** Add two USDC decimal strings, return a decimal string. */
export function addUsdc(a: string, b: string): string {
  return formatUsdc(parseUsdc(a) + parseUsdc(b));
}

/** Subtract b from a (both decimal strings), return a decimal string. */
export function subUsdc(a: string, b: string): string {
  return formatUsdc(parseUsdc(a) - parseUsdc(b));
}

/** Compare two USDC decimal strings. Returns -1, 0, or 1. */
export function cmpUsdc(a: string, b: string): -1 | 0 | 1 {
  const d = parseUsdc(a) - parseUsdc(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

/** True if `amount` (decimal string) exceeds `ceiling` (decimal string). */
export function exceeds(amount: string, ceiling: string): boolean {
  return cmpUsdc(amount, ceiling) > 0;
}

/**
 * Approximate USD value of a USDC amount for display/reporting only.
 * USDC is treated as $1.00 pegged; a peg factor can be supplied for audit.
 * NEVER use the returned number for on-chain amounts or ledger math.
 */
export function toUsdApprox(usdc: string, pegUsdPerUsdc = 1): number {
  return Number(usdc) * pegUsdPerUsdc;
}
