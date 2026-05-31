-- Add content snapshot columns (first 200 chars of prompt/response/tool calls)
-- Run locally:  npm run db:migrate2:local
-- Run remotely: npm run db:migrate2:remote
-- Existing rows get NULL — no retroactive data backfill needed.

ALTER TABLE request_logs ADD COLUMN prompt_snapshot   TEXT;
ALTER TABLE request_logs ADD COLUMN response_snapshot TEXT;
ALTER TABLE request_logs ADD COLUMN tool_snapshot     TEXT;
