/**
 * Thin pg-boss wrapper so every long-lived worker shares one Postgres-backed
 * queue rather than adding a second datastore. Jobsmith's orchestrator uses
 * Inngest (durable step functions justify that exception); everything else —
 * indexer batches, nightly scoring, sync retries — rides pg-boss.
 *
 * pg-boss is a peer concern of each worker app; this module defines the typed
 * surface and defers the concrete import to keep @agentkit/shared dependency-light.
 * Install `pg-boss` in the consuming app and pass the instance to `makeQueue`.
 */

export interface JobQueue {
  send<T>(name: string, data: T, opts?: { startAfterSec?: number }): Promise<string | null>;
  work<T>(name: string, handler: (data: T) => Promise<void>): Promise<void>;
  schedule(name: string, cron: string, data?: unknown): Promise<void>;
  stop(): Promise<void>;
}

/** Minimal structural type of the pg-boss instance we rely on. */
export interface PgBossLike {
  start(): Promise<unknown>;
  send(name: string, data: unknown, opts?: Record<string, unknown>): Promise<string | null>;
  work(name: string, handler: (job: { data: unknown }) => Promise<void>): Promise<string>;
  schedule(name: string, cron: string, data?: unknown): Promise<void>;
  stop(opts?: Record<string, unknown>): Promise<void>;
}

export function makeQueue(boss: PgBossLike): JobQueue {
  return {
    async send(name, data, opts) {
      const bossOpts = opts?.startAfterSec
        ? { startAfter: opts.startAfterSec }
        : undefined;
      return boss.send(name, data as unknown, bossOpts);
    },
    async work(name, handler) {
      await boss.work(name, (job) => handler(job.data as never));
    },
    async schedule(name, cron, data) {
      await boss.schedule(name, cron, data);
    },
    async stop() {
      await boss.stop();
    },
  };
}
