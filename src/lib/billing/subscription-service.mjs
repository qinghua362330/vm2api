/**
 * 订阅 — timed plans with a rolling daily quota.
 *
 * One active subscription per user, and granting extends rather than stacks.
 * Two active rows would silently double a user's daily quota and make
 * "remaining today" ambiguous, which is exactly the sort of thing that only
 * shows up as a billing dispute later.
 *
 * The daily window is a rolling 24h from the window's first use, not a midnight
 * reset: every user resetting at the same instant is a thundering herd, and a
 * rolling window is what vm2api's own 5h/7d quota windows already do.
 *
 * `daily_quota = 0` means unlimited — the column comment in 024 says so and this
 * service is the only thing that interprets it.
 */

import { getDb, withTransaction } from '../db/database.mjs'

export const SUBSCRIPTION_STATUSES = Object.freeze(['active', 'expired', 'revoked'])
export const DAY_MS = 24 * 60 * 60 * 1000

function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString()
}

function rowToSub(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    user_id: row.user_id,
    plan: row.plan || 'standard',
    status: row.status || 'active',
    daily_quota: Number(row.daily_quota) || 0,
    daily_used: Number(row.daily_used) || 0,
    window_start: row.window_start ?? null,
    starts_at: row.starts_at ?? null,
    expires_at: row.expires_at ?? null,
    notes: row.notes || '',
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  }
}

/** State of a subscription's day window at `now`, without mutating anything. */
export function windowState(sub, now = Date.now()) {
  if (!sub) return { open: false, reason: 'no_subscription' }
  if (sub.status !== 'active') return { open: false, reason: sub.status }
  const expires = Date.parse(sub.expires_at || '')
  if (Number.isFinite(expires) && expires <= now) return { open: false, reason: 'expired' }

  const unlimited = !(Number(sub.daily_quota) > 0)
  const started = Date.parse(sub.window_start || '')
  const rolled = !Number.isFinite(started) || now - started >= DAY_MS
  const used = rolled ? 0 : Number(sub.daily_used) || 0
  const quota = Number(sub.daily_quota) || 0
  const remaining = unlimited ? Infinity : Math.max(0, quota - used)
  return {
    open: true,
    unlimited,
    quota,
    used,
    remaining,
    rolled,
    window_start: rolled ? nowIso(now) : sub.window_start,
    resets_at: unlimited || rolled ? null : nowIso(started + DAY_MS),
  }
}

export class SubscriptionService {
  constructor(db = getDb()) {
    this.db = db
    this._list = db.prepare('SELECT * FROM subscriptions ORDER BY id DESC')
    this._get = db.prepare('SELECT * FROM subscriptions WHERE id = ?')
    this._activeOf = db.prepare(
      "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
    )
    this._allOf = db.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC')
    this._insert = db.prepare(`
      INSERT INTO subscriptions
        (user_id, plan, status, daily_quota, daily_used, window_start, starts_at, expires_at, notes, created_at, updated_at)
      VALUES (?, ?, 'active', ?, 0, NULL, ?, ?, ?, ?, ?)
    `)
    this._extend = db.prepare(`
      UPDATE subscriptions
         SET expires_at = ?, daily_quota = ?, plan = ?, notes = ?, updated_at = ?
       WHERE id = ?
    `)
    this._setStatus = db.prepare('UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ?')
    this._setWindow = db.prepare(
      'UPDATE subscriptions SET daily_used = ?, window_start = ?, updated_at = ? WHERE id = ?',
    )
    this._update = db.prepare(`
      UPDATE subscriptions
         SET plan = ?, daily_quota = ?, expires_at = ?, notes = ?, status = ?, updated_at = ?
       WHERE id = ?
    `)
    this._expireDue = db.prepare(
      "UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?",
    )
  }

  list() {
    return this._list.all().map(rowToSub)
  }

  get(id) {
    if (id == null) return null
    return rowToSub(this._get.get(Number(id)))
  }

  allOf(userId) {
    const uid = String(userId || '').trim()
    if (!uid) return []
    return this._allOf.all(uid).map(rowToSub)
  }

  /** The user's live subscription, expiring it first if its date has passed. */
  activeOf(userId, now = Date.now()) {
    const uid = String(userId || '').trim()
    if (!uid) return null
    const sub = rowToSub(this._activeOf.get(uid))
    if (!sub) return null
    const expires = Date.parse(sub.expires_at || '')
    if (Number.isFinite(expires) && expires <= now) {
      this._setStatus.run('expired', nowIso(now), sub.id)
      return null
    }
    return sub
  }

