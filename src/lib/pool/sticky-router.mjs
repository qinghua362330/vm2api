/**
 * Configurable sticky / conversation-continuity routing (SQLite-backed).
 * Binds conversation key → account/VM for the TTL window.
 */

import crypto from 'node:crypto'
import { resolveStoreDb } from '../db/database.mjs'
import { StickyRepo } from '../db/repos/sticky-repo.mjs'
import { extractCallerSession, parseUserId } from '../identity/identity-rewrite.mjs'

export const DEFAULT_STICKY_HEADER_KEYS = [
  'x-session-id',
  'x-conversation-id',
  'x-claude-code-session-id',
  'session-id',
  'thread-id',
]

export const DEFAULT_STICKY_BODY_KEYS = ['conversation_id', 'session_id', 'thread_id', 'prompt_cache_key']

/** Per-request ids — never use as a conversation key. */
export const EPHEMERAL_STICKY_KEYS = new Set(['x-client-request-id', 'x-request-id'])

function mergeStickyConfig(config) {
  const sticky = config?.sticky || {}
  const headerKeys = (
    Array.isArray(sticky.header_keys) && sticky.header_keys.length ? sticky.header_keys : DEFAULT_STICKY_HEADER_KEYS
  ).filter((k) => !EPHEMERAL_STICKY_KEYS.has(String(k).toLowerCase()))
  return {
    enabled: sticky.enabled !== false,
    mode: sticky.mode || 'conversation',
    ttl_seconds: sticky.ttl_seconds || 86400,
    header_keys: headerKeys,
    body_keys: Array.isArray(sticky.body_keys) && sticky.body_keys.length ? sticky.body_keys : DEFAULT_STICKY_BODY_KEYS,
  }
}

export function clientIp(req) {
  const headers = req?.headers || {}
  const xf = String(headers['x-forwarded-for'] || headers['X-Forwarded-For'] || '')
    .split(',')[0]
    .trim()
  const raw = xf || req?.socket?.remoteAddress || req?.ip || ''
  return String(raw)
    .replace(/^::ffff:/, '')
    .slice(0, 45)
}

export function firstUserFingerprint(body = {}) {
  const msgs = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : []
  const user = msgs.find((m) => String(m?.role || m?.type || '').toLowerCase() === 'user') || msgs[0]
  let text = ''
  if (user) {
    const c = user.content ?? user.text ?? user.input
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) {
      text = c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n')
    }
  } else if (typeof body?.input === 'string') {
    text = body.input
  } else if (typeof body?.prompt === 'string') {
    text = body.prompt
  }
  text = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000)
  if (!text) return ''
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 24)
}

export class StickyRouter {
  constructor({ dataDir, db, config, onSessionMove = null }) {
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new StickyRepo(this.db)
    this.config = mergeStickyConfig(config)
    /** Called when a conversation is rebound to a different slot. */
    this.onSessionMove = typeof onSessionMove === 'function' ? onSessionMove : null
  }

  /** Kept for API compat + post-restore hook (state lives in DB). */
  reload() {}

  /** Re-bind to a fresh DB connection (after backup restore). */
  rebind(db) {
    this.db = db
    this.repo = new StickyRepo(db)
  }

  isolateKey(raw, req = null) {
    const id = req?.apiKeyRecord?.id
    if (id == null || id === '') return String(raw)
    return `k${id}:${raw}`
  }

  extractKey(req, body = {}) {
    if (!this.config.enabled) return null
    const mode = this.config.mode || 'conversation'

    if (mode === 'ip') {
      const ip = clientIp(req)
      return ip ? this.isolateKey(`ip:${ip}`, req) : null
    }
    if (mode === 'session') {
      const id = req?.apiKeyRecord?.id
      if (id != null && id !== '') return `k${id}:login`
      const auth = String(req?.headers?.authorization || req?.headers?.['x-api-key'] || '').trim()
      if (auth) {
        return this.isolateKey(`login:${crypto.createHash('sha256').update(auth).digest('hex').slice(0, 24)}`, req)
      }
      const ip = clientIp(req)
      return ip ? this.isolateKey(`ip:${ip}`, req) : null
    }

    const caller = extractCallerSession({ inbound: body, body, headers: req?.headers || {} })
    if (caller && !EPHEMERAL_STICKY_KEYS.has(String(caller).toLowerCase())) {
      return this.isolateKey(caller, req)
    }
    for (const k of this.config.header_keys || []) {
      const key = String(k).toLowerCase()
      if (EPHEMERAL_STICKY_KEYS.has(key)) continue
      const v = req?.headers?.[key] || req?.headers?.[k]
      if (v) return this.isolateKey(String(v), req)
    }
    for (const k of this.config.body_keys || []) {
      if (body?.[k]) return this.isolateKey(String(body[k]), req)
    }
    const fp = firstUserFingerprint(body)
    if (fp) return this.isolateKey(`ch:${fp}`, req)
    return null
  }

