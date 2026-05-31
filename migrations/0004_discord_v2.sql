-- Expand discord_sessions with effort, status, goal, threading
ALTER TABLE discord_sessions ADD COLUMN category_id   TEXT;
ALTER TABLE discord_sessions ADD COLUMN thread_id     TEXT;
ALTER TABLE discord_sessions ADD COLUMN session_id    TEXT;
ALTER TABLE discord_sessions ADD COLUMN effort_level  TEXT DEFAULT 'auto';
ALTER TABLE discord_sessions ADD COLUMN status        TEXT DEFAULT 'active';
ALTER TABLE discord_sessions ADD COLUMN goal          TEXT;
ALTER TABLE discord_sessions ADD COLUMN message_count INTEGER DEFAULT 0;

-- Expand discord_projects with full guild/project metadata
ALTER TABLE discord_projects ADD COLUMN guild_id      TEXT;
ALTER TABLE discord_projects ADD COLUMN category_id   TEXT;
ALTER TABLE discord_projects ADD COLUMN category_name TEXT;
ALTER TABLE discord_projects ADD COLUMN repo_url      TEXT;
ALTER TABLE discord_projects ADD COLUMN provider      TEXT;
ALTER TABLE discord_projects ADD COLUMN system_prompt TEXT;
ALTER TABLE discord_projects ADD COLUMN budget_usd    REAL DEFAULT 0;

-- Expand discord_messages with session ref and privacy support
ALTER TABLE discord_messages ADD COLUMN session_id         TEXT;
ALTER TABLE discord_messages ADD COLUMN discord_message_id TEXT;
ALTER TABLE discord_messages ADD COLUMN content_hash       TEXT;

-- Add Discord source tracking columns to request_logs
ALTER TABLE request_logs ADD COLUMN source             TEXT;
ALTER TABLE request_logs ADD COLUMN discord_guild_id   TEXT;
ALTER TABLE request_logs ADD COLUMN discord_channel_id TEXT;
ALTER TABLE request_logs ADD COLUMN discord_command    TEXT;

CREATE INDEX IF NOT EXISTS idx_request_logs_source ON request_logs(source);
