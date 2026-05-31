-- Cloud session continuation state for /cloudrun and /agent commands.
-- Stores per-channel session IDs and conversation summaries so runs can be resumed.
-- Run locally:  npm run db:migrate6:local
-- Run remotely: npm run db:migrate6:remote

CREATE TABLE IF NOT EXISTS cloud_sessions (
  channel_id      TEXT PRIMARY KEY,
  -- Cloud Run container sessions
  cr_session_id   TEXT,           -- claude --resume <id>
  cr_summary      TEXT,           -- last ~500 chars of output for cross-instance context
  cr_updated_at   TEXT,
  -- Cloudflare Workflow / GoalAgent sessions
  wf_messages     TEXT,           -- JSON array of last N AnthropicMessage turns
  wf_updated_at   TEXT
);
