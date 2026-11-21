-- Shared rate-limit buckets, so every API replica draws from the same budget
-- (KINGU_RATE_LIMIT_STORE=postgres). One row per credential or client IP;
-- idle rows are deleted by the pruner.
--
-- Not tenant data: keys are "req:tok:<token id>", "fail:ip:<address>" and the
-- like (hashed when long), so there is no org_id and no RLS.

-- +goose Up
CREATE TABLE rate_limits (
    key        text PRIMARY KEY CHECK (char_length(key) BETWEEN 1 AND 200),
    tokens     double precision NOT NULL,
    allowed    boolean NOT NULL,
    updated_at timestamptz NOT NULL
);
CREATE INDEX rate_limits_updated_idx ON rate_limits (updated_at);

-- +goose Down
DROP TABLE IF EXISTS rate_limits;
