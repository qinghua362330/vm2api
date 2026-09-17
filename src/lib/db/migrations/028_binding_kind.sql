-- 028_binding_kind — 用户绑定按凭证类型分开
--
-- 背景：一个用户可能同时用 Claude 槽和 Codex 槽，而槽的 IP 是槽自己带来的
-- （proxy 绑在哪台机器上，就出哪个 IP）。如果两种凭证共用一行绑定：
--
--   * 用户原本的 Claude 出口在 IP-A，当他第一次走 Codex（Codex 槽在 IP-B）时，
--     迁移链会把 primary 改写成 IP-B —— 他的 Claude 出口跟着变了，等于偷换身份；
--   * 反过来 Claude 的故障转移也会污染 Codex 的落点。
--
-- 所以绑定必须按 kind 分开：一个用户 = 每个凭证类型一套「桶 + 槽 + 主出口」。
-- 默认值 'claude' 让既有数据与既有代码路径行为完全不变。
--
-- user_id 原本是主键，一个用户只能有一行；现在要 (user_id, kind) 两列主键，
-- SQLite 改不了主键 → 按标准做法重建表再回填。

-- ── user_egress_bindings：主出口（primary-only 镜像） ───────────────────────
ALTER TABLE user_egress_bindings RENAME TO user_egress_bindings_pre028;
CREATE TABLE user_egress_bindings (
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'claude',   -- claude | codex
  egress_id  TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT 'auto',     -- auto | admin
  bound_by   TEXT,
  bound_at   TEXT,
  updated_at TEXT,
  PRIMARY KEY (user_id, kind)
);
INSERT INTO user_egress_bindings (user_id, kind, egress_id, reason, bound_by, bound_at, updated_at)
SELECT user_id, 'claude', egress_id, reason, bound_by, bound_at, updated_at
  FROM user_egress_bindings_pre028;
DROP TABLE user_egress_bindings_pre028;
CREATE INDEX IF NOT EXISTS idx_user_egress_egress ON user_egress_bindings(egress_id);
CREATE INDEX IF NOT EXISTS idx_user_egress_kind ON user_egress_bindings(kind);

-- ── user_egress_buckets：可用出口集合（一个用户一类一张集合） ───────────────
ALTER TABLE user_egress_buckets RENAME TO user_egress_buckets_pre028;
CREATE TABLE user_egress_buckets (
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'claude',
  egress_id  TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  reason     TEXT NOT NULL DEFAULT 'auto',
  bound_by   TEXT,
  bound_at   TEXT,
  updated_at TEXT,
  PRIMARY KEY (user_id, kind, egress_id)
);
INSERT INTO user_egress_buckets (user_id, kind, egress_id, is_primary, reason, bound_by, bound_at, updated_at)
SELECT user_id, 'claude', egress_id, is_primary, reason, bound_by, bound_at, updated_at
  FROM user_egress_buckets_pre028;
DROP TABLE user_egress_buckets_pre028;
-- 每类恰好一个 primary（旧索引只管 user_id，这里补上 kind）
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_primary_bucket
  ON user_egress_buckets(user_id, kind) WHERE is_primary = 1;
CREATE INDEX IF NOT EXISTS idx_user_buckets_egress ON user_egress_buckets(egress_id);
CREATE INDEX IF NOT EXISTS idx_user_buckets_kind ON user_egress_buckets(kind, egress_id);

-- ── user_slot_bindings：当前落在哪个槽 ─────────────────────────────────────
ALTER TABLE user_slot_bindings RENAME TO user_slot_bindings_pre028;
CREATE TABLE user_slot_bindings (
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'claude',
  slot_id     TEXT NOT NULL,
  egress_id   TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT 'auto',
  migrations  INTEGER NOT NULL DEFAULT 0,
  last_reason TEXT,
  bound_by    TEXT,
  bound_at    TEXT,
  updated_at  TEXT,
  PRIMARY KEY (user_id, kind)
);
INSERT INTO user_slot_bindings (user_id, kind, slot_id, egress_id, reason, migrations, last_reason, bound_by, bound_at, updated_at)
SELECT user_id, 'claude', slot_id, egress_id, reason, migrations, last_reason, bound_by, bound_at, updated_at
  FROM user_slot_bindings_pre028;
DROP TABLE user_slot_bindings_pre028;
CREATE INDEX IF NOT EXISTS idx_user_slot_slot ON user_slot_bindings(slot_id);
CREATE INDEX IF NOT EXISTS idx_user_slot_egress ON user_slot_bindings(egress_id);
CREATE INDEX IF NOT EXISTS idx_user_slot_kind ON user_slot_bindings(kind, egress_id);

-- ── 迁移审计也带上 kind，否则控制台分不清是哪条链换的 ─────────────────────
ALTER TABLE egress_migrations ADD COLUMN kind TEXT NOT NULL DEFAULT 'claude';
CREATE INDEX IF NOT EXISTS idx_egress_migrations_kind ON egress_migrations(kind, id);
