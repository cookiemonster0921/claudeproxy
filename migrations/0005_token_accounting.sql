-- Separate estimated context size from provider-reported billable token usage.
-- Run locally:  npm run db:migrate5:local
-- Run remotely: npm run db:migrate5:remote

ALTER TABLE request_logs ADD COLUMN estimated_context_tokens     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN estimated_prompt_tokens      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN estimated_tool_result_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN billable_input_tokens        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN billable_output_tokens       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN cached_input_tokens          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN failed_request_tokens        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN request_kind                 TEXT;
ALTER TABLE request_logs ADD COLUMN was_retry                    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN retry_count                  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN provider_usage_json          TEXT;

UPDATE request_logs
SET estimated_context_tokens = approximate_input_tokens
WHERE estimated_context_tokens = 0 AND approximate_input_tokens > 0;

CREATE INDEX IF NOT EXISTS idx_rl_request_kind ON request_logs(request_kind);
CREATE INDEX IF NOT EXISTS idx_rl_retry        ON request_logs(was_retry);
