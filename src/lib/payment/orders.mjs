/**
 * 充值订单 — create, then credit exactly once.
 *
 * The two ways a payment system loses money, both handled here:
 *
 *   1. Crediting twice. Gateways retry callbacks and users refresh the return
 *      URL. `markPaid` is idempotent on order_no: a second successful callback
 *      reports `already_paid` and credits nothing.
 *   2. Crediting the wrong amount. The callback carries what was actually paid;
 *      it must match the order, or the credit is refused. Trusting the callback
 *      amount would let a ¥1 payment settle a ¥100 order.
 *
 * Money only moves through BalanceLedger, same as redeem and admin adjustment.
 */

import crypto from 'node:crypto'
import { getDb, withTransaction } from '../db/database.mjs'
import { BalanceLedger } from '../billing/balance-ledger.mjs'

export const ORDER_STATUSES = Object.freeze(['pending', 'paid', 'failed', 'expired', 'refunded'])
export const PAYMENT_CHANNELS = Object.freeze(['easypay', 'stripe', 'manual'])
export const DEFAULT_ORDER_TTL_MS = 30 * 60 * 1000

function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString()
}

function rowToOrder(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    order_no: row.order_no,
    user_id: row.user_id,
    channel: row.channel,
    amount: Number(row.amount) || 0,
    currency: row.currency || 'CNY',
    credit: Number(row.credit) || 0,
    status: row.status || 'pending',
    package_id: row.package_id ?? null,
    provider_trade_no: row.provider_trade_no ?? null,
    paid_at: row.paid_at ?? null,
    expires_at: row.expires_at ?? null,
    notify_json: row.notify_json ?? null,
    fail_reason: row.fail_reason ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  }
}

/** Order number: time-ordered so a support conversation can sort by it. */
export function newOrderNo({ now = Date.now(), randomBytes = crypto.randomBytes } = {}) {
  const stamp = new Date(now).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  return `P${stamp}${randomBytes(4).toString('hex').toUpperCase()}`
}

/** Amounts are compared as integers of 1e-6 to survive float noise. */
function sameAmount(a, b) {
  return Math.round(Number(a) * 1e6) === Math.round(Number(b) * 1e6)
}

export class OrderService {
  constructor(db = getDb()) {
    this.db = db
    this.ledger = new BalanceLedger(db)
    this._insert = db.prepare(`
      INSERT INTO payment_orders
        (order_no, user_id, channel, amount, currency, credit, status, package_id, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `)
    this._get = db.prepare('SELECT * FROM payment_orders WHERE order_no = ?')
    this._markPaid = db.prepare(`
      UPDATE payment_orders
         SET status = 'paid', provider_trade_no = ?, paid_at = ?, notify_json = ?, updated_at = ?
       WHERE order_no = ? AND status = 'pending'
    `)
    this._markFailed = db.prepare(
      "UPDATE payment_orders SET status = ?, fail_reason = ?, updated_at = ? WHERE order_no = ? AND status = 'pending'",
    )
    this._expireDue = db.prepare(
      "UPDATE payment_orders SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?",
    )
    this._list = db.prepare('SELECT * FROM payment_orders ORDER BY id DESC LIMIT ?')
    this._listByUser = db.prepare('SELECT * FROM payment_orders WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    this._listByStatus = db.prepare(
      'SELECT * FROM payment_orders WHERE status = ? ORDER BY id DESC LIMIT ?',
    )
    this._sumByStatus = db.prepare(
      'SELECT status, COUNT(*) AS n, SUM(amount) AS amount, SUM(credit) AS credit FROM payment_orders GROUP BY status',
    )
  }

  create({
    userId,
    channel = 'easypay',
    amount,
    credit = null,
    currency = 'CNY',
    packageId = null,
    ttlMs = DEFAULT_ORDER_TTL_MS,
    now = Date.now(),
  } = {}) {
    const uid = String(userId || '').trim()
    if (!uid) return { ok: false, reason: 'user_required' }
    const pay = Number(amount)
    if (!Number.isFinite(pay) || pay <= 0) return { ok: false, reason: 'amount_required' }
    if (!PAYMENT_CHANNELS.includes(channel)) return { ok: false, reason: 'invalid_channel' }
    const granted = credit == null ? pay : Number(credit)
    if (!Number.isFinite(granted) || granted < 0) return { ok: false, reason: 'invalid_credit' }

    const orderNo = newOrderNo({ now })
    const stamp = nowIso(now)
    this._insert.run(
      orderNo,
      uid,
      channel,
      pay,
      String(currency || 'CNY'),
      granted,
      packageId,
      nowIso(now + Math.max(60_000, Number(ttlMs) || DEFAULT_ORDER_TTL_MS)),
      stamp,
      stamp,
    )
    return { ok: true, order: this.get(orderNo) }
  }

