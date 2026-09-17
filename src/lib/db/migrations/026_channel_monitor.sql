-- 026_channel_monitor — 渠道可用性 / 延迟历史 + 告警规则
--
-- vm2api already probes proxies (SOCKS handshake + egress check) and records
-- latency on the proxy row. That row is a snapshot: it holds the latest value and
-- nothing else, so "has this channel been flaky all morning" is unanswerable.
-- These tables keep the history, and the rules turn it into alerts.
--
-- Probes are keyed by egress_id rather than proxy id because the monitor cares
-- about the channel's reachability, and direct (host IP) buckets have no proxy
-- row at all.

CREATE TABLE IF NOT EXISTS channel_probes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  INTEGER,                 -- NULL when the bucket is in no channel
  egress_id   TEXT    NOT NULL,
  ok          INTEGER NOT NULL,
  latency_ms  INTEGER,
  status_code INTEGER,
  scope       TEXT,                    -- socks | egress | inference
  error       TEXT,
  checked_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_probes_channel ON channel_probes(channel_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_probes_egress ON channel_probes(egress_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_probes_time ON channel_probes(checked_at);

CREATE TABLE IF NOT EXISTS channel_alert_rules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  channel_id       INTEGER,             -- NULL = 所有渠道
  metric           TEXT    NOT NULL,    -- availability | latency_p95 | consecutive_failures
  comparator       TEXT    NOT NULL,    -- lt | gt
  threshold        REAL    NOT NULL,
  window_minutes   INTEGER NOT NULL DEFAULT 30,
  min_samples      INTEGER NOT NULL DEFAULT 3,   -- 样本不足不报警
  severity         TEXT    NOT NULL DEFAULT 'warn',
  enabled          INTEGER NOT NULL DEFAULT 1,
  cooldown_minutes INTEGER NOT NULL DEFAULT 30,  -- 冷却内不重复触发
  last_fired_at    TEXT,
  created_at       TEXT,
  updated_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_channel_alert_rules_enabled ON channel_alert_rules(enabled, channel_id);

-- 触发历史。冷却判断读 last_fired_at，这里保留证据链。
CREATE TABLE IF NOT EXISTS channel_alert_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id     INTEGER NOT NULL,
  channel_id  INTEGER,
  metric      TEXT    NOT NULL,
  value       REAL,
  threshold   REAL,
  severity    TEXT    NOT NULL DEFAULT 'warn',
  message     TEXT,
  fired_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_alert_events_time ON channel_alert_events(fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_alert_events_rule ON channel_alert_events(rule_id, fired_at DESC);
