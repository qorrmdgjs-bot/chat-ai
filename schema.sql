-- chat-ai D1 스키마
-- 적용: npx wrangler d1 execute chat-ai-db --remote --file=schema.sql
--       npx wrangler d1 execute chat-ai-db --local  --file=schema.sql

CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   TEXT NOT NULL,
  channel   TEXT NOT NULL DEFAULT 'work',
  role      TEXT NOT NULL,
  content   TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS summaries (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                 TEXT NOT NULL,
  channel                 TEXT NOT NULL DEFAULT 'work',
  summary                 TEXT NOT NULL,
  message_count_at_update INTEGER DEFAULT 0,
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profiles (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                  TEXT NOT NULL,
  channel                  TEXT NOT NULL DEFAULT 'work',
  work_style               TEXT,
  pain_points              TEXT,
  key_topics               TEXT,
  communication_preference TEXT,
  message_count_at_update  INTEGER DEFAULT 0,
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_messages_user_channel_timestamp ON messages (user_id, channel, timestamp);
CREATE INDEX IF NOT EXISTS ix_summaries_user_channel          ON summaries (user_id, channel);
CREATE INDEX IF NOT EXISTS ix_profiles_user_channel           ON profiles  (user_id, channel);
