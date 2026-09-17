-- 025_payments — 充值订单 (支付回调驱动的余额入账)
--
-- sub2api ships four gateways; this fork starts with 易支付 (MD5 sign, the common
-- Chinese aggregator) and Stripe (HMAC webhook), both of which can be verified
-- offline. 支付宝/微信官方 need merchant certificates, so their config slots
-- exist but no adapter claims them yet.
--
-- The order row is the source of truth for "may this payment credit a balance",
-- which is why it carries its own amount AND credit: a package can grant bonus
-- balance, and the callback amount must match the order amount, not the credit.

CREATE TABLE IF NOT EXISTS payment_orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no          TEXT    NOT NULL UNIQUE,
  user_id           TEXT    NOT NULL,
  channel           TEXT    NOT NULL,                 -- easypay | stripe | manual
  amount            REAL    NOT NULL,                 -- 应付金额
  currency          TEXT    NOT NULL DEFAULT 'CNY',
  credit            REAL    NOT NULL,                 -- 实际入账余额（可含赠送）
  status            TEXT    NOT NULL DEFAULT 'pending', -- pending | paid | failed | expired | refunded
  package_id        TEXT,                             -- 套餐 id（若有）
  provider_trade_no TEXT,                             -- 上游流水号
  paid_at           TEXT,
  expires_at        TEXT,
  notify_json       TEXT,                             -- 回调原文（已剔除密钥）
  fail_reason       TEXT,
  created_at        TEXT,
  updated_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON payment_orders(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_payment_orders_expires ON payment_orders(expires_at);

-- 每个订单最多入账一次。回调会重试，网关也会重复投递；没有这条约束，
-- 一次网络重试就是一次重复充值。
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_paid_once
  ON payment_orders(order_no) WHERE status = 'paid';
