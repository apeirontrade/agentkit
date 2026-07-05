/**
 * Best-effort NFD (Algorand name service) reverse labeling. Most x402 merchant
 * wallets are unregistered, so this is enrichment, not a dependency — it just
 * makes reports read "mara.algo" instead of a 58-char address when a name exists.
 */
const NFD_API = "https://api.nf.domains";

export async function labelAddresses(
  addresses: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (addresses.length === 0) return out;
  // NFD batch lookup caps at 20 addresses/request.
  for (let i = 0; i < addresses.length; i += 20) {
    const batch = addresses.slice(i, i + 20);
    const qs = batch.map((a) => `address=${encodeURIComponent(a)}`).join("&");
    try {
      const res = await fetchImpl(`${NFD_API}/nfd/lookup?${qs}&view=tiny`);
      if (!res.ok) continue;
      const body = (await res.json()) as Record<string, { name?: string } | undefined>;
      for (const addr of batch) {
        const name = body[addr]?.name;
        if (name) out.set(addr, name);
      }
    } catch {
      // enrichment only — never fail the pipeline on a labeling miss
    }
  }
  return out;
}
