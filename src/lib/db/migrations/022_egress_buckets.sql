-- 022_egress_buckets — a user may hold several buckets; a session pins to one
--
-- Model
--   user    ──N──► bucket (egress/IP)     admin-visible set the user may use
--   session ──1──► slot  (via sticky_sessions)  a conversation keeps its credential
--
-- Why a session binding and a user binding are different things:
--   The user binding decides which IP a user *may* come from. It must be stable
--   so the account does not appear to roam. A session binding decides which
--   credential serves one conversation. It must be stable for prompt-cache
--   continuity, and because one conversation_id appearing under two accounts is
--   a cross-account link.
--
-- So: a user with a single bucket behaves exactly as before (one IP). A user
-- with several buckets spreads conversations across them, and each conversation
-- stays inside the bucket it started in.

-- ── buckets: N egresses per user, one primary ───────────────────────────────
CREATE TABLE IF NOT EXISTS user_egress_buckets (
  user_id    TEXT NOT NULL,
  egress_id  TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  reason     TEXT NOT NULL DEFAULT 'auto',   -- auto | admin
  bound_by   TEXT,
  bound_at   TEXT,
  updated_at TEXT,
  PRIMARY KEY (user_id, egress_id)
);
-- exactly one primary per user: the IP a new session prefers
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_primary_bucket
  ON user_egress_buckets(user_id) WHERE is_primary = 1;
CREATE INDEX IF NOT EXISTS idx_user_buckets_egress ON user_egress_buckets(egress_id);

-- The single binding from 021 becomes the primary bucket. Kept as its own table
-- rather than dropped: user_egress_bindings stays the primary-only view that the
-- migration/dashboard paths already read, and the two are written together.
INSERT OR IGNORE INTO user_egress_buckets (user_id, egress_id, is_primary, reason, bound_by, bound_at, updated_at)
SELECT user_id, egress_id, 1, reason, bound_by, bound_at, updated_at
  FROM user_egress_bindings;

-- ── session bindings gain the tenant and the egress ─────────────────────────
-- sticky_sessions already pins a conversation key to a slot; these columns let
-- the scheduler check the pin against the user's buckets and let the console
-- show which IP a conversation is on.
ALTER TABLE sticky_sessions ADD COLUMN user_id TEXT;
ALTER TABLE sticky_sessions ADD COLUMN egress_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sticky_user ON sticky_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sticky_egress ON sticky_sessions(egress_id);
