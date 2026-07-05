import {
  pgTable,
  pgEnum,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  numeric,
  jsonb,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const chain = pgEnum("chain", ["base", "solana", "algorand"]);
export const settlementKind = pgEnum("settlement_kind", [
  "eip3009",
  "direct",
  "atomic_group",
  "spl_transfer",
  "unknown",
]);

export const facilitators = pgTable(
  "facilitators",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    name: text("name").notNull(),
    chain: chain("chain").notNull(),
    address: text("address").notNull(),
    settlementKind: settlementKind("settlement_kind").notNull(),
    active: boolean("active").notNull().default(true),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("facilitators_chain_addr_idx").on(t.chain, t.address)],
);

export const wallets = pgTable(
  "wallets",
  {
    chain: chain("chain").notNull(),
    address: text("address").notNull(),
    firstSeen: timestamp("first_seen", { withTimezone: true }),
    firstFunderAddr: text("first_funder_addr"),
    firstFunderTx: text("first_funder_tx"),
    txCount: integer("tx_count").notNull().default(0),
    distinctTokens: integer("distinct_tokens").notNull().default(0),
    distinctCounterparties: integer("distinct_counterparties").notNull().default(0),
    clusterId: bigint("cluster_id", { mode: "number" }),
    isFacilitator: boolean("is_facilitator").notNull().default(false),
    isCexLabeled: boolean("is_cex_labeled").notNull().default(false),
    label: text("label"),
  },
  (t) => [primaryKey({ columns: [t.chain, t.address] })],
);

export const endpoints = pgTable(
  "endpoints",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    url: text("url"),
    name: text("name"),
    chain: chain("chain").notNull(),
    payToAddr: text("pay_to_addr").notNull(),
    source: text("source"),
    category: text("category"),
    ownerContact: text("owner_contact"),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [uniqueIndex("endpoints_chain_payto_idx").on(t.chain, t.payToAddr)],
);

export const payments = pgTable(
  "payments",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity(),
    chain: chain("chain").notNull(),
    txHash: text("tx_hash").notNull(),
    blockTime: timestamp("block_time", { withTimezone: true }).notNull(),
    payerAddr: text("payer_addr").notNull(),
    payToAddr: text("pay_to_addr").notNull(),
    endpointId: bigint("endpoint_id", { mode: "number" }).references(() => endpoints.id),
    amountUsdc: numeric("amount_usdc", { precision: 20, scale: 6 }).notNull(),
    usdValue: numeric("usd_value", { precision: 20, scale: 6 }),
    facilitatorId: integer("facilitator_id").references(() => facilitators.id),
    settlementKind: settlementKind("settlement_kind").notNull().default("unknown"),
    confirmationDepth: integer("confirmation_depth").notNull().default(0),
    raw: jsonb("raw"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.blockTime] }),
    index("payments_pay_to_time_idx").on(t.payToAddr, t.blockTime),
    index("payments_payer_idx").on(t.payerAddr),
    index("payments_tx_hash_idx").on(t.txHash),
  ],
);

export const fundingEdges = pgTable(
  "funding_edges",
  {
    chain: chain("chain").notNull(),
    fromAddr: text("from_addr").notNull(),
    toAddr: text("to_addr").notNull(),
    firstTxTime: timestamp("first_tx_time", { withTimezone: true }),
    totalUsd: numeric("total_usd", { precision: 20, scale: 6 }),
    kind: text("kind"),
  },
  (t) => [primaryKey({ columns: [t.chain, t.fromAddr, t.toAddr] })],
);
