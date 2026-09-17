/**
 * 用户属性 — operator-defined fields on a user (渠道来源、风控标记、内部备注…).
 *
 * Definitions are rows rather than columns: adding a field is an insert, and the
 * user list grows a filter without the list query knowing about the field.
 *
 * Validation lives here and is pure, because the interesting failure is silent:
 * a `select` whose value is not in its own options, or a `number` stored as text
 * and then compared lexically ('10' < '9'), both look fine until someone filters.
 * Values keep a numeric mirror for exactly that reason.
 */

import { getDb, withTransaction } from '../db/database.mjs'

export const ATTRIBUTE_TYPES = Object.freeze(['text', 'number', 'select', 'date', 'bool'])
export const ATTRIBUTE_STATUSES = Object.freeze(['active', 'hidden'])
const MAX_TEXT = 500

function nowIso() {
  return new Date().toISOString()
}

function parseOptions(raw) {
  try {
    const parsed = JSON.parse(String(raw || '[]'))
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : []
  } catch {
    return []
  }
}

function rowToDef(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    key: row.key,
    name: row.name,
    type: ATTRIBUTE_TYPES.includes(row.type) ? row.type : 'text',
    options: parseOptions(row.options),
    default_value: row.default_value ?? null,
    show_in_filter: Number(row.show_in_filter) === 1,
    sort_order: Number(row.sort_order) || 0,
    status: row.status === 'hidden' ? 'hidden' : 'active',
  }
}

export function normalizeKey(raw) {
  return (
    String(raw || '')
      .trim()
      .toLowerCase()
      // \p{L}/\p{N} rather than [a-z0-9]: an operator naming an attribute 来源渠道
      // must get a usable key, not an empty string. ASCII-only would silently
      // reject every non-Latin name in a Chinese-language console.
      .replace(/[^\p{L}\p{N}_]+/gu, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40)
  )
}

/**
 * Validate and coerce one value against its definition.
 *
 * @returns {{ok:boolean, value:string|null, value_num:number|null, reason?:string}}
 *   `value: null` means "clear this attribute", which is not an error.
 */
export function normalizeAttributeValue(def, raw) {
  if (!def) return { ok: false, value: null, value_num: null, reason: 'unknown_attribute' }
  const empty = raw === undefined || raw === null || String(raw).trim() === ''
  if (empty) return { ok: true, value: null, value_num: null }

  switch (def.type) {
    case 'number': {
      const n = Number(raw)
      // Number('') is 0 and Number('12abc') is NaN; both would be stored as a
      // plausible-looking number, so reject anything that is not clean.
      if (!Number.isFinite(n)) return { ok: false, value: null, value_num: null, reason: 'not_a_number' }
      return { ok: true, value: String(n), value_num: n }
    }
    case 'bool': {
      const text = String(raw).trim().toLowerCase()
      const truthy = ['1', 'true', 'yes', 'y', 'on', '是']
      const falsy = ['0', 'false', 'no', 'n', 'off', '否']
      if (truthy.includes(text)) return { ok: true, value: 'true', value_num: 1 }
      if (falsy.includes(text)) return { ok: true, value: 'false', value_num: 0 }
      return { ok: false, value: null, value_num: null, reason: 'not_a_boolean' }
    }
    case 'date': {
      const ms = Date.parse(String(raw))
      if (!Number.isFinite(ms)) return { ok: false, value: null, value_num: null, reason: 'not_a_date' }
      return { ok: true, value: new Date(ms).toISOString(), value_num: ms }
    }
    case 'select': {
      const text = String(raw).trim()
      // A value outside the options is how a typo becomes an unfilterable row.
      if (!def.options.includes(text)) return { ok: false, value: null, value_num: null, reason: 'not_in_options' }
      return { ok: true, value: text, value_num: null }
    }
    default: {
      const text = String(raw).trim()
      if (text.length > MAX_TEXT) return { ok: false, value: null, value_num: null, reason: 'too_long' }
      return { ok: true, value: text, value_num: null }
    }
  }
}

/**
 * Does one user's attribute bag satisfy a set of filters?
 * Filters are `{ key: value }` with `value === ''` meaning "no constraint".
 */
export function matchesAttributeFilters(bag = {}, filters = {}) {
  for (const [key, wanted] of Object.entries(filters || {})) {
    if (wanted === undefined || wanted === null || String(wanted).trim() === '') continue
    const actual = bag[key]
    if (actual === undefined || actual === null || String(actual).trim() === '') return false
    if (String(actual) !== String(wanted)) return false
  }
  return true
}