  /**
   * Official Claude Code parent + child hops share metadata.user_id.device_id
   * even when the child mints a new session_id. Bind the family to one account.
   *
   * Agent / local-agent sub-agents are classified unofficial for persona
   * (oh-my-pi stealth), but they still send the parent device_id. Pool
   * sticky must use this key regardless of officialTraffic.
   */
  extractOfficialFamilyKey(req, body = {}) {
    if (!this.config.enabled) return null
    const parsed = parseUserId(body?.metadata?.user_id)
    const device = String(parsed?.device_id || '').trim()
    if (!device) return null
    return this.isolateKey(`dev:${device}`, req)
  }

  /** Prefer device family, then per-hop session. Same account for parent + sub-agent. */
  extractPoolKey(req, body = {}) {
    return this.extractOfficialFamilyKey(req, body) || this.extractKey(req, body)
  }

  /** All keys that should bind to the selected account for this request. */
  collectPoolKeys(req, body = {}) {
    const keys = []
    const family = this.extractOfficialFamilyKey(req, body)
    const session = this.extractKey(req, body)
    if (family) keys.push(family)
    if (session && session !== family) keys.push(session)
    return keys
  }

  /** @returns {{ accountId: string, vmId: string, userId: string|null, egressId: string|null } | null } */
  resolve(key) {
    if (!key || !this.config.enabled) return null
    this._purge()
    const ent = this.repo.get(key)
    if (!ent) return null
    if (Date.now() > ent.expires_at) {
      this.repo.remove(key)
      return null
    }
    return {
      accountId: ent.account_id,
      vmId: ent.vm_id,
      sessionId: ent.session_id || null,
      userId: ent.user_id || null,
      egressId: ent.egress_id || null,
      hits: ent.hits || 0,
      key,
    }
  }

  /**
   * Pin a conversation to a slot.
   *
   * `userId` and `egressId` are what let the scheduler check the pin against the
   * user's buckets, and let the console show which IP a conversation is on. A
   * change of vmId is reported through `onMove` so a conversation that had to
   * leave its bucket is auditable rather than silent.
   */
  bind(key, { accountId, vmId, sessionId = null, userId = null, egressId = null } = {}, { countHit = true } = {}) {
    if (!key || !this.config.enabled) return
    const ttl = (this.config.ttl_seconds || 86400) * 1000
    const prev = this.repo.get(key) || {}
    const moved = !!prev.vm_id && !!vmId && prev.vm_id !== vmId
    this.repo.upsert(key, {
      account_id: accountId,
      vm_id: vmId,
      session_id: sessionId || prev.session_id || null,
      user_id: userId || prev.user_id || null,
      egress_id: egressId || prev.egress_id || null,
      bound_at: Date.now(),
      expires_at: Date.now() + ttl,
      hits: (prev.hits || 0) + (countHit ? 1 : 0),
    })
    if (moved && typeof this.onSessionMove === 'function') {
      try {
        this.onSessionMove({
          key,
          userId: userId || prev.user_id || null,
          fromVmId: prev.vm_id,
          toVmId: vmId,
          fromEgressId: prev.egress_id || null,
          toEgressId: egressId || null,
        })
      } catch {}
    }
  }

  unbind(key) {
    if (!key) return
    this.repo.remove(key)
  }

  unbindByAccount({ accountId = null, vmId = null } = {}) {
    return this.repo.removeByAccount({ accountId, vmId })
  }

  _purge() {
    this.repo.purgeExpired(Date.now())
  }

  stats() {
    this._purge()
    const sessions = this.repo.all()
    const list = Object.values(sessions || {})
    return {
      enabled: !!this.config.enabled,
      mode: this.config.mode,
      active_sessions: Object.keys(sessions).length,
      total_hits: list.reduce((n, s) => n + (Number(s.hits) || 0), 0),
      sessions,
    }
  }

  reloadConfig(config) {
    this.config = mergeStickyConfig(config)
  }
}
