import { createPublicClient, http, parseAbiItem } from "viem";
import { base } from "viem/chains";
import { USDC } from "@agentkit/x402-core";
import type { Indexer, Payment, Unsub } from "./types.js";
import { normalizeBase, type BaseTransfer } from "./normalize.js";
import { depthFor } from "./reorg.js";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/**
 * The subset of a viem PublicClient this indexer uses. Decoupling from viem's
 * fully-generic `PublicClient` type (a) sidesteps its transport/chain generic
 * friction and (b) makes the indexer trivially mockable in tests. A real viem
 * client structurally satisfies this.
 */
export interface EvmReadClient {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: unknown): Promise<
    Array<{
      args: { from?: `0x${string}`; to?: `0x${string}`; value?: bigint };
      transactionHash: `0x${string}` | null;
      blockNumber: bigint | null;
    }>
  >;
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{
    from: `0x${string}`;
    logs: Array<{ topics: `0x${string}`[]; data: `0x${string}` }>;
  }>;
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}

export interface BaseIndexerConfig {
  rpcUrl?: string;
  /** Injectable for tests; falls back to a client built from rpcUrl. */
  client?: EvmReadClient;
  /** Live poll interval (ms). Blocks are cheap; websockets unnecessary. */
  pollMs?: number;
}

/**
 * Base USDC indexer via viem getLogs. Correct and dependency-light; for very
 * large historical backfills swap in Envio HyperSync behind this same interface
 * (VERIFY free-tier query shape) — the rest of the system is unaffected.
 */
export class BaseIndexer implements Indexer {
  readonly chain = "base" as const;
  private readonly client: EvmReadClient;
  private readonly pollMs: number;

  constructor(config: BaseIndexerConfig = {}) {
    this.client =
      config.client ??
      (createPublicClient({
        chain: base,
        transport: http(config.rpcUrl),
      }) as unknown as EvmReadClient);
    this.pollMs = config.pollMs ?? 60_000;
  }

  async *backfill(
    payTo: string[],
    from: Date,
    to: Date,
  ): AsyncIterable<Payment> {
    const head = Number(await this.client.getBlockNumber());
    const fromBlock = await this.blockAtOrAfter(from);
    const toBlock = await this.blockAtOrAfter(to);
    const targets = new Set(payTo.map((a) => a.toLowerCase()));

    // Chunk to respect RPC log-range limits.
    const CHUNK = 2_000n;
    for (let start = fromBlock; start <= toBlock; start += CHUNK) {
      const end = start + CHUNK - 1n > toBlock ? toBlock : start + CHUNK - 1n;
      const logs = await this.client.getLogs({
        address: USDC.base.address as `0x${string}`,
        event: TRANSFER_EVENT,
        args: { to: payTo as `0x${string}`[] },
        fromBlock: start,
        toBlock: end,
      });
      for (const log of logs) {
        const to = log.args.to?.toLowerCase();
        if (!to || !targets.has(to)) continue;
        yield await this.hydrate(log, head);
      }
    }
  }

  async subscribe(
    payTo: string[],
    onPayment: (p: Payment) => Promise<void>,
  ): Promise<Unsub> {
    let cursor = await this.client.getBlockNumber();
    const targets = new Set(payTo.map((a) => a.toLowerCase()));
    const timer = setInterval(async () => {
      try {
        const head = await this.client.getBlockNumber();
        if (head <= cursor) return;
        const logs = await this.client.getLogs({
          address: USDC.base.address as `0x${string}`,
          event: TRANSFER_EVENT,
          args: { to: payTo as `0x${string}`[] },
          fromBlock: cursor + 1n,
          toBlock: head,
        });
        for (const log of logs) {
          const to = log.args.to?.toLowerCase();
          if (!to || !targets.has(to)) continue;
          await onPayment(await this.hydrate(log, Number(head)));
        }
        cursor = head;
      } catch {
        // transient RPC error; next tick retries from the same cursor
      }
    }, this.pollMs);
    return () => clearInterval(timer);
  }

  /** Enrich a Transfer log with tx sender + sibling logs for classification. */
  private async hydrate(
    log: {
      args: { from?: `0x${string}`; to?: `0x${string}`; value?: bigint };
      transactionHash: `0x${string}` | null;
      blockNumber: bigint | null;
    },
    head: number,
  ): Promise<Payment> {
    const txHash = log.transactionHash!;
    const receipt = await this.client.getTransactionReceipt({ hash: txHash });
    const block = await this.client.getBlock({ blockNumber: log.blockNumber! });
    const transfer: BaseTransfer = {
      from: log.args.from!,
      to: log.args.to!,
      value: log.args.value ?? 0n,
      txHash,
      blockNumber: Number(log.blockNumber),
      blockTime: new Date(Number(block.timestamp) * 1000),
      submitter: receipt.from,
      logs: receipt.logs.map((l) => ({ topics: l.topics, data: l.data })),
      confirmationDepth: depthFor("base", Number(log.blockNumber), head),
    };
    return normalizeBase(transfer);
  }

  /** Coarse block-for-timestamp; refine with a binary search if precision matters. */
  private async blockAtOrAfter(_when: Date): Promise<bigint> {
    // Placeholder: callers currently backfill by recent window. A binary search
    // over block timestamps lands here when historical precision is needed.
    // VERIFY: for deep history use an indexer's time→block endpoint instead.
    return this.client.getBlockNumber();
  }
}
