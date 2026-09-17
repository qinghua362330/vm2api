-- 027_user_attributes — 用户自定义属性（运营打标 + 按属性筛选）
--
-- sub2api keeps this as a definition table plus one row per value, and the value
-- is typed by the definition. That shape is worth keeping because it makes
-- "add a field" an insert rather than a migration, and lets the user list grow a
-- filter without the list query knowing about the field.
--
-- Values are stored as TEXT with a numeric mirror. Text-only would make numeric
-- range filters compare lexically ('10' < '9'), and a per-type column set would
-- make every new type a schema change.

CREATE TABLE IF NOT EXISTS user_attribute_defs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT    NOT NULL,          -- slug used by filters and the API
  name            TEXT    NOT NULL,          -- 显示名
  type            TEXT    NOT NULL DEFAULT 'text',  -- text | number | select | date | bool
  options         TEXT    NOT NULL DEFAULT '[]',    -- select 的候选值
  default_value   TEXT,
  show_in_filter  INTEGER NOT NULL DEFAULT 0,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'active', -- active | hidden
  created_at      TEXT,
  updated_at      TEXT,
  deleted_at      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_attr_defs_key_active
  ON user_attribute_defs(key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_attr_defs_status ON user_attribute_defs(status, sort_order);

CREATE TABLE IF NOT EXISTS user_attribute_values (
  user_id    TEXT    NOT NULL,
  attr_id    INTEGER NOT NULL,
  value      TEXT,
  value_num  REAL,                            -- 排序/范围比较用，非数值型为 NULL
  updated_at TEXT,
  PRIMARY KEY (user_id, attr_id)
);
CREATE INDEX IF NOT EXISTS idx_user_attr_values_attr ON user_attribute_values(attr_id, value);
CREATE INDEX IF NOT EXISTS idx_user_attr_values_num ON user_attribute_values(attr_id, value_num);
