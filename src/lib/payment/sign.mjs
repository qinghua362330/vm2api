/**
 * 支付签名 — 易支付 MD5 与 Stripe webhook HMAC。
 *
 * Both verifications are intentionally offline and deterministic: a payment
 * callback is the one place where "the network said so" must never be trusted,
 * so the check has to be reproducible in a test.
 *
 * Timing-safe comparison everywhere. An `===` on a signature leaks length and
 * prefix through timing, which is enough to forge one byte at a time.
 */

import crypto from 'node:crypto'

/** Constant-time string compare that also hides length. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')
  // Hash both first: timingSafeEqual throws on length mismatch, and comparing
  // raw lengths would leak them.
  const lh = crypto.createHash('sha256').update(left).digest()
  const rh = crypto.createHash('sha256').update(right).digest()
  return crypto.timingSafeEqual(lh, rh)
}

// ── 易支付 ──────────────────────────────────────────────────────────────────

const EASYPAY_SKIP = new Set(['sign', 'sign_type'])

/**
 * 易支付签名：参数按 key 升序拼 `k=v&…`，末尾直接拼 key，再取 MD5 小写。
 * 空值不参与签名（官方实现如此，漏掉这条会算出对不上的 sign）。
 */
export function easypaySign(params = {}, key = '') {
  const pairs = Object.keys(params)
    .filter((k) => !EASYPAY_SKIP.has(k))
    .filter((k) => {
      const v = params[k]
      return v !== undefined && v !== null && String(v) !== ''
    })
    .sort()
    .map((k) => `${k}=${params[k]}`)
  return crypto
    .createHash('md5')
    .update(`${pairs.join('&')}${key}`, 'utf8')
    .digest('hex')
    .toLowerCase()
}

export function verifyEasypay(params = {}, key = '') {
  const provided = String(params?.sign || '').toLowerCase()
  if (!provided) return { ok: false, reason: 'missing_sign' }
  const expected = easypaySign(params, key)
  if (!safeEqual(provided, expected)) return { ok: false, reason: 'bad_sign' }
  return { ok: true }
}

/** 易支付要求回调返回裸 `success`，返回别的会被无限重投。 */
export const EASYPAY_ACK = 'success'

export function easypayTradeSuccess(params = {}) {
  return String(params?.trade_status || '').toUpperCase() === 'TRADE_SUCCESS'
}

// ── Stripe ──────────────────────────────────────────────────────────────────

/**
 * Parse a `Stripe-Signature` header: `t=123,v1=abc,v1=def`.
 * Stripe may send several v1 values during a secret rotation, so all are kept.
 */
export function parseStripeSignature(header = '') {
  const out = { t: null, v1: [], v0: [] }
  for (const part of String(header || '').split(',')) {
    const [rawKey, ...rest] = part.split('=')
    const key = String(rawKey || '').trim()
    const value = rest.join('=').trim()
    if (!key || !value) continue
    if (key === 't') out.t = Number(value)
    else if (key === 'v1') out.v1.push(value)
    else if (key === 'v0') out.v0.push(value)
  }
  return out
}

export function stripeSignature(payload, timestamp, secret) {
  return crypto
    .createHmac('sha256', String(secret || ''))
    .update(`${timestamp}.${payload}`, 'utf8')
    .digest('hex')
}

/**
 * Verify a Stripe webhook.
 *
 * @param {string} payload   the RAW request body — re-serialising JSON changes
 *                           the bytes and the signature will never match
 * @param {number} toleranceSec  reject timestamps older than this (replay window)
 */
export function verifyStripeSignature(payload, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  const { t, v1 } = parseStripeSignature(header)
  // `t` is null when the key is absent and NaN when it is present but not a
  // number; conflating the two made the bad_timestamp branch unreachable.
  if (t === null && !v1.length) return { ok: false, reason: 'missing_signature' }
  if (t === null) return { ok: false, reason: 'missing_timestamp' }
  if (!Number.isFinite(t)) return { ok: false, reason: 'bad_timestamp' }
  if (!v1.length) return { ok: false, reason: 'missing_signature' }

  const ageSec = Math.abs(now / 1000 - t)
  if (ageSec > toleranceSec) return { ok: false, reason: 'timestamp_out_of_tolerance', age_sec: Math.round(ageSec) }

  const expected = stripeSignature(payload, t, secret)
  const matched = v1.some((candidate) => safeEqual(candidate, expected))
  return matched ? { ok: true } : { ok: false, reason: 'bad_sign' }
}
