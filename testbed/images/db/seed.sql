-- Dwara testbed seed data. Dummy lab schema only.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labapp') THEN
    CREATE ROLE labapp LOGIN PASSWORD 'labpass';
  END IF;
END
$$;

SELECT 'CREATE DATABASE labdb OWNER labapp'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'labdb')\gexec

\connect labdb

CREATE TABLE IF NOT EXISTS orders (
  id         BIGSERIAL PRIMARY KEY,
  sku        TEXT        NOT NULL,
  quantity   INTEGER     NOT NULL CHECK (quantity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE orders OWNER TO labapp;
