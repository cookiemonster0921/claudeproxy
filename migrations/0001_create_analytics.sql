-- Analytics schema for claude-proxy
-- Run locally:  npm run db:migrate:local
-- Run remotely: npm run db:migrate:remote

CREATE TABLE IF NOT EXISTS request_logs (
  id                        TEXT    PRIMARY KEY,
  timestamp                 TEXT    NOT NULL,
  method                    TEXT    NOT NULL,
  path                      TEXT    NOT NULL,
  model                     TEXT,
  provider                  TEXT,
  stream                    INTEGER NOT NULL DEFAULT 0,
  status_code               INTEGER NOT NULL,
  success                   INTEGER NOT NULL,
  duration_ms               INTEGER NOT NULL,
  approximate_input_tokens  INTEGER NOT NULL DEFAULT 0,
  approximate_output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd        REAL    NOT NULL DEFAULT 0,
  error_type                TEXT,
  fallback_used             INTEGER NOT NULL DEFAULT 0,
  user_agent                TEXT,
  client_ip_hash            TEXT
);

CREATE INDEX IF NOT EXISTS idx_rl_timestamp ON request_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_rl_model     ON request_logs(model);
CREATE INDEX IF NOT EXISTS idx_rl_provider  ON request_logs(provider);
CREATE INDEX IF NOT EXISTS idx_rl_success   ON request_logs(success);
CREATE INDEX IF NOT EXISTS idx_rl_path      ON request_logs(path);
