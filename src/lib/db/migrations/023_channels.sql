-- 023_channels — 渠道 (distribution + pricing) on top of the bucket model
--
-- sub2api's shape, kept so the mental model transfers:
--   channels              渠道:名/描述/状态/模型限制
--   channel_groups        每个分组最多属于一个渠道
--   channel_model_pricing 渠道级模型定价
--
-- What changed for this fork: a channel groups **buckets (egress/IP)**, not
-- groups, and it does NOT pick an account for a request. sub2api's distribution
-- resolves 用户 → 分组 → 账号池 → 选账号; here the channel only *bounds* the
-- buckets a request may use, and the bucket/slot/session resolution does the
-- rest (session binding > bucket preference > failover).
--
-- So a channel answers "this tenant may consume these IPs, priced like this",
-- and never "use account X for this request". That keeps one dispatch model in
-- the codebase instead of two.

CREATE TABLE IF NOT EXISTS channels (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  description     TEXT    NOT NULL DEFAULT '',
  status          TEXT    NOT NULL DEFAULT 'active',   -- active | disabled
  restrict_models INTEGER NOT NULL DEFAULT 0,
  rate_multiplier REAL    NOT NULL DEFAULT 1.0,
  created_at      TEXT,
  updated_at      TEXT,
  deleted_at      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_name_active
  ON channels(name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_channels_status ON channels(status);

-- 渠道-桶关联。A bucket belongs to at most one channel, matching sub2api's
-- "每个分组只能属于一个渠道" — otherwise pricing and restriction become
-- ambiguous for the same IP.
CREATE TABLE IF NOT EXISTS channel_buckets (
  channel_id INTEGER NOT NULL,
  egress_id  TEXT    NOT NULL,
  created_at TEXT,
  PRIMARY KEY (channel_id, egress_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_buckets_egress ON channel_buckets(egress_id);

-- 渠道模型定价：一条定价可绑定多个模型（同价）
CREATE TABLE IF NOT EXISTS channel_model_pricing (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id        INTEGER NOT NULL,
  models            TEXT    NOT NULL DEFAULT '[]',
  input_price       REAL,
  output_price      REAL,
  cache_write_price REAL,
  cache_read_price  REAL,
  per_request_price REAL,
  created_at        TEXT,
  updated_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_channel_pricing_channel ON channel_model_pricing(channel_id);

-- 用户 → 渠道。A user may reach several channels; the request's key may narrow
-- it further via api_keys.channel_id.
CREATE TABLE IF NOT EXISTS channel_users (
  channel_id INTEGER NOT NULL,
  user_id    TEXT    NOT NULL,
  created_at TEXT,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_users_user ON channel_users(user_id);

-- 密钥 → 渠道。NULL keeps the pre-channel behaviour (no narrowing).
ALTER TABLE api_keys ADD COLUMN channel_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_api_keys_channel ON api_keys(channel_id);
