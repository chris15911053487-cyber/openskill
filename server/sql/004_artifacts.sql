-- Chat artifacts: real files produced by an LLM tool call (run_skill).
-- Each artifact is anchored to the assistant message that produced it.
-- Files live under storage/artifacts/{relpath} on disk; this table holds the
-- metadata and the relative path so backups and downloads can find them.

CREATE TABLE artifacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  skill_slug    TEXT,                                 -- audit only
  filename      TEXT NOT NULL,                        -- original / display name
  content_type  TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  file_path     TEXT NOT NULL,                        -- relative to storage/artifacts/
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_artifacts_message ON artifacts(message_id);
