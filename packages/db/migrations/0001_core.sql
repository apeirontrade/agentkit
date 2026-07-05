-- 0001_core.sql — shared foundation tables (Provenance + Jobsmith + SubLedger)
-- Corrected from the master spec draft: fixed the `BIGGENERATED` typo to
-- `BIGINT GENERATED ALWAYS AS IDENTITY`, and the partitioned `payments` PK
-- includes the partition key `block_time` (required by Postgres).

BEGIN;

DO $$ BEGIN
  CREATE TYPE chain AS ENUM ('base','solana','algorand');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE settlement_kind AS ENUM
    ('eip3009','direct','atomic_group','spl_transfer','unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Who settles x402 payments on each chain (grown empirically from submitters).
CREATE TABLE IF NOT EXISTS facilitators (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            TEXT NOT NULL,
  chain           chain NOT NULL,
  address         TEXT NOT NULL,
  settlement_kind settlement_kind NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain, address)
);

-- Every payer/receiver wallet we observe, with scoring/resolution fingerprints.
CREATE TABLE IF NOT EXISTS wallets (
  chain                   chain NOT NULL,
  address                 TEXT NOT NULL,
  first_seen              TIMESTAMPTZ,
  first_funder_addr       TEXT,
  first_funder_tx         TEXT,
  tx_count                INTEGER NOT NULL DEFAULT 0,
  distinct_tokens         INTEGER NOT NULL DEFAULT 0,
  distinct_counterparties INTEGER NOT NULL DEFAULT 0,
  cluster_id              BIGINT,
  is_facilitator          BOOLEAN NOT NULL DEFAULT FALSE,
  is_cex_labeled          BOOLEAN NOT NULL DEFAULT FALSE,
  label                   TEXT,
  PRIMARY KEY (chain, address)
);

-- x402 endpoints we track (Provenance registry; SubLedger counterparty names).
CREATE TABLE IF NOT EXISTS endpoints (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  url           TEXT,
  name          TEXT,
  chain         chain NOT NULL,
  pay_to_addr   TEXT NOT NULL,
  source        TEXT,
  category      TEXT,
  owner_contact TEXT,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (chain, pay_to_addr)
);

-- The canonical payment: one row per observed USDC transfer attributed to x402.
-- Partitioned monthly by block_time; PK must include the partition key.
CREATE TABLE IF NOT EXISTS payments (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY,
  chain              chain NOT NULL,
  tx_hash            TEXT NOT NULL,
  block_time         TIMESTAMPTZ NOT NULL,
  payer_addr         TEXT NOT NULL,
  pay_to_addr        TEXT NOT NULL,
  endpoint_id        BIGINT REFERENCES endpoints(id),
  amount_usdc        NUMERIC(20,6) NOT NULL,
  usd_value          NUMERIC(20,6),
  facilitator_id     INTEGER REFERENCES facilitators(id),
  settlement_kind    settlement_kind NOT NULL DEFAULT 'unknown',
  confirmation_depth INTEGER NOT NULL DEFAULT 0,
  raw                JSONB,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, block_time)
) PARTITION BY RANGE (block_time);

-- Default catch-all partition so inserts never fail before the monthly-partition
-- cron runs. Move rows into monthly partitions later; keep this as a backstop.
CREATE TABLE IF NOT EXISTS payments_default PARTITION OF payments DEFAULT;

CREATE INDEX IF NOT EXISTS payments_pay_to_time_idx
  ON payments (pay_to_addr, block_time);
CREATE INDEX IF NOT EXISTS payments_payer_idx ON payments (payer_addr);
CREATE INDEX IF NOT EXISTS payments_tx_hash_idx ON payments (tx_hash);
CREATE UNIQUE INDEX IF NOT EXISTS payments_dedupe_idx
  ON payments (chain, tx_hash, payer_addr, pay_to_addr, block_time);

-- Funding relationships between wallets (clustering / provenance).
CREATE TABLE IF NOT EXISTS funding_edges (
  chain         chain NOT NULL,
  from_addr     TEXT NOT NULL,
  to_addr       TEXT NOT NULL,
  first_tx_time TIMESTAMPTZ,
  total_usd     NUMERIC(20,6),
  kind          TEXT,
  PRIMARY KEY (chain, from_addr, to_addr)
);

COMMIT;