export class UserAttributes {
  constructor(db = getDb()) {
    this.db = db
    this._listDefs = db.prepare('SELECT * FROM user_attribute_defs WHERE deleted_at IS NULL ORDER BY sort_order, id')
    this._getDef = db.prepare('SELECT * FROM user_attribute_defs WHERE id = ? AND deleted_at IS NULL')
    this._getDefByKey = db.prepare('SELECT * FROM user_attribute_defs WHERE key = ? AND deleted_at IS NULL')
    this._insertDef = db.prepare(`
      INSERT INTO user_attribute_defs (key, name, type, options, default_value, show_in_filter, sort_order, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this._updateDef = db.prepare(`
      UPDATE user_attribute_defs
         SET key = ?, name = ?, type = ?, options = ?, default_value = ?, show_in_filter = ?, sort_order = ?, status = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
    `)
    this._softDeleteDef = db.prepare('UPDATE user_attribute_defs SET deleted_at = ?, updated_at = ? WHERE id = ?')
    this._deleteValuesForDef = db.prepare('DELETE FROM user_attribute_values WHERE attr_id = ?')

    this._getValue = db.prepare('SELECT * FROM user_attribute_values WHERE user_id = ? AND attr_id = ?')
    this._upsertValue = db.prepare(`
      INSERT INTO user_attribute_values (user_id, attr_id, value, value_num, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, attr_id) DO UPDATE SET
        value = excluded.value, value_num = excluded.value_num, updated_at = excluded.updated_at
    `)
    this._clearValue = db.prepare('DELETE FROM user_attribute_values WHERE user_id = ? AND attr_id = ?')
    this._valuesOfUser = db.prepare('SELECT * FROM user_attribute_values WHERE user_id = ?')
    this._valuesOfUsers = db.prepare(
      `SELECT v.*, d.key FROM user_attribute_values v
         JOIN user_attribute_defs d ON d.id = v.attr_id
        WHERE v.user_id = ? AND d.deleted_at IS NULL`,
    )
    this._distinctValues = db.prepare(
      'SELECT DISTINCT value FROM user_attribute_values WHERE attr_id = ? AND value IS NOT NULL ORDER BY value LIMIT 200',
    )
  }

  // ── definitions ───────────────────────────────────────────────────────────

  listDefs() {
    return this._listDefs.all().map(rowToDef)
  }

  getDef(id) {
    if (id == null) return null
    return rowToDef(this._getDef.get(Number(id)))
  }

  getDefByKey(key) {
    const k = normalizeKey(key)
    if (!k) return null
    return rowToDef(this._getDefByKey.get(k))
  }

  createDef(input = {}) {
    const key = normalizeKey(input.key || input.name)
    if (!key) throw new Error('attribute key is required')
    const name = String(input.name || '').trim() || key
    const type = ATTRIBUTE_TYPES.includes(input.type) ? input.type : 'text'
    const options = Array.isArray(input.options) ? input.options.map((v) => String(v)).filter(Boolean) : []
    if (type === 'select' && !options.length) throw new Error('a select attribute needs at least one option')
    const stamp = nowIso()
    const info = this._insertDef.run(
      key,
      name,
      type,
      JSON.stringify(options),
      input.default_value == null ? null : String(input.default_value),
      input.show_in_filter ? 1 : 0,
      Number(input.sort_order) || 0,
      ATTRIBUTE_STATUSES.includes(input.status) ? input.status : 'active',
      stamp,
      stamp,
    )
    return this.getDef(info.lastInsertRowid)
  }

  updateDef(id, patch = {}) {
    const current = this.getDef(id)
    if (!current) return null
    const type = ATTRIBUTE_TYPES.includes(patch.type) ? patch.type : current.type
    const options = Array.isArray(patch.options) ? patch.options.map((v) => String(v)).filter(Boolean) : current.options
    if (type === 'select' && !options.length) throw new Error('a select attribute needs at least one option')
    this._updateDef.run(
      patch.key == null ? current.key : normalizeKey(patch.key) || current.key,
      patch.name == null ? current.name : String(patch.name).trim() || current.name,
      type,
      JSON.stringify(options),
      patch.default_value === undefined ? current.default_value : patch.default_value,
      patch.show_in_filter == null ? (current.show_in_filter ? 1 : 0) : patch.show_in_filter ? 1 : 0,
      patch.sort_order == null ? current.sort_order : Number(patch.sort_order) || 0,
      ATTRIBUTE_STATUSES.includes(patch.status) ? patch.status : current.status,
      nowIso(),
      Number(id),
    )
    return this.getDef(id)
  }

  removeDef(id) {
    return withTransaction(this.db, () => {
      this._softDeleteDef.run(nowIso(), nowIso(), Number(id))
      this._deleteValuesForDef.run(Number(id))
      return { removed: true }
    })
  }

  // ── values ────────────────────────────────────────────────────────────────

  /** One user's values as `{ key: value }`. */
  bagFor(userId) {
    const uid = String(userId || '').trim()
    if (!uid) return {}
    const bag = {}
    for (const row of this._valuesOfUsers.all(uid)) {
      if (row.value == null) continue
      bag[row.key] = row.value
    }
    return bag
  }

  /** Values for many users at once, keyed by user id. */
  bagsFor(userIds = []) {
    const out = new Map()
    for (const userId of userIds) out.set(String(userId), this.bagFor(userId))
    return out
  }

  /**
   * Set values for one user. Unknown keys and invalid values are rejected rather
   * than stored, so a bad import cannot create rows nobody can filter.
   */
  setValues(userId, values = {}) {
    const uid = String(userId || '').trim()
    if (!uid) return { ok: false, reason: 'user_required' }
    const applied = []
    const rejected = []
    return withTransaction(this.db, () => {
      for (const [rawKey, rawValue] of Object.entries(values || {})) {
        const def = this.getDefByKey(rawKey)
        if (!def) {
          rejected.push({ key: rawKey, reason: 'unknown_attribute' })
          continue
        }
        const normalized = normalizeAttributeValue(def, rawValue)
        if (!normalized.ok) {
          rejected.push({ key: def.key, reason: normalized.reason })
          continue
        }
        if (normalized.value == null) {
          this._clearValue.run(uid, def.id)
        } else {
          this._upsertValue.run(uid, def.id, normalized.value, normalized.value_num, nowIso())
        }
        applied.push({ key: def.key, value: normalized.value })
      }
      return { ok: rejected.length === 0, applied, rejected }
    })
  }

  /** Distinct values seen for a select-ish attribute — powers the list filter. */
  distinctValues(attrId) {
    return this._distinctValues.all(Number(attrId)).map((row) => row.value)
  }

  /** Definitions plus, for selects, what has actually been used. */
  overview() {
    return this.listDefs().map((def) => ({
      ...def,
      used_values: def.type === 'select' ? this.distinctValues(def.id) : [],
    }))
  }
}