  get(orderNo) {
    const raw = String(orderNo || '').trim()
    if (!raw) return null
    return rowToOrder(this._get.get(raw))
  }

  /**
   * Settle a payment. Idempotent: a repeated callback for an already-paid order
   * succeeds without crediting again.
   *
   * @param {number} paidAmount what the gateway says was actually paid
   */
  markPaid({ orderNo, providerTradeNo = null, paidAmount = null, raw = null, now = Date.now() } = {}) {
    const no = String(orderNo || '').trim()
    if (!no) return { ok: false, reason: 'order_required' }
    const order = this.get(no)
    if (!order) return { ok: false, reason: 'order_not_found' }

    // Idempotency first: a retry is the normal case, not an error.
    if (order.status === 'paid') return { ok: true, alreadyPaid: true, order }
    if (order.status !== 'pending') return { ok: false, reason: `order_${order.status}`, order }

    const expires = Date.parse(order.expires_at || '')
    if (Number.isFinite(expires) && expires <= now) {
      this._markFailed.run('expired', 'paid after expiry', nowIso(now), no)
      return { ok: false, reason: 'order_expired', order: this.get(no) }
    }

    if (paidAmount != null && !sameAmount(paidAmount, order.amount)) {
      // Do not settle, and do not silently accept the larger/smaller figure.
      this._markFailed.run('failed', `amount mismatch: paid ${paidAmount} vs order ${order.amount}`, nowIso(now), no)
      return { ok: false, reason: 'amount_mismatch', expected: order.amount, received: Number(paidAmount), order: this.get(no) }
    }

    return withTransaction(this.db, () => {
      const marked = this._markPaid.run(
        providerTradeNo == null ? null : String(providerTradeNo),
        nowIso(now),
        raw == null ? null : String(raw).slice(0, 4000),
        nowIso(now),
        no,
      )
      // Lost the race to a concurrent callback: the other one credited.
      if (!marked.changes) return { ok: true, alreadyPaid: true, order: this.get(no) }

      const credited = this.ledger.credit({
        userId: order.user_id,
        amount: order.credit,
        source: 'payment',
        ref: no,
        notes: `${order.channel} 充值`,
      })
      if (!credited.ok) {
        // The row says paid but the money did not land. Roll the status back so
        // a retry can still settle it, and say so loudly.
        this.db
          .prepare("UPDATE payment_orders SET status = 'pending', fail_reason = ?, updated_at = ? WHERE order_no = ?")
          .run(`credit failed: ${credited.reason}`, nowIso(now), no)
        return { ok: false, reason: `credit_failed:${credited.reason}`, order: this.get(no) }
      }
      return { ok: true, credited: order.credit, balance: credited.balance, order: this.get(no) }
    })
  }

  fail(orderNo, reason = 'gateway rejected', { now = Date.now() } = {}) {
    const no = String(orderNo || '').trim()
    if (!no) return { ok: false, reason: 'order_required' }
    const changed = this._markFailed.run('failed', String(reason).slice(0, 500), nowIso(now), no).changes
    return { ok: changed > 0, order: this.get(no) }
  }

  expireDue(now = Date.now()) {
    return { expired: this._expireDue.run(nowIso(now), nowIso(now)).changes }
  }

  list({ userId = null, status = null, limit = 100, now = Date.now() } = {}) {
    this.expireDue(now)
    const n = Math.max(1, Math.min(1000, Number(limit) || 100))
    if (userId) return this._listByUser.all(String(userId), n).map(rowToOrder)
    if (status) return this._listByStatus.all(String(status), n).map(rowToOrder)
    return this._list.all(n).map(rowToOrder)
  }

  totals(now = Date.now()) {
    this.expireDue(now)
    const out = {}
    for (const row of this._sumByStatus.all()) {
      out[row.status] = {
        count: Number(row.n) || 0,
        amount: Number(row.amount) || 0,
        credit: Number(row.credit) || 0,
      }
    }
    return out
  }
}
