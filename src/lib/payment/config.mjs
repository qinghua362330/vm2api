/**
 * 支付配置 — gateways, packages, and the public (redacted) view.
 *
 * Stored as one JSON blob in `settings` under `payment_config`, the same way
 * routing.json-shaped config is stored elsewhere. Secrets never leave through
 * `publicPaymentConfig`: the console shows "已配置 / 未配置" instead of the value,
 * so a screenshot or a support session cannot leak a merchant key.
 */

import { getDb } from '../db/database.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'

export const PAYMENT_CONFIG_KEY = 'payment_config'

export const DEFAULT_PAYMENT_CONFIG = Object.freeze({
  enabled: false,
  channels: {
    easypay: {
      enabled: false,
      pid: '',
      key: '',
      submit_url: 'https://pay.example.com/submit.php',
      notify_url: '',
      return_url: '',
    },
    stripe: {
      enabled: false,
      publishable_key: '',
      secret_key: '',
      webhook_secret: '',
      currency: 'USD',
    },
  },
  /** 充值套餐：amount 是实付，credit 是到账（差额就是赠送） */
  packages: [
    { id: 'p10', name: '¥10', amount: 10, credit: 10 },
    { id: 'p50', name: '¥50', amount: 50, credit: 55 },
    { id: 'p100', name: '¥100', amount: 100, credit: 120 },
  ],
  order_ttl_minutes: 30,
  min_amount: 1,
})

/** Field names whose values must never be returned to the console. */
const SECRET_FIELDS = ['key', 'secret_key', 'webhook_secret']

function isSecretPath(path) {
  const leaf = String(path).split('.').pop()
  return SECRET_FIELDS.includes(leaf)
}

/**
 * Deep-merge a patch over the defaults, keeping unknown channel keys so a future
 * gateway's config is not silently dropped.
 */
export function mergePaymentConfig(previous = {}, patch = {}) {
  const base = normalizePaymentConfig(previous)
  if (!patch || typeof patch !== 'object') return base
  const next = { ...base }

  if (patch.enabled != null) next.enabled = patch.enabled === true
  if (patch.order_ttl_minutes != null) {
    const ttl = Number(patch.order_ttl_minutes)
    next.order_ttl_minutes = Number.isFinite(ttl) ? Math.min(24 * 60, Math.max(1, Math.round(ttl))) : base.order_ttl_minutes
  }
  if (patch.min_amount != null) {
    const min = Number(patch.min_amount)
    next.min_amount = Number.isFinite(min) && min >= 0 ? min : base.min_amount
  }
  if (Array.isArray(patch.packages)) {
    next.packages = patch.packages
      .map((p) => ({
        id: String(p?.id || '').trim(),
        name: String(p?.name || '').trim(),
        amount: Number(p?.amount) || 0,
        credit: Number(p?.credit ?? p?.amount) || 0,
      }))
      .filter((p) => p.id && p.amount > 0)
  }
  if (patch.channels && typeof patch.channels === 'object') {
    const channels = { ...next.channels }
    for (const [name, incoming] of Object.entries(patch.channels)) {
      if (!incoming || typeof incoming !== 'object') continue
      const current = channels[name] && typeof channels[name] === 'object' ? channels[name] : {}
      const merged = { ...current }
      for (const [field, value] of Object.entries(incoming)) {
        // An empty secret means "leave it alone" — otherwise saving the form
        // without retyping the key would wipe it.
        if (isSecretPath(field) && (value === '' || value == null)) continue
        merged[field] = value
      }
      channels[name] = merged
    }
    next.channels = channels
  }
  return next
}

export function normalizePaymentConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const defaults = DEFAULT_PAYMENT_CONFIG
  return {
    enabled: src.enabled === true,
    channels: {
      easypay: { ...defaults.channels.easypay, ...(src.channels?.easypay || {}) },
      stripe: { ...defaults.channels.stripe, ...(src.channels?.stripe || {}) },
    },
    packages: Array.isArray(src.packages) && src.packages.length ? src.packages : [...defaults.packages],
    order_ttl_minutes: Number(src.order_ttl_minutes) || defaults.order_ttl_minutes,
    min_amount: Number.isFinite(Number(src.min_amount)) ? Number(src.min_amount) : defaults.min_amount,
  }
}

function redact(value, path = '') {
  if (Array.isArray(value)) return value.map((item, i) => redact(item, `${path}.${i}`))
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key
    out[key] = isSecretPath(childPath) ? (item ? '__SET__' : '') : redact(item, childPath)
  }
  return out
}

/** What the console may see: secrets replaced by a set/unset marker. */
export function publicPaymentConfig(config = {}) {
  return redact(normalizePaymentConfig(config))
}

/** Which channels are actually usable right now. */
export function usableChannels(config = {}) {
  const cfg = normalizePaymentConfig(config)
  const out = []
  if (cfg.enabled && cfg.channels.easypay.enabled && cfg.channels.easypay.pid && cfg.channels.easypay.key) {
    out.push('easypay')
  }
  if (cfg.enabled && cfg.channels.stripe.enabled && cfg.channels.stripe.secret_key) out.push('stripe')
  return out
}

export class PaymentConfigStore {
  constructor(db = getDb()) {
    this.settings = new SettingsRepo(db)
  }

  get() {
    return normalizePaymentConfig(this.settings.get(PAYMENT_CONFIG_KEY, {}))
  }

  set(patch = {}) {
    const next = mergePaymentConfig(this.get(), patch)
    this.settings.set(PAYMENT_CONFIG_KEY, next)
    return next
  }
}

/** Build the 易支付 redirect URL a browser is sent to. */
export function buildEasypayRedirect({ order, config, notifyUrl, returnUrl, sign }) {
  const channel = config.channels.easypay
  const params = {
    pid: channel.pid,
    type: 'alipay',
    out_trade_no: order.order_no,
    notify_url: notifyUrl || channel.notify_url,
    return_url: returnUrl || channel.return_url,
    name: `充值 ${order.amount}`,
    money: Number(order.amount).toFixed(2),
    sign,
    sign_type: 'MD5',
  }
  const qs = new URLSearchParams(params).toString()
  const base = String(channel.submit_url || '').trim()
  return base.includes('?') ? `${base}&${qs}` : `${base}?${qs}`
}
