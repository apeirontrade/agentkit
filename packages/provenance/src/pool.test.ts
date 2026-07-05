import { describe, it, expect } from "vitest";
import { mapPool } from "./pool.js";

describe("mapPool", () => {
  it("preserves order and maps all items", async () => {
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (x) => x * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it("bounds concurrency to the limit", async () => {
    let active = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 20 }, (_, i) => i), 4, async (x) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      return x;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("handles fewer items than the concurrency limit", async () => {
    const out = await mapPool([7], 8, async (x) => x + 1);
    expect(out).toEqual([8]);
  });
});
