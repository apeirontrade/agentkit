import type { FlowEdge } from "./types.js";

/** Union-find (disjoint set) over string node ids. */
export class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  private ensure(x: string): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }

  find(x: string): string {
    this.ensure(x);
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // path compression
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra)!;
    const rankB = this.rank.get(rb)!;
    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }

  /** Map each input node to its cluster root. */
  clustersOf(nodes: Iterable<string>): Map<string, string> {
    const out = new Map<string, string>();
    for (const n of nodes) out.set(n, this.find(n));
    return out;
  }
}

/**
 * Cluster a set of payer wallets. Two payers are unioned when they share a
 * funder, when one funded the other, or (Algorand) when they share an
 * `auth-addr` — provably the same controlling key. Returns payer → cluster-root.
 */
export function clusterPayers(
  payers: string[],
  fundingEdges: FlowEdge[] = [],
  authAddrOf: Map<string, string> = new Map(),
): Map<string, string> {
  const uf = new UnionFind();
  const payerSet = new Set(payers);
  for (const p of payers) uf.find(p); // seed singletons

  // funder → payers it funded
  const funderToPayers = new Map<string, string[]>();
  for (const e of fundingEdges) {
    if (payerSet.has(e.to)) {
      const list = funderToPayers.get(e.from) ?? [];
      list.push(e.to);
      funderToPayers.set(e.from, list);
    }
    // direct payer→payer funding also links them
    if (payerSet.has(e.from) && payerSet.has(e.to)) {
      uf.union(e.from, e.to);
    }
  }
  // shared-funder linkage
  for (const funded of funderToPayers.values()) {
    for (let i = 1; i < funded.length; i++) {
      uf.union(funded[0]!, funded[i]!);
    }
  }
  // shared auth-addr linkage (Algorand rekey Sybil signal)
  const authToPayers = new Map<string, string[]>();
  for (const p of payers) {
    const auth = authAddrOf.get(p);
    if (!auth) continue;
    const list = authToPayers.get(auth) ?? [];
    list.push(p);
    authToPayers.set(auth, list);
  }
  for (const group of authToPayers.values()) {
    for (let i = 1; i < group.length; i++) uf.union(group[0]!, group[i]!);
  }
  return uf.clustersOf(payers);
}

/**
 * Detect self-dealing: does value leaving `payTo` return to any payer within
 * `maxHops` along the payout graph? Returns the set of payers reachable from
 * payTo (i.e. money round-trips back to them).
 */
export function reachablePayers(
  payTo: string,
  payers: Set<string>,
  payoutEdges: FlowEdge[],
  maxHops = 4,
): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of payoutEdges) {
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }
  const hit = new Set<string>();
  const seen = new Set<string>([payTo]);
  let frontier = [payTo];
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const to of adj.get(node) ?? []) {
        if (payers.has(to)) hit.add(to);
        if (!seen.has(to)) {
          seen.add(to);
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  return hit;
}
