-- Discord project settings (one row per named project)
CREATE TABLE IF NOT EXISTS discord_projects (
  project_name  TEXT PRIMARY KEY,
  default_model TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-channel sessions
CREATE TABLE IF NOT EXISTS discord_sessions (
  channel_id     TEXT PRIMARY KEY,
  guild_id       TEXT,
  project_name   TEXT,
  model_override TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Conversation message history per channel session
CREATE TABLE IF NOT EXISTS discord_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  timestamp  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_discord_messages_channel ON discord_messages(channel_id, id DESC);
