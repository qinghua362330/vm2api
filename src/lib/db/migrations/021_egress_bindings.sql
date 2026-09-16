-- 021_egress_bindings — user ↔ egress IP binding + within-egress slot migration
--
-- Model
--   Egress  = one outbound IP identity. A slot or a `direct` (host IP) entry.
--   User    = bound to ONE egress (stable: "这个用户的 IP 归属").
--   Slot    = belongs to one egress; many slots may share one egress by design.
--
-- Invariants (enforced in src/lib/pool/egress-binding.mjs + tests)
--   1. a user's slot must belong to the user's egress
--   2. migration never crosses egress — the user's IP stays stable
--   3. credential death / quota exhaustion rebuilds the slot, or moves the
--      user to another slot *inside the same egress*; the egress row never
--      changes on its own
--   4. egress changes are admin-only and audited

-- ── egress identity on proxies ──────────────────────────────────────────────
-- `direct` is the host's own IP (一槽一 VPS 时是独享出口). It is a first-class
-- egress row, not a fallback path: nothing may silently go direct.
ALTER TABLE proxies ADD COLUMN kind TEXT NOT NULL DEFAULT 'socks5';          -- direct | socks5 | http
ALTER TABLE proxies ADD COLUMN identity TEXT;                                -- direct → host public IP; proxy → host:port
ALTER TABLE proxies ADD COLUMN expires_at TEXT;                              -- NULL = never expires
ALTER TABLE proxies ADD COLUMN expiry_warn_days INTEGER NOT NULL DEFAULT 3;
ALTER TABLE proxies ADD COLUMN fallback_mode TEXT NOT NULL DEFAULT 'none';   -- none | proxy | block
ALTER TABLE proxies ADD COLUMN backup_proxy_id TEXT;

UPDATE proxies
   SET identity = host || ':' || CAST(port AS TEXT)
 WHERE identity IS NULL AND host IS NOT NULL AND port IS NOT NULL;
UPDATE proxies SET identity = id WHERE identity IS NULL;

CREATE INDEX IF NOT EXISTS idx_proxies_identity ON proxies(identity);
CREATE INDEX IF NOT EXISTS idx_proxies_expires_at ON proxies(expires_at);
CREATE INDEX IF NOT EXISTS idx_proxies_kind ON proxies(kind);

-- ── user → egress (stable IP ownership) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_egress_bindings (
  user_id    TEXT PRIMARY KEY,
  egress_id  TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT 'auto',   -- auto | admin
  bound_by   TEXT,
  bound_at   TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_egress_egress ON user_egress_bindings(egress_id);

-- ── user → slot (mutable attachment; migration rewrites this row only) ──────
CREATE TABLE IF NOT EXISTS user_slot_bindings (
  user_id     TEXT PRIMARY KEY,
  slot_id     TEXT NOT NULL,
  egress_id   TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT 'auto',  -- auto | admin | migrate
  migrations  INTEGER NOT NULL DEFAULT 0,    -- how many times this user moved
  last_reason TEXT,
  bound_by    TEXT,
  bound_at    TEXT,
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_slot_slot ON user_slot_bindings(slot_id);
CREATE INDEX IF NOT EXISTS idx_user_slot_egress ON user_slot_bindings(egress_id);

-- ── migration audit ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS egress_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  egress_id  TEXT NOT NULL,
  from_slot  TEXT,
  to_slot    TEXT,
  reason     TEXT NOT NULL,   -- credential_dead | quota_exhausted | admin | manual | no_target
  detail     TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_egress_migrations_user ON egress_migrations(user_id);
CREATE INDEX IF NOT EXISTS idx_egress_migrations_created ON egress_migrations(created_at);

-- ── backfill: existing slot ownership becomes the user's egress ────────────
-- A user owning exactly one slot inherits that slot's egress as their stable
-- binding. Users with several slots keep none (admin picks) — guessing would
-- silently pin someone to the wrong IP.
INSERT OR IGNORE INTO user_egress_bindings (user_id, egress_id, reason, bound_at, updated_at)
SELECT v.owner_user_id,
       COALESCE(NULLIF(v.proxy_id, ''), 'direct:' || v.id),
       'auto',
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM vms v
 WHERE v.owner_user_id IS NOT NULL
   AND v.owner_user_id <> ''
 GROUP BY v.owner_user_id
HAVING COUNT(*) = 1;

INSERT OR IGNORE INTO user_slot_bindings (user_id, slot_id, egress_id, reason, migrations, bound_at, updated_at)
SELECT b.user_id,
       (SELECT v.id FROM vms v
         WHERE v.owner_user_id = b.user_id
         ORDER BY v.created_at, v.id LIMIT 1),
       b.egress_id,
       'auto',
       0,
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM user_egress_bindings b
 WHERE b.reason = 'auto';
