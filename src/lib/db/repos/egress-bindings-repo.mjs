/**
 * egress_bindings repository — user ↔ egress IP + user ↔ slot rows.
 *
 * Two layers on purpose:
 *   user_egress_bindings  stable   — "这个用户的出口 IP 归属"
 *   user_slot_bindings    mutable  — "当前挂在哪个槽"
 *
 * A credential dying rewrites only the slot row. The egress row changes only
 * when an admin rebinds, and every move lands in egress_migrations.
 */

import { getDb, withTransaction } from '../database.mjs'

const EGRESS_COLUMNS = [
  'user_id',
  'egress_id',
  'reason',
  'bound_by',
  'bound_at',
  'updated_at',
]

const SLOT_COLUMNS = [
  'user_id',
  'slot_id',
  'egress_id',
  'reason',
  'migrations',
  'last_reason',
  'bound_by',
  'bound_at',
  'updated_at',
]

function nowIso() {
  return new Date().toISOString()
}

function rowToEgressBinding(row) {
  if (!row) return null
  return { ...row }
}

function rowToSlotBinding(row) {
  if (!row) return null
  return { ...row, migrations: Number(row.migrations) || 0 }
}

export class EgressBindingsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._getEgress = db.prepare('SELECT * FROM proxies WHERE id = ? AND deleted_at IS NULL')
    this._listEgress = db.prepare('SELECT * FROM proxies WHERE deleted_at IS NULL ORDER BY created_at, id')
    this._setEgressIdentity = db.prepare(
      'UPDATE proxies SET kind = ?, identity = ?, updated_at = ? WHERE id = ?',
    )

    this._getEgressBinding = db.prepare('SELECT * FROM user_egress_bindings WHERE user_id = ?')
    this._listEgressBindings = db.prepare('SELECT * FROM user_egress_bindings ORDER BY user_id')
    this._insertEgressBinding = db.prepare(`
      INSERT OR IGNORE INTO user_egress_bindings (${EGRESS_COLUMNS.join(', ')})
      VALUES (${EGRESS_COLUMNS.map(() => '?').join(', ')})
    `)
    this._updateEgressBinding = db.prepare(`
      UPDATE user_egress_bindings
         SET egress_id = ?, reason = ?, bound_by = ?, bound_at = ?, updated_at = ?
       WHERE user_id = ?
    `)
    this._deleteEgressBinding = db.prepare('DELETE FROM user_egress_bindings WHERE user_id = ?')
    this._countUsersByEgress = db.prepare(
      'SELECT egress_id, COUNT(*) AS users FROM user_egress_bindings GROUP BY egress_id',
    )

    this._getSlotBinding = db.prepare('SELECT * FROM user_slot_bindings WHERE user_id = ?')
    this._listSlotBindings = db.prepare('SELECT * FROM user_slot_bindings ORDER BY user_id')
    this._listSlotBindingsByEgress = db.prepare(
      'SELECT * FROM user_slot_bindings WHERE egress_id = ? ORDER BY user_id',
    )
    this._listSlotBindingsBySlot = db.prepare(
      'SELECT * FROM user_slot_bindings WHERE slot_id = ? ORDER BY user_id',
    )
    this._insertSlotBinding = db.prepare(`
      INSERT OR IGNORE INTO user_slot_bindings (${SLOT_COLUMNS.join(', ')})
      VALUES (${SLOT_COLUMNS.map(() => '?').join(', ')})
    `)
    this._updateSlotBinding = db.prepare(`
      UPDATE user_slot_bindings
         SET slot_id = ?, egress_id = ?, reason = ?, last_reason = ?,
             migrations = migrations + ?, bound_by = ?, updated_at = ?
       WHERE user_id = ?
    `)
    this._deleteSlotBinding = db.prepare('DELETE FROM user_slot_bindings WHERE user_id = ?')
    this._deleteSlotBindingsBySlot = db.prepare('DELETE FROM user_slot_bindings WHERE slot_id = ?')

    this._insertMigration = db.prepare(`
      INSERT INTO egress_migrations (user_id, egress_id, from_slot, to_slot, reason, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    this._listMigrations = db.prepare(
      'SELECT * FROM egress_migrations WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    )
    this._listRecentMigrations = db.prepare('SELECT * FROM egress_migrations ORDER BY id DESC LIMIT ?')
  }

  // ── egress (proxies) ──────────────────────────────────────────────────────

  getEgress(id) {
    if (!id) return null
    return this._getEgress.get(String(id)) || null
  }

  listEgresses() {
    return this._listEgress.all()
  }

  setEgressIdentity(id, { kind, identity } = {}) {
    if (!id) return { changes: 0 }
    const current = this.getEgress(id)
    if (!current) return { changes: 0 }
    return this._setEgressIdentity.run(
      String(kind || current.kind || 'socks5'),
      identity == null ? current.identity : String(identity),
      nowIso(),
      String(id),
    )
  }

  // ── user → egress ─────────────────────────────────────────────────────────

  getEgressBinding(userId) {
    if (!userId) return null
    return rowToEgressBinding(this._getEgressBinding.get(String(userId)))
  }

  listEgressBindings() {
    return this._listEgressBindings.all().map(rowToEgressBinding)
  }

  countUsersByEgress() {
    const out = {}
    for (const row of this._countUsersByEgress.all()) out[row.egress_id] = Number(row.users) || 0
    return out
  }

  /**
   * Create the binding when missing. When it exists with another egress this
   * is an admin rebind — callers must pass reason='admin' and it is audited.
   */
  upsertEgressBinding({ userId, egressId, reason = 'auto', boundBy = null } = {}) {
    const uid = String(userId || '').trim()
    const eid = String(egressId || '').trim()
    if (!uid || !eid) throw new Error('userId and egressId are required')
    const existing = this.getEgressBinding(uid)
    const stamp = nowIso()
    if (!existing) {
      this._insertEgressBinding.run(uid, eid, reason, boundBy, stamp, stamp)
      return { created: true, changed: true, binding: this.getEgressBinding(uid) }
    }
    if (existing.egress_id === eid) return { created: false, changed: false, binding: existing }
    this._updateEgressBinding.run(eid, reason, boundBy, stamp, stamp, uid)
    return { created: false, changed: true, binding: this.getEgressBinding(uid) }
  }

  deleteEgressBinding(userId) {
    if (!userId) return { changes: 0 }
    return this._deleteEgressBinding.run(String(userId))
  }

  // ── user → slot ───────────────────────────────────────────────────────────

  getSlotBinding(userId) {
    if (!userId) return null
    return rowToSlotBinding(this._getSlotBinding.get(String(userId)))
  }

  listSlotBindings() {
    return this._listSlotBindings.all().map(rowToSlotBinding)
  }

  listSlotBindingsByEgress(egressId) {
    if (!egressId) return []
    return this._listSlotBindingsByEgress.all(String(egressId)).map(rowToSlotBinding)
  }

  listSlotBindingsBySlot(slotId) {
    if (!slotId) return []
    return this._listSlotBindingsBySlot.all(String(slotId)).map(rowToSlotBinding)
  }

  /**
   * @param {boolean} migrate  true when the user is moving to a different slot
   *                           (increments the counter and records last_reason)
   */
  upsertSlotBinding({ userId, slotId, egressId, reason = 'auto', boundBy = null, migrate = false } = {}) {
    const uid = String(userId || '').trim()
    const sid = String(slotId || '').trim()
    const eid = String(egressId || '').trim()
    if (!uid || !sid || !eid) throw new Error('userId, slotId and egressId are required')
    const stamp = nowIso()
    const existing = this.getSlotBinding(uid)
    if (!existing) {
      this._insertSlotBinding.run(uid, sid, eid, reason, 0, null, boundBy, stamp, stamp)
      return { created: true, moved: false, binding: this.getSlotBinding(uid) }
    }
    if (existing.slot_id === sid && existing.egress_id === eid) {
      return { created: false, moved: false, binding: existing }
    }
    const bumped = migrate || existing.slot_id !== sid ? 1 : 0
    this._updateSlotBinding.run(sid, eid, reason, reason, bumped, boundBy, stamp, uid)
    return { created: false, moved: true, binding: this.getSlotBinding(uid) }
  }

  deleteSlotBinding(userId) {
    if (!userId) return { changes: 0 }
    return this._deleteSlotBinding.run(String(userId))
  }

  /** A slot that lost its credential releases every user pinned to it. */
  releaseSlot(slotId) {
    if (!slotId) return { changes: 0 }
    return this._deleteSlotBindingsBySlot.run(String(slotId))
  }

  // ── audit ─────────────────────────────────────────────────────────────────

  recordMigration({ userId, egressId, fromSlot = null, toSlot = null, reason, detail = null } = {}) {
    if (!userId || !egressId || !reason) throw new Error('userId, egressId and reason are required')
    return this._insertMigration.run(
      String(userId),
      String(egressId),
      fromSlot == null ? null : String(fromSlot),
      toSlot == null ? null : String(toSlot),
      String(reason),
      detail == null ? null : String(detail).slice(0, 500),
      nowIso(),
    )
  }

  listMigrations({ userId = null, limit = 50 } = {}) {
    const n = Math.max(1, Math.min(500, Number(limit) || 50))
    if (userId) return this._listMigrations.all(String(userId), n)
    return this._listRecentMigrations.all(n)
  }

  /** Atomically move a user to another slot inside the same egress. */
  moveUserToSlot({ userId, egressId, fromSlot, toSlot, reason = 'migrate', boundBy = null } = {}) {
    return withTransaction(this.db, () => {
      const res = this.upsertSlotBinding({
        userId,
        slotId: toSlot,
        egressId,
        reason,
        boundBy,
        migrate: true,
      })
      this.recordMigration({ userId, egressId, fromSlot, toSlot, reason })
      return res
    })
  }
}
