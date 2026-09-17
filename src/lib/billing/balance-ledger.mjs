/**
 * 余额流水 — the only place `users.balance` moves.
 *
 * Every credit/debit writes a `balance_ledger` row in the same transaction as
 * the balance update. A bare UPDATE would leave no trail, and money without a
 * trail is not debuggable: you cannot answer "why is this user's balance 12.30"
 * or "who refunded this" afterwards.
 */

import { getDb, withTransaction } from '../db/database.mjs'
import { UsersRepo } from '../db/repos/users-repo.mjs'

export const LEDGER_SOURCES = Object.freeze(['redeem', 'payment', 'subscription', 'admin', 'usage', 'refund'])

function nowIso() {
  return new Date().toISOString()
}

export class BalanceLedger {
  constructor(db = getDb()) {
    this.db = db
    this.users = new UsersRepo(db)
    this._insert = db.prepare(`
      INSERT INTO balance_ledger (user_id, delta, balance_after, source, ref, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    this._listByUser = db.prepare('SELECT * FROM balance_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    this._listRecent = db.prepare('SELECT * FROM balance_ledger ORDER BY id DESC LIMIT ?')
    this._sumBySource = db.prepare(
      'SELECT source, COUNT(*) AS n, SUM(delta) AS total FROM balance_ledger GROUP BY source',
    )
  }

  /**
   * Move a balance and record why.
   *
   * @param {number} delta   positive credits, negative debits
   * @returns {{ok:boolean, reason?:string, balance?:number, entry?:object}}
   */
  apply({ userId, delta, source, ref = null, notes = null, allowNegative = false } = {}) {
    const uid = String(userId || '').trim()
    const amount = Number(delta)
    if (!uid) return { ok: false, reason: 'user_required' }
    if (!Number.isFinite(amount) || amount === 0) return { ok: false, reason: 'delta_required' }
    const src = String(source || '').trim()
    if (!LEDGER_SOURCES.includes(src)) return { ok: false, reason: 'invalid_source' }

    return withTransaction(this.db, () => {
      const user = this.users.getById(uid)
      if (!user) return { ok: false, reason: 'user_not_found' }
      const before = Number(user.balance) || 0
      const after = Math.round((before + amount) * 1e6) / 1e6
      if (after < 0 && !allowNegative) return { ok: false, reason: 'insufficient_balance', balance: before }

      // addBalance does `balance = balance + ?` in SQL, so concurrent credits
      // cannot lose each other the way a read-modify-write would.
      const updated = this.users.addBalance(uid, amount)
      const landed = Number(updated?.balance)
      const finalBalance = Number.isFinite(landed) ? Math.round(landed * 1e6) / 1e6 : after

      const stamp = nowIso()
      this._insert.run(uid, amount, finalBalance, src, ref == null ? null : String(ref), notes, stamp)
      return {
        ok: true,
        balance: finalBalance,
        entry: {
          user_id: uid,
          delta: amount,
          balance_after: finalBalance,
          source: src,
          ref,
          notes,
          created_at: stamp,
        },
      }
    })
  }

  credit(args = {}) {
    const amount = Math.abs(Number(args.amount ?? args.delta) || 0)
    return this.apply({ ...args, delta: amount })
  }

  debit(args = {}) {
    const amount = Math.abs(Number(args.amount ?? args.delta) || 0)
    return this.apply({ ...args, delta: -amount })
  }

  history({ userId = null, limit = 50 } = {}) {
    const n = Math.max(1, Math.min(500, Number(limit) || 50))
    return userId ? this._listByUser.all(String(userId), n) : this._listRecent.all(n)
  }

  totalsBySource() {
    const out = {}
    for (const row of this._sumBySource.all()) {
      out[row.source] = { count: Number(row.n) || 0, total: Number(row.total) || 0 }
    }
    return out
  }
}
