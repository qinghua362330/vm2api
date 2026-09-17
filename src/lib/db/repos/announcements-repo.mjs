/**
 * announcements repository — operator notices for the console / user pages.
 *
 * Levels and audience mirror sub2api's: a notice can target everyone, a role, or
 * one user, and it can be scheduled (starts_at / ends_at) or pinned. Draft and
 * archived rows stay in the table so a notice can be rewritten and republished
 * rather than recreated.
 */

import { getDb } from '../database.mjs'

export const ANNOUNCEMENT_LEVELS = Object.freeze(['info', 'warn', 'critical'])
export const ANNOUNCEMENT_STATUSES = Object.freeze(['draft', 'published', 'archived'])

function nowIso() {
  return new Date().toISOString()
}

function rowToRec(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    title: row.title,
    body: row.body || '',
    level: row.level || 'info',
    status: row.status || 'published',
    audience: row.audience || 'all',
    pinned: Number(row.pinned) === 1,
    starts_at: row.starts_at ?? null,
    ends_at: row.ends_at ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  }
}

/** Visible to `viewer` right now: published, inside its window, audience matches. */
export function isVisibleTo(rec, { viewerId = null, viewerRole = 'user', now = Date.now() } = {}) {
  if (!rec || rec.status !== 'published') return false
  if (rec.starts_at && Date.parse(rec.starts_at) > now) return false
  if (rec.ends_at && Date.parse(rec.ends_at) < now) return false
  const audience = String(rec.audience || 'all')
  if (audience === 'all') return true
  if (audience.startsWith('role:')) return audience.slice(5) === String(viewerRole || '')
  if (audience.startsWith('user:')) return audience.slice(5) === String(viewerId || '')
  return false
}

export class AnnouncementsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._list = db.prepare('SELECT * FROM announcements WHERE deleted_at IS NULL ORDER BY pinned DESC, id DESC')
    this._listLive = db.prepare(
      `SELECT * FROM announcements
        WHERE deleted_at IS NULL AND status = 'published'
        ORDER BY pinned DESC, id DESC`,
    )
    this._get = db.prepare('SELECT * FROM announcements WHERE id = ? AND deleted_at IS NULL')
    this._insert = db.prepare(`
      INSERT INTO announcements
        (title, body, level, status, audience, pinned, starts_at, ends_at, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this._update = db.prepare(`
      UPDATE announcements
         SET title = ?, body = ?, level = ?, status = ?, audience = ?, pinned = ?,
             starts_at = ?, ends_at = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
    `)
    this._softDelete = db.prepare('UPDATE announcements SET deleted_at = ?, updated_at = ? WHERE id = ?')
  }

  list() {
    return this._list.all().map(rowToRec)
  }

  get(id) {
    if (id == null) return null
    return rowToRec(this._get.get(Number(id)))
  }

  /** What a given viewer should see: the live window, filtered by audience. */
  visible({ viewerId = null, viewerRole = 'user', now = Date.now() } = {}) {
    return this._listLive
      .all()
      .map(rowToRec)
      .filter((rec) => isVisibleTo(rec, { viewerId, viewerRole, now }))
  }

  create(input = {}) {
    const title = String(input.title || '').trim()
    if (!title) throw new Error('title is required')
    const stamp = nowIso()
    const info = this._insert.run(
      title,
      String(input.body || ''),
      ANNOUNCEMENT_LEVELS.includes(input.level) ? input.level : 'info',
      ANNOUNCEMENT_STATUSES.includes(input.status) ? input.status : 'published',
      String(input.audience || 'all'),
      input.pinned ? 1 : 0,
      input.starts_at ?? null,
      input.ends_at ?? null,
      input.created_by ?? null,
      stamp,
      stamp,
    )
    return this.get(info.lastInsertRowid)
  }

  update(id, patch = {}) {
    const current = this.get(id)
    if (!current) return null
    this._update.run(
      patch.title == null ? current.title : String(patch.title).trim() || current.title,
      patch.body == null ? current.body : String(patch.body),
      patch.level == null ? current.level : ANNOUNCEMENT_LEVELS.includes(patch.level) ? patch.level : current.level,
      patch.status == null
        ? current.status
        : ANNOUNCEMENT_STATUSES.includes(patch.status)
          ? patch.status
          : current.status,
      patch.audience == null ? current.audience : String(patch.audience),
      patch.pinned == null ? (current.pinned ? 1 : 0) : patch.pinned ? 1 : 0,
      patch.starts_at === undefined ? current.starts_at : patch.starts_at,
      patch.ends_at === undefined ? current.ends_at : patch.ends_at,
      nowIso(),
      Number(id),
    )
    return this.get(id)
  }

  remove(id) {
    const stamp = nowIso()
    return this._softDelete.run(stamp, stamp, Number(id)).changes > 0
  }
}
