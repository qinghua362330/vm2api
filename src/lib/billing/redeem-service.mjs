/**
 * 兑换码 — create batches, redeem once per user, apply the value.
 *
 * The existing `redeem_codes` shape (014) assumed one code = one user. This adds
 * multi-use codes plus a `redeem_redemptions` row per use, so "who redeemed
 * what" survives after the counter moves, and a unique index makes double
 * redemption by the same user impossible rather than merely unlikely.
 *
 * Redeeming is the only operation here that moves money, and it does so through
 * BalanceLedger so the trail is never skipped.
 */

import crypto from 'node:crypto'
import { getDb, withTransaction } from '../db/database.mjs'
import { RedeemCodesRepo } from '../db/repos/redeem-codes-repo.mjs'
import { BalanceLedger } from './balance-ledger.mjs'

export const REDEEM_TYPES = Object.freeze(['balance', 'subscription_days', 'concurrency'])

function nowIso() {
  return new Date().toISOString()
}

/** Crockford-ish alphabet: no I/L/O/U, so a code survives being read aloud. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function generateCode({ groups = 4, size = 6, randomBytes = crypto.randomBytes } = {}) {
  const bytes = randomBytes(groups * size)
  let out = ''
  for (let i = 0; i < groups * size; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length]
    if ((i + 1) % size === 0 && i + 1 < groups * size) out += '-'
  }
  return out
}

export class RedeemService {
  constructor(db = getDb()) {
    this.db = db
    this.repo = new RedeemCodesRepo(db)
    this.ledger = new BalanceLedger(db)
    this._insertRedemption = db.prepare(`
      INSERT INTO redeem_redemptions (code_id, code, user_id, value, type, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    this._redemptionsByUser = db.prepare('SELECT * FROM redeem_redemptions WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    this._redemptionsByCode = db.prepare('SELECT * FROM redeem_redemptions WHERE code_id = ? ORDER BY id DESC LIMIT ?')
    this._countRedeemed = db.prepare('SELECT COUNT(*) AS n FROM redeem_redemptions WHERE code_id = ?')
    this._byId = db.prepare('SELECT * FROM redeem_codes WHERE id = ?')
    this._markCount = db.prepare(`
      UPDATE redeem_codes
         SET used_count = used_count + 1,
             used_by = COALESCE(used_by, ?),
             used_at = COALESCE(used_at, ?),
             status = CASE WHEN used_count + 1 >= max_uses THEN 'used' ELSE 'partial' END
       WHERE id = ?
    `)
    this._insertCode = db.prepare(`
      INSERT INTO redeem_codes
        (code, type, value, status, notes, expires_at, created_at, max_uses, used_count, batch, created_by)
      VALUES (?, ?, ?, 'unused', ?, ?, ?, ?, 0, ?, ?)
    `)
  }

  /** Create one code, or a batch of them. Returns the created rows. */
  createBatch({
    count = 1,
    value = 0,
    type = 'balance',
    maxUses = 1,
    notes = null,
    expiresAt = null,
    batch = null,
    createdBy = null,
    code = null,
  } = {}) {
    const n = Math.max(1, Math.min(1000, Number(count) || 1))
    if (!REDEEM_TYPES.includes(type)) throw new Error(`unsupported redeem type: ${type}`)
    const uses = Math.max(1, Number(maxUses) || 1)
    const stamp = nowIso()
    const batchId = batch || `b${Date.now().toString(36)}`
    const created = []
    return withTransaction(this.db, () => {
      for (let i = 0; i < n; i++) {
        let candidate = code && n === 1 ? String(code).trim().toUpperCase() : generateCode()
        // A generated code colliding is astronomically unlikely; a *supplied*
        // one colliding is user error and must not end up as a broken batch.
        for (let attempt = 0; attempt < 5 && this.repo.getByCode(candidate); attempt++) {
          if (code && n === 1) throw new Error('code already exists')
          candidate = generateCode()
        }
        const info = this._insertCode.run(
          candidate,
          type,
          Number(value) || 0,
          notes,
          expiresAt,
          stamp,
          uses,
          batchId,
          createdBy,
        )
        created.push(this._byId.get(info.lastInsertRowid))
      }
      return created
    })
  }

  list() {
    return this.repo.list()
  }

  remove(id) {
    return this.repo.remove(id)
  }

  redemptions({ userId = null, codeId = null, limit = 50 } = {}) {
    const n = Math.max(1, Math.min(500, Number(limit) || 50))
    if (userId) return this._redemptionsByUser.all(String(userId), n)
    if (codeId != null) return this._redemptionsByCode.all(Number(codeId), n)
    return []
  }

  /**
   * Redeem a code for a user.
   *
   * @returns {{ok:boolean, reason?:string, applied?:object}}
   */
  redeem({ code, userId, subscriptionDays = null } = {}) {
    const raw = String(code || '')
      .trim()
      .toUpperCase()
    const uid = String(userId || '').trim()
    if (!raw) return { ok: false, reason: 'code_required' }
    if (!uid) return { ok: false, reason: 'user_required' }

    const row = this.repo.getByCode(raw)
    if (!row) return { ok: false, reason: 'code_not_found' }
    if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return { ok: false, reason: 'code_expired' }

    const used = Number(row.used_count) || 0
    const max = Math.max(1, Number(row.max_uses) || 1)
    if (row.status === 'used' || used >= max) return { ok: false, reason: 'code_exhausted' }

    const already = this.db
      .prepare('SELECT id FROM redeem_redemptions WHERE code_id = ? AND user_id = ?')
      .get(Number(row.id), uid)
    if (already) return { ok: false, reason: 'already_redeemed' }

    const stamp = nowIso()
    const type = row.type || 'balance'
    const value = Number(row.value) || 0

    return withTransaction(this.db, () => {
      this._insertRedemption.run(Number(row.id), row.code, uid, value, type, stamp)
      const marked = this._markCount.run(uid, stamp, Number(row.id))
      if (!marked.changes) return { ok: false, reason: 'code_exhausted' }

      let applied = { type, value }
      if (type === 'balance') {
        const credit = this.ledger.credit({
          userId: uid,
          amount: value,
          source: 'redeem',
          ref: row.code,
          notes: row.notes || '兑换码充值',
        })
        if (!credit.ok) throw new Error(credit.reason)
        applied = { ...applied, balance: credit.balance }
      }
      // subscription_days / concurrency are applied by the caller, which owns
      // those tables; returning the intent keeps this service focused on the
      // code's lifecycle and the money.
      return { ok: true, applied, code: row.code, type }
    })
  }

  /** Console view: codes with how many times each has actually been used. */
  overview() {
    return this.list().map((row) => ({
      ...row,
      max_uses: Math.max(1, Number(row.max_uses) || 1),
      used_count: Number(row.used_count) || 0,
      redemptions: this._countRedeemed.get(Number(row.id)).n,
    }))
  }
}
