/**
 * sticky_sessions repository — conversation key → account/VM bindings.
 */

import { getDb } from '../database.mjs'

function rowToEntry(row) {
  if (!row) return null
  return {
    account_id: row.account_id,
    vm_id: row.vm_id,
    session_id: row.session_id,
    // 022: which tenant and which egress this conversation is pinned to.
    user_id: row.user_id ?? null,
    egress_id: row.egress_id ?? null,
    bound_at: row.bound_at,
    expires_at: row.expires_at,
    hits: row.hits || 0,
  }
}

export class StickyRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = db.prepare('SELECT * FROM sticky_sessions WHERE key = ?')
    this._upsert = db.prepare(`
      INSERT INTO sticky_sessions (key, account_id, vm_id, session_id, user_id, egress_id, bound_at, expires_at, hits)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        account_id = excluded.account_id,
        vm_id = excluded.vm_id,
        session_id = excluded.session_id,
        user_id = excluded.user_id,
        egress_id = excluded.egress_id,
        bound_at = excluded.bound_at,
        expires_at = excluded.expires_at,
        hits = excluded.hits
    `)
    this._delete = db.prepare('DELETE FROM sticky_sessions WHERE key = ?')
    this._deleteByAccount = db.prepare('DELETE FROM sticky_sessions WHERE account_id = ? OR vm_id = ?')
    this._purge = db.prepare('DELETE FROM sticky_sessions WHERE expires_at < ?')
    this._all = db.prepare('SELECT * FROM sticky_sessions')
    this._count = db.prepare('SELECT COUNT(*) c FROM sticky_sessions')
    this._countByEgress = db.prepare(
      `SELECT egress_id, COUNT(*) AS sessions FROM sticky_sessions
        WHERE egress_id IS NOT NULL GROUP BY egress_id`,
    )
    this._listByUser = db.prepare('SELECT * FROM sticky_sessions WHERE user_id = ? ORDER BY bound_at DESC')
  }

  get(key) {
    return rowToEntry(this._get.get(key))
  }

  upsert(key, ent) {
    this._upsert.run(
      key,
      ent.account_id ?? null,
      ent.vm_id ?? null,
      ent.session_id ?? null,
      ent.user_id ?? null,
      ent.egress_id ?? null,
      ent.bound_at ?? Date.now(),
      ent.expires_at ?? null,
      ent.hits ?? 0,
    )
  }

  /** Sessions pinned per egress — the console's "conversations on this IP" count. */
  countByEgress() {
    const out = {}
    for (const row of this._countByEgress.all()) out[row.egress_id] = Number(row.sessions) || 0
    return out
  }

  listByUser(userId) {
    if (!userId) return []
    return this._listByUser.all(String(userId)).map(rowToEntry)
  }

  remove(key) {
    this._delete.run(key)
  }

  removeByAccount({ accountId = null, vmId = null } = {}) {
    if (!accountId && !vmId) return 0
    return this._deleteByAccount.run(accountId || '', vmId || '').changes
  }

  purgeExpired(now = Date.now()) {
    return this._purge.run(now).changes
  }

  all() {
    const out = {}
    for (const row of this._all.all()) out[row.key] = rowToEntry(row)
    return out
  }

  count() {
    return this._count.get().c
  }
}
