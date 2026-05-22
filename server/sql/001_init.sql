-- OpenSkill initial schema (SQLite).
-- All timestamps stored as ISO-8601 TEXT via datetime('now').

-- ============================================================================
-- Users
-- ============================================================================
CREATE TABLE users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL UNIQUE,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'user'
                  CHECK (role IN ('admin', 'user')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_users_role ON users(role);

-- ============================================================================
-- Categories & Tags
-- ============================================================================
CREATE TABLE categories (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- Skills (one row per published/pending/rejected skill, latest version only)
-- ============================================================================
CREATE TABLE skills (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT NOT NULL UNIQUE,           -- url-safe identifier
  name              TEXT NOT NULL,                  -- from SKILL.md frontmatter
  description       TEXT NOT NULL,                  -- from SKILL.md frontmatter
  readme_excerpt    TEXT,                           -- first ~500 chars of SKILL.md body
  author_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id       INTEGER REFERENCES categories(id) ON DELETE SET NULL,

  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'published', 'rejected')),
  rejection_reason  TEXT,

  version           TEXT,                           -- from manifest.json (optional)
  file_path         TEXT NOT NULL,                  -- relative path under storage/
  file_size         INTEGER NOT NULL,
  sha256            TEXT NOT NULL,

  manifest_json     TEXT,                           -- merged frontmatter + manifest.json
  skill_md_content  TEXT,                           -- full SKILL.md (frontmatter + body) for preview
  file_tree_json    TEXT,                           -- JSON array of {path,size,type}

  download_count     INTEGER NOT NULL DEFAULT 0,
  subscriber_count   INTEGER NOT NULL DEFAULT 0,

  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  published_at      TEXT
);

CREATE INDEX idx_skills_status     ON skills(status);
CREATE INDEX idx_skills_author     ON skills(author_user_id);
CREATE INDEX idx_skills_category   ON skills(category_id);
CREATE INDEX idx_skills_created_at ON skills(created_at);

-- ============================================================================
-- skill_tags (many-to-many)
-- ============================================================================
CREATE TABLE skill_tags (
  skill_id  INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags(id)   ON DELETE CASCADE,
  PRIMARY KEY (skill_id, tag_id)
);

CREATE INDEX idx_skill_tags_tag ON skill_tags(tag_id);

-- ============================================================================
-- Subscriptions
-- ============================================================================
CREATE TABLE subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  skill_id    INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, skill_id)
);

CREATE INDEX idx_subscriptions_user  ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_skill ON subscriptions(skill_id);

-- ============================================================================
-- Download logs (kept for stats and future audit; aggregated count cached on skills)
-- ============================================================================
CREATE TABLE download_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id)  ON DELETE SET NULL,
  skill_id    INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_download_logs_skill ON download_logs(skill_id);
CREATE INDEX idx_download_logs_user  ON download_logs(user_id);

-- ============================================================================
-- Audit logs (admin moderation actions)
-- ============================================================================
CREATE TABLE audit_logs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action           TEXT NOT NULL,                 -- e.g. 'approve_skill', 'reject_skill'
  target_skill_id  INTEGER REFERENCES skills(id) ON DELETE SET NULL,
  note             TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_logs_actor  ON audit_logs(actor_user_id);
CREATE INDEX idx_audit_logs_target ON audit_logs(target_skill_id);
