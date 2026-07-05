import { pino, type Logger } from "pino";

/**
 * Structured logger (pino). Sentry wiring is intentionally deferred: call
 * `attachSentry(dsn)` from an app entrypoint once @sentry/node is installed
 * there. Keeping the dependency out of the shared package avoids forcing Sentry
 * into every consumer (e.g. CLI scripts, tests).
 */
export function createLogger(
  name: string,
  level: string = process.env.LOG_LEVEL ?? "info",
): Logger {
  return pino({
    name,
    level,
    base: undefined, // drop pid/hostname noise
  });
}

export type { Logger };
