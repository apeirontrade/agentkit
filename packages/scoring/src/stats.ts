export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/** Coefficient of variation (std/mean). 0 = perfectly metronomic. */
export function coefficientOfVariation(xs: number[]): number {
  const m = mean(xs);
  if (m === 0) return 0;
  return std(xs) / m;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx]!;
}

/** Herfindahl-Hirschman index of a set of shares (each in [0,1], summing ~1). */
export function hhi(shares: number[]): number {
  return shares.reduce((a, s) => a + s * s, 0);
}

/** Revenue share per group key. Returns shares summing to 1. */
export function shares(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return values.map(() => 0);
  return values.map((v) => v / total);
}

/** Shannon entropy (normalized to [0,1]) of a discrete distribution. */
export function normalizedEntropy(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0 || counts.length <= 1) return 0;
  let h = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return h / Math.log2(counts.length);
}

const BENFORD = [
  0, 0.301, 0.176, 0.125, 0.097, 0.079, 0.067, 0.058, 0.051, 0.046,
];

/** First-significant-digit deviation from Benford's law, in [0,1] (0 = perfect fit). */
export function benfordDeviation(values: number[]): number {
  const counts = new Array(10).fill(0);
  let n = 0;
  for (const v of values) {
    const d = firstSignificantDigit(v);
    if (d >= 1) {
      counts[d]++;
      n++;
    }
  }
  if (n === 0) return 0;
  let dev = 0;
  for (let d = 1; d <= 9; d++) {
    dev += Math.abs(counts[d] / n - BENFORD[d]!);
  }
  // max possible total absolute deviation is ~2 (all mass on one non-Benford digit)
  return Math.min(1, dev / 2);
}

function firstSignificantDigit(v: number): number {
  let x = Math.abs(v);
  if (x === 0) return 0;
  while (x < 1) x *= 10;
  while (x >= 10) x /= 10;
  return Math.floor(x);
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Week index (epoch-based) for cohorting. */
export function weekIndex(d: Date): number {
  return Math.floor(d.getTime() / (7 * 24 * 3600 * 1000));
}
