import { z } from "zod";

/**
 * Zod-validated environment loader. Each app calls `loadEnv(schema)` with the
 * subset of variables it needs, so a missing secret fails fast at boot with a
 * clear message rather than surfacing as an undefined deep in a request.
 */
export function loadEnv<T extends z.ZodRawShape>(
  shape: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<z.ZodObject<T>> {
  const parsed = z.object(shape).safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}

/** Common building blocks reused across app env schemas. */
export const envParts = {
  databaseUrl: z.string().url(),
  logLevel: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  bool: (def: boolean) =>
    z
      .enum(["true", "false"])
      .default(def ? "true" : "false")
      .transform((v) => v === "true"),
  usdcAmount: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, "must be a USDC decimal (<=6 dp)"),
} as const;