  /**
   * Grant days to a user, extending an existing active subscription.
   * Extending is what makes "再兑换 30 天" behave the way a user expects.
   */
  grant({ userId, plan = 'standard', days = 30, dailyQuota = 0, notes = '', now = Date.now() } = {}) {
    const uid = String(userId || '').trim()
    if (!uid) return { ok: false, reason: 'user_required' }
    const span = Number(days)
    if (!Number.isFinite(span) || span <= 0) return { ok: false, reason: 'days_required' }
    const quota = Number(dailyQuota) || 0

    return withTransaction(this.db, () => {
      const existing = this.activeOf(uid, now)
      if (existing) {
        // Extend from whichever is later: the current expiry (so days are not
        // lost) or now.
        const base = Math.max(Date.parse(existing.expires_at || '') || 0, now)
        const expiresAt = nowIso(base + span * DAY_MS)
        this._extend.run(
          expiresAt,
          quota > 0 ? quota : existing.daily_quota,
          plan || existing.plan,
          notes || existing.notes,
          nowIso(now),
          existing.id,
        )
        return { ok: true, extended: true, subscription: this.get(existing.id) }
      }
      const info = this._insert.run(
        uid,
        plan || 'standard',
        quota,
        nowIso(now),
        nowIso(now + span * DAY_MS),
        notes,
        nowIso(now),
        nowIso(now),
      )
      return { ok: true, extended: false, subscription: this.get(info.lastInsertRowid) }
    })
  }

  update(id, patch = {}, { now = Date.now() } = {}) {
    const current = this.get(id)
    if (!current) return null
    this._update.run(
      patch.plan == null ? current.plan : String(patch.plan),
      patch.daily_quota == null ? current.daily_quota : Number(patch.daily_quota) || 0,
      patch.expires_at === undefined ? current.expires_at : patch.expires_at,
      patch.notes == null ? current.notes : String(patch.notes),
      patch.status == null
        ? current.status
        : SUBSCRIPTION_STATUSES.includes(patch.status)
          ? patch.status
          : current.status,
      nowIso(now),
      Number(id),
    )
    return this.get(id)
  }

  revoke(id, { now = Date.now() } = {}) {
    const current = this.get(id)
    if (!current) return { ok: false, reason: 'not_found' }
    this._setStatus.run('revoked', nowIso(now), Number(id))
    return { ok: true, subscription: this.get(id) }
  }

  /** Mark every subscription whose date has passed as expired. */
  sweepExpired(now = Date.now()) {
    return { expired: this._expireDue.run(nowIso(now), nowIso(now)).changes }
  }

  /** Current allowance for a user, rolling the window if it has elapsed. */
  usage(userId, now = Date.now()) {
    const sub = this.activeOf(userId, now)
    if (!sub) return { active: false, reason: 'no_subscription' }
    const state = windowState(sub, now)
    if (state.rolled) {
      this._setWindow.run(0, state.window_start, nowIso(now), sub.id)
    }
    return { active: true, subscription: sub, ...state }
  }

  /**
   * Charge `amount` against the day window.
   *
   * @returns {{ok:boolean, reason?:string, remaining?:number}}
   */
  consume({ userId, amount = 1, now = Date.now() } = {}) {
    const uid = String(userId || '').trim()
    if (!uid) return { ok: false, reason: 'user_required' }
    const cost = Number(amount)
    if (!Number.isFinite(cost) || cost <= 0) return { ok: false, reason: 'amount_required' }

    return withTransaction(this.db, () => {
      const sub = this.activeOf(uid, now)
      if (!sub) return { ok: false, reason: 'no_subscription' }
      const state = windowState(sub, now)
      if (!state.open) return { ok: false, reason: state.reason }
      if (state.unlimited) {
        this._setWindow.run(0, state.window_start, nowIso(now), sub.id)
        return { ok: true, unlimited: true, remaining: Infinity }
      }
      if (cost > state.remaining) {
        return { ok: false, reason: 'quota_exceeded', remaining: state.remaining, resets_at: state.resets_at }
      }
      const used = state.used + cost
      this._setWindow.run(used, state.window_start, nowIso(now), sub.id)
      return { ok: true, used, remaining: Math.max(0, state.quota - used), resets_at: state.resets_at }
    })
  }

  /** Console view: subscriptions with their live window attached. */
  overview(now = Date.now()) {
    this.sweepExpired(now)
    return this.list().map((sub) => ({
      ...sub,
      window: windowState(sub, now),
      days_left: sub.expires_at
        ? Math.max(0, Math.ceil((Date.parse(sub.expires_at) - now) / DAY_MS))
        : null,
    }))
  }
}
