-- Make conversations.skill_id nullable so users can chat without a skill,
-- and attach/swap skills mid-conversation via slash commands.

PRAGMA foreign_keys=OFF;

CREATE TABLE conversations_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id    INTEGER REFERENCES skills(id) ON DELETE SET NULL,
  title       TEXT NOT NULL DEFAULT 'New chat',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO conversations_new (id, user_id, skill_id, title, created_at, updated_at)
  SELECT id, user_id, skill_id, title, created_at, updated_at FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;

CREATE INDEX idx_conversations_user  ON conversations(user_id);
CREATE INDEX idx_conversations_skill ON conversations(skill_id);

PRAGMA foreign_keys=ON;
