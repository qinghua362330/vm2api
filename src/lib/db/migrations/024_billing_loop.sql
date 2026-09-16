-- 024_billing_loop — 兑换码 / 余额流水 / 订阅 / 公告
--
-- vm2api had the shape but not the loop: `users.balance` existed with nothing
-- that ever credited or debited it, `redeem_codes` existed with no service, and
-- subscriptions/announcements did not exist at all. This adds the missing half
-- of sub2api's product surface on top of vm2api's dispatch model.
--
-- Balance is only ever moved through balance_ledger (see src/lib/billing/):
-- a bare UPDATE on users.balance would leave no audit trail, and money without
-- a trail is not debuggable.

-- ── redeem_codes:多用途 / 多次使用 / 批次 ──────────────────────────────────
-- 014 gave us id/code/type/value/status/used_by/used_at/notes/expires_at.
ALTER TABLE redeem_codes ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 1;
ALTER TABLE redeem_codes ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE redeem_codes ADD COLUMN batch TEXT;
ALTER TABLE redeem_codes ADD COLUMN created_by TEXT;
CREATE INDEX IF NOT EXISTS idx_redeem_codes_batch ON redeem_codes(batch);

-- ── 余额流水：唯一改动 balance 的入口 ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS balance_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT    NOT NULL,
  delta         REAL    NOT NULL,
  balance_after REAL    NOT NULL,
  source        TEXT    NOT NULL,   -- redeem | payment | subscription | admin | usage
  ref           TEXT,               -- 兑换码 / 订单号 / 订阅 id
  notes         TEXT,
  created_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_balance_ledger_user ON balance_ledger(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_balance_ledger_source ON balance_ledger(source, created_at);

-- ── 兑换记录：一个码可能被多个人用，所以不能只存在 redeem_codes 上 ─────────
CREATE TABLE IF NOT EXISTS redeem_redemptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id    INTEGER NOT NULL,
  code       TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  value      REAL    NOT NULL DEFAULT 0,
  type       TEXT    NOT NULL DEFAULT 'balance',
  created_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_redeem_redemption_once
  ON redeem_redemptions(code_id, user_id);   -- 同一个码同一个人只能用一次
CREATE INDEX IF NOT EXISTS idx_redeem_redemption_user ON redeem_redemptions(user_id, id DESC);

-- ── 订阅：按天配额，日窗口滚动 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT    NOT NULL,
  plan         TEXT    NOT NULL DEFAULT 'standard',
  status       TEXT    NOT NULL DEFAULT 'active',   -- active | expired | revoked
  daily_quota  REAL    NOT NULL DEFAULT 0,          -- 0 = 不限制
  daily_used   REAL    NOT NULL DEFAULT 0,
  window_start TEXT,                                -- 当前日窗口起点
  starts_at    TEXT,
  expires_at   TEXT,
  notes        TEXT    NOT NULL DEFAULT '',
  created_at   TEXT,
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_expires ON subscriptions(expires_at);

-- ── 公告 ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL DEFAULT '',
  level      TEXT    NOT NULL DEFAULT 'info',       -- info | warn | critical
  status     TEXT    NOT NULL DEFAULT 'published',  -- draft | published | archived
  audience   TEXT    NOT NULL DEFAULT 'all',        -- all | role:admin | user:<id>
  pinned     INTEGER NOT NULL DEFAULT 0,
  starts_at  TEXT,
  ends_at    TEXT,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_announcements_status ON announcements(status, pinned DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_announcements_window ON announcements(starts_at, ends_at);

-- ── 审计日志 ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT,               -- panel user id / username / 'system'
  actor_role  TEXT,
  action      TEXT    NOT NULL,   -- user.update / redeem.create / channel.delete …
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT,               -- JSON, secrets already redacted by callers
  ip          TEXT,
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor, id DESC);
