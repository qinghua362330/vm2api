/**
 * 审计日志 — who changed what, written at the mutation site.
 *
 * Two rules make this useful rather than decorative:
 *
 *   1. **Redaction happens here, not at the call site.** A caller passing the
 *      whole request body is the normal case (and the one that leaks), so the
 *      redactor is a safety net on the way in, not a convention callers are
 *      trusted to follow. `password`, `key`, `secret_key`, `webhook_secret`,
 *      `token`, `sign` and friends become `[redacted]` by key name.
 *
 *   2. **Recording never throws.** An audit write that fails must not fail the
 *      operation it was describing — the user's action already happened, and
 *      turning a full disk into a failed payment is worse than a missing row.
 *      Failures are logged loudly instead, and `record` reports `{ok:false}` so
 *      a caller that cares can see it.
 */

import { getDb } from '../db/database.mjs'

/** Key names whose values must never reach the audit table. */
const SECRET_KEY_RE =
  /(^|_|\b)(key|keys|secret|secrets|token|tokens|password|passwd|pwd|credential|credentials|sign|signature|authorization|cookie|session_token|api_key|apikey|private)(_|$|\b)/i

export const REDACTED = '[redacted]'

/**
 * Recursively replace secret-looking values.
 * Depth-limited so a cyclic or absurd payload cannot hang an audit write.
 */
export function redactDeep(value, { depth = 0, maxDepth = 6, maxKeys = 200 } = {}) {
  if (depth > maxDepth) return '[depth-limit]'
  if (value == null) return value
  if (Array.isArray(value))
    return value.slice(0, maxKeys).map((item) => redactDeep(item, { depth: depth + 1, maxDepth, maxKeys }))
  if (typeof value !== 'object') return value
  const out = {}
  let n = 0
  for (const [key, item] of Object.entries(value)) {
    if (n++ >= maxKeys) {
      out.__truncated__ = true
      break
    }
    out[key] = SECRET_KEY_RE.test(key)
      ? item
        ? REDACTED
        : item
      : redactDeep(item, { depth: depth + 1, maxDepth, maxKeys })
  }
  return out
}

function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString()
}

function rowToEntry(row) {
  if (!row) return null
  let detail = null
  try {
    detail = row.detail ? JSON.parse(row.detail) : null
  } catch {
    detail = { raw: String(row.detail).slice(0, 500) }
  }
  return {
    id: Number(row.id),
    actor: row.actor ?? null,
    actor_role: row.actor_role ?? null,
    action: row.action,
    target_type: row.target_type ?? null,
    target_id: row.target_id ?? null,
    detail,
    ip: row.ip ?? null,
    created_at: row.created_at ?? null,
  }
}

export class AuditLog {
  constructor(db = getDb()) {
    this.db = db
    this._insert = db.prepare(`
      INSERT INTO audit_logs (actor, actor_role, action, target_type, target_id, detail, ip, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this._list = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?')
    this._listByAction = db.prepare('SELECT * FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT ?')
    this._listByActor = db.prepare('SELECT * FROM audit_logs WHERE actor = ? ORDER BY id DESC LIMIT ?')
    this._listByTarget = db.prepare(
      'SELECT * FROM audit_logs WHERE target_type = ? AND target_id = ? ORDER BY id DESC LIMIT ?',
    )
    this._stats = db.prepare(
      'SELECT action, COUNT(*) AS n, MAX(created_at) AS last_at FROM audit_logs GROUP BY action ORDER BY n DESC',
    )
    this._count = db.prepare('SELECT COUNT(*) AS n FROM audit_logs')
    this._purge = db.prepare('DELETE FROM audit_logs WHERE created_at < ?')
  }

  /**
   * Record one action. Never throws — see the module header.
   *
   * @returns {{ok:boolean, id?:number, reason?:string}}
   */
  record({
    actor = null,
    actorRole = null,
    action,
    targetType = null,
    targetId = null,
    detail = null,
    ip = null,
    now = Date.now(),
  } = {}) {
    const name = String(action || '').trim()
    if (!name) return { ok: false, reason: 'action_required' }
    try {
      const payload = detail == null ? null : JSON.stringify(redactDeep(detail)).slice(0, 8000)
      const info = this._insert.run(
        actor == null ? null : String(actor).slice(0, 200),
        actorRole == null ? null : String(actorRole).slice(0, 40),
        name.slice(0, 120),
        targetType == null ? null : String(targetType).slice(0, 60),
        targetId == null ? null : String(targetId).slice(0, 200),
        payload,
        ip == null ? null : String(ip).slice(0, 80),
        nowIso(now),
      )
      return { ok: true, id: Number(info.lastInsertRowid) }
    } catch (error) {
      // Loud, but not fatal to the request that triggered it.
      console.error('[audit] write failed:', error?.message || error)
      return { ok: false, reason: 'write_failed', error: String(error?.message || error) }
    }
  }

  list({ action = null, actor = null, targetType = null, targetId = null, limit = 200 } = {}) {
    const n = Math.max(1, Math.min(1000, Number(limit) || 200))
    if (action) return this._listByAction.all(String(action), n).map(rowToEntry)
    if (actor) return this._listByActor.all(String(actor), n).map(rowToEntry)
    if (targetType && targetId) return this._listByTarget.all(String(targetType), String(targetId), n).map(rowToEntry)
    return this._list.all(n).map(rowToEntry)
  }

  stats() {
    const actions = this._stats.all().map((row) => ({
      action: row.action,
      count: Number(row.n) || 0,
      last_at: row.last_at ?? null,
    }))
    return { total: Number(this._count.get()?.n) || 0, actions }
  }

  /** Retention: drop entries older than `days`. */
  purgeOlderThan(days = 90, now = Date.now()) {
    const cutoff = new Date(now - Math.max(1, Number(days) || 90) * 24 * 60 * 60 * 1000).toISOString()
    return { removed: this._purge.run(cutoff).changes }
  }
}

/** Action names used across the panel, so the console can label them consistently. */
export const AUDIT_ACTIONS = Object.freeze({
  userCreate: 'user.create',
  userUpdate: 'user.update',
  userDelete: 'user.delete',
  channelCreate: 'channel.create',
  channelUpdate: 'channel.update',
  channelDelete: 'channel.delete',
  channelBuckets: 'channel.set_buckets',
  channelPricing: 'channel.set_pricing',
  redeemCreate: 'redeem.create_batch',
  redeemDelete: 'redeem.delete',
  redeemUse: 'redeem.use',
  subscriptionGrant: 'subscription.grant',
  subscriptionUpdate: 'subscription.update',
  subscriptionRevoke: 'subscription.revoke',
  paymentConfig: 'payment.update_config',
  paymentConfirm: 'payment.confirm',
  balanceAdjust: 'balance.adjust',
  egressRebind: 'egress.rebind',
  egressMigrate: 'egress.migrate',
  egressRelease: 'egress.release',
  egressCool: 'egress.cool',
  egressSweep: 'egress.sweep',
  announcementCreate: 'announcement.create',
  announcementUpdate: 'announcement.update',
  announcementDelete: 'announcement.delete',
})
