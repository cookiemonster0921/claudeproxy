-- Fix: make discord_messages.content nullable to support privacy mode
-- (storeMessages=false stores a hash instead of content; the NOT NULL was wrong)
-- SQLite can't DROP CONSTRAINT, so we recreate the table.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS discord_messages_new (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id         TEXT NOT NULL,
  role               TEXT NOT NULL,
  content            TEXT,                                -- nullable: NULL when privacy mode
  timestamp          TEXT NOT NULL DEFAULT (datetime('now')),
  session_id         TEXT,
  discord_message_id TEXT,
  content_hash       TEXT
);

INSERT INTO discord_messages_new
  (id, channel_id, role, content, timestamp, session_id, discord_message_id, content_hash)
SELECT
  id, channel_id, role, content, timestamp, session_id, discord_message_id, content_hash
FROM discord_messages;

DROP TABLE discord_messages;

ALTER TABLE discord_messages_new RENAME TO discord_messages;

CREATE INDEX IF NOT EXISTS idx_discord_messages_channel
  ON discord_messages(channel_id, id DESC);

PRAGMA foreign_keys = ON;
