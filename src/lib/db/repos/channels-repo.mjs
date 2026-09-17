/**
 * channels repository — 渠道 (distribution + pricing) over the bucket model.
 *
 * A channel groups buckets (egress/IP) and prices them. It deliberately does not
 * select an account: that stays with the egress/slot/session resolver, so the
 * codebase keeps one dispatch model.
 */

import { getDb, withTransaction } from '../database.mjs'

function nowIso() {
  return new Date().toISOString()
}

function parseModels(raw) {
  try {
    const parsed = JSON.parse(String(raw || '[]'))
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

function rowToChannel(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description || '',
    status: row.status || 'active',
    restrict_models: Number(row.restrict_models) === 1,
    rate_multiplier: Number(row.rate_multiplier) || 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function rowToPricing(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    channel_id: Number(row.channel_id),
    models: parseModels(row.models),
    input_price: row.input_price == null ? null : Number(row.input_price),
    output_price: row.output_price == null ? null : Number(row.output_price),
    cache_write_price: row.cache_write_price == null ? null : Number(row.cache_write_price),
    cache_read_price: row.cache_read_price == null ? null : Number(row.cache_read_price),
    per_request_price: row.per_request_price == null ? null : Number(row.per_request_price),
  }
}

export class ChannelsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._list = db.prepare('SELECT * FROM channels WHERE deleted_at IS NULL ORDER BY id')
    this._get = db.prepare('SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL')
    this._getByName = db.prepare('SELECT * FROM channels WHERE name = ? AND deleted_at IS NULL')
    this._insert = db.prepare(`
      INSERT INTO channels (name, description, status, restrict_models, rate_multiplier, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    this._update = db.prepare(`
      UPDATE channels
         SET name = ?, description = ?, status = ?, restrict_models = ?, rate_multiplier = ?, updated_at = ?
       WHERE id = ?
    `)
    this._softDelete = db.prepare('UPDATE channels SET deleted_at = ?, updated_at = ? WHERE id = ?')

    this._listBuckets = db.prepare('SELECT egress_id FROM channel_buckets WHERE channel_id = ? ORDER BY egress_id')
    this._listAllBuckets = db.prepare('SELECT channel_id, egress_id FROM channel_buckets')
    this._channelOfBucket = db.prepare('SELECT channel_id FROM channel_buckets WHERE egress_id = ?')
    this._insertBucket = db.prepare(
      'INSERT OR IGNORE INTO channel_buckets (channel_id, egress_id, created_at) VALUES (?, ?, ?)',
    )
    this._deleteBucket = db.prepare('DELETE FROM channel_buckets WHERE channel_id = ? AND egress_id = ?')
    this._clearBuckets = db.prepare('DELETE FROM channel_buckets WHERE channel_id = ?')

    this._listPricing = db.prepare('SELECT * FROM channel_model_pricing WHERE channel_id = ? ORDER BY id')
    this._insertPricing = db.prepare(`
      INSERT INTO channel_model_pricing
        (channel_id, models, input_price, output_price, cache_write_price, cache_read_price, per_request_price, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this._clearPricing = db.prepare('DELETE FROM channel_model_pricing WHERE channel_id = ?')

    this._listUsers = db.prepare('SELECT user_id FROM channel_users WHERE channel_id = ? ORDER BY user_id')
    this._channelsOfUser = db.prepare('SELECT channel_id FROM channel_users WHERE user_id = ?')
    this._insertUser = db.prepare(
      'INSERT OR IGNORE INTO channel_users (channel_id, user_id, created_at) VALUES (?, ?, ?)',
    )
    this._deleteUser = db.prepare('DELETE FROM channel_users WHERE channel_id = ? AND user_id = ?')
    this._clearUsers = db.prepare('DELETE FROM channel_users WHERE channel_id = ?')
  }

  // ── channels ──────────────────────────────────────────────────────────────

  list() {
    return this._list.all().map(rowToChannel)
  }

  get(id) {
    if (id == null) return null
    return rowToChannel(this._get.get(Number(id)))
  }

  getByName(name) {
    const raw = String(name || '').trim()
    if (!raw) return null
    return rowToChannel(this._getByName.get(raw))
  }

  create({ name, description = '', status = 'active', restrict_models = false, rate_multiplier = 1 } = {}) {
    const clean = String(name || '').trim()
    if (!clean) throw new Error('channel name is required')
    const stamp = nowIso()
    const info = this._insert.run(
      clean,
      String(description || ''),
      status === 'disabled' ? 'disabled' : 'active',
      restrict_models ? 1 : 0,
      Number(rate_multiplier) || 1,
      stamp,
      stamp,
    )
    return this.get(info.lastInsertRowid)
  }

  update(id, patch = {}) {
    const current = this.get(id)
    if (!current) return null
    this._update.run(
      patch.name == null ? current.name : String(patch.name).trim() || current.name,
      patch.description == null ? current.description : String(patch.description),
      patch.status == null ? current.status : patch.status === 'disabled' ? 'disabled' : 'active',
      patch.restrict_models == null ? (current.restrict_models ? 1 : 0) : patch.restrict_models ? 1 : 0,
      patch.rate_multiplier == null ? current.rate_multiplier : Number(patch.rate_multiplier) || 1,
      nowIso(),
      Number(id),
    )
    return this.get(id)
  }

  remove(id) {
    const stamp = nowIso()
    return withTransaction(this.db, () => {
      this._softDelete.run(stamp, stamp, Number(id))
      this._clearBuckets.run(Number(id))
      this._clearUsers.run(Number(id))
      this._clearPricing.run(Number(id))
      return { removed: true }
    })
  }

  // ── buckets ───────────────────────────────────────────────────────────────

  listBucketIds(channelId) {
    if (channelId == null) return []
    return this._listBuckets.all(Number(channelId)).map((row) => row.egress_id)
  }

  /** egress_id → channel_id, for the whole table. */
  bucketOwnerMap() {
    const out = {}
    for (const row of this._listAllBuckets.all()) out[row.egress_id] = Number(row.channel_id)
    return out
  }

  channelOfBucket(egressId) {
    const raw = String(egressId || '').trim()
    if (!raw) return null
    const row = this._channelOfBucket.get(raw)
    return row ? Number(row.channel_id) : null
  }

  /** Replace the channel's bucket set. A bucket can only live in one channel. */
  setBuckets(channelId, egressIds = []) {
    const id = Number(channelId)
    if (!Number.isFinite(id)) throw new Error('channelId is required')
    const wanted = [...new Set((egressIds || []).map((v) => String(v || '').trim()).filter(Boolean))]
    return withTransaction(this.db, () => {
      this._clearBuckets.run(id)
      const stamp = nowIso()
      const rejected = []
      for (const egressId of wanted) {
        const owner = this.channelOfBucket(egressId)
        if (owner != null && owner !== id) {
          rejected.push({ egress_id: egressId, channel_id: owner })
          continue
        }
        this._insertBucket.run(id, egressId, stamp)
      }
      return { buckets: this.listBucketIds(id), rejected }
    })
  }

  addBucket(channelId, egressId) {
    const owner = this.channelOfBucket(egressId)
    if (owner != null && owner !== Number(channelId)) {
      return { added: false, reason: 'bucket_taken', channel_id: owner }
    }
    this._insertBucket.run(Number(channelId), String(egressId), nowIso())
    return { added: true }
  }

  removeBucket(channelId, egressId) {
    this._deleteBucket.run(Number(channelId), String(egressId))
    return { buckets: this.listBucketIds(channelId) }
  }

  // ── pricing ───────────────────────────────────────────────────────────────

  listPricing(channelId) {
    if (channelId == null) return []
    return this._listPricing.all(Number(channelId)).map(rowToPricing)
  }

  setPricing(channelId, rows = []) {
    const id = Number(channelId)
    if (!Number.isFinite(id)) throw new Error('channelId is required')
    return withTransaction(this.db, () => {
      this._clearPricing.run(id)
      const stamp = nowIso()
      for (const row of rows || []) {
        const models = Array.isArray(row?.models) ? row.models.map(String).filter(Boolean) : []
        if (!models.length) continue
        this._insertPricing.run(
          id,
          JSON.stringify(models),
          row.input_price ?? null,
          row.output_price ?? null,
          row.cache_write_price ?? null,
          row.cache_read_price ?? null,
          row.per_request_price ?? null,
          stamp,
          stamp,
        )
      }
      return this.listPricing(id)
    })
  }

  // ── users ─────────────────────────────────────────────────────────────────

  listUserIds(channelId) {
    if (channelId == null) return []
    return this._listUsers.all(Number(channelId)).map((row) => row.user_id)
  }

  channelsOfUser(userId) {
    const raw = String(userId || '').trim()
    if (!raw) return []
    return this._channelsOfUser.all(raw).map((row) => Number(row.channel_id))
  }

  addUser(channelId, userId) {
    this._insertUser.run(Number(channelId), String(userId), nowIso())
    return { users: this.listUserIds(channelId) }
  }

  removeUser(channelId, userId) {
    this._deleteUser.run(Number(channelId), String(userId))
    return { users: this.listUserIds(channelId) }
  }
}
