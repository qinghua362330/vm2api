/**
 * 渠道监控 — availability and latency history, and the rules that turn it into
 * alerts.
 *
 * The proxy probe already measures a SOCKS handshake and an egress check; what
 * was missing was memory. A proxy row keeps the latest latency and nothing else,
 * so "has this channel been flaky all morning" could not be answered. Probes land
 * here, and health is computed from a window rather than from the last sample.
 *
 * Alert evaluation is pure: given rules, health and a clock it returns which fire
 * and which are suppressed. That keeps the interesting part (thresholds, minimum
 * samples, cooldown) testable without a timer or a network.
 */

import { getDb } from '../db/database.mjs'

export const ALERT_METRICS = Object.freeze(['availability', 'latency_p95', 'consecutive_failures'])
export const ALERT_COMPARATORS = Object.freeze(['lt', 'gt'])
export const ALERT_SEVERITIES = Object.freeze(['info', 'warn', 'critical'])

function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString()
}

/**
 * Nearest-rank percentile over an ascending array.
 * Nearest-rank (not interpolation) because with a handful of probes an
 * interpolated p95 reports a latency that was never observed.
 */
export function percentile(sortedAsc, p) {
  if (!Array.isArray(sortedAsc) || !sortedAsc.length) return null
  const q = Math.min(1, Math.max(0, Number(p) || 0))
  const rank = Math.ceil(q * sortedAsc.length)
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))]
}

function rowToProbe(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    channel_id: row.channel_id == null ? null : Number(row.channel_id),
    egress_id: row.egress_id,
    ok: Number(row.ok) === 1,
    latency_ms: row.latency_ms == null ? null : Number(row.latency_ms),
    status_code: row.status_code == null ? null : Number(row.status_code),
    scope: row.scope ?? null,
    error: row.error ?? null,
    checked_at: row.checked_at,
  }
}

function rowToRule(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    name: row.name,
    channel_id: row.channel_id == null ? null : Number(row.channel_id),
    metric: row.metric,
    comparator: row.comparator,
    threshold: Number(row.threshold),
    window_minutes: Number(row.window_minutes) || 30,
    min_samples: Number(row.min_samples) || 3,
    severity: row.severity || 'warn',
    enabled: Number(row.enabled) === 1,
    cooldown_minutes: Number(row.cooldown_minutes) || 30,
    last_fired_at: row.last_fired_at ?? null,
  }
}

/**
 * Compute health for one egress (or a whole channel) from its probes.
 * `availability` is null when there are no samples — distinct from 0%, which
 * would read as "totally down" and fire an alert on a channel nobody has probed.
 */
export function summarizeProbes(probes = []) {
  const total = probes.length
  if (!total) {
    return {
      samples: 0,
      ok_count: 0,
      availability: null,
      latency_p50: null,
      latency_p95: null,
      consecutive_failures: 0,
      last_ok_at: null,
      last_error: null,
    }
  }
  const okCount = probes.filter((p) => p.ok).length
  const latencies = probes
    .filter((p) => p.ok && Number.isFinite(p.latency_ms))
    .map((p) => p.latency_ms)
    .sort((a, b) => a - b)

  // Probes arrive newest-first; consecutive failures is the leading run.
  let consecutive = 0
  for (const probe of probes) {
    if (probe.ok) break
    consecutive++
  }
  const lastOk = probes.find((p) => p.ok) || null
  const lastFail = probes.find((p) => !p.ok) || null
  return {
    samples: total,
    ok_count: okCount,
    availability: okCount / total,
    latency_p50: percentile(latencies, 0.5),
    latency_p95: percentile(latencies, 0.95),
    consecutive_failures: consecutive,
    last_ok_at: lastOk?.checked_at ?? null,
    last_error: lastFail?.error ?? null,
  }
}

/** The value a rule compares against, or null when the metric has no samples. */
export function metricValue(rule, health) {
  if (!rule || !health) return null
  if (health.samples < Math.max(1, Number(rule.min_samples) || 1)) return null
  switch (rule.metric) {
    case 'availability':
      return health.availability
    case 'latency_p95':
      return health.latency_p95
    case 'consecutive_failures':
      // Always available: a slot that has failed five times in a row is a fact
      // even when a latency window has not filled yet.
      return health.consecutive_failures
    default:
      return null
  }
}

export function compare(value, comparator, threshold) {
  if (value == null) return false
  const t = Number(threshold)
  if (!Number.isFinite(t)) return false
  return comparator === 'gt' ? Number(value) > t : Number(value) < t
}

/**
 * Decide which rules fire.
 *
 * Pure: `healthByChannel` is a map of channelId → health, and `now` is injected.
 * Cooldown is honoured so a rule cannot fire on every tick.
 *
 * @returns {{fire: object[], suppressed: object[]}}
 */
export function evaluateAlerts({ rules = [], healthByChannel = new Map(), now = Date.now() } = {}) {
  const fire = []
  const suppressed = []
  for (const rule of rules) {
    if (!rule.enabled) continue
    const keys = rule.channel_id == null ? [...healthByChannel.keys()] : [rule.channel_id]
    for (const channelId of keys) {
      const health = healthByChannel.get(channelId)
      if (!health) continue
      const value = metricValue(rule, health)
      if (!compare(value, rule.comparator, rule.threshold)) continue

      const last = Date.parse(rule.last_fired_at || '')
      const cooldownMs = Math.max(0, Number(rule.cooldown_minutes) || 0) * 60 * 1000
      if (Number.isFinite(last) && now - last < cooldownMs) {
        suppressed.push({ rule, channelId, value, reason: 'cooldown', retry_at: nowIso(last + cooldownMs) })
        continue
      }
      fire.push({ rule, channelId, value, health })
    }
  }
  return { fire, suppressed }
}

export function alertMessage({ rule, channelId, value }) {
  const metricLabel = {
    availability: '可用率',
    latency_p95: 'P95 延迟',
    consecutive_failures: '连续失败',
  }[rule.metric] || rule.metric
  const formatted =
    rule.metric === 'availability'
      ? `${(Number(value) * 100).toFixed(1)}%`
      : rule.metric === 'latency_p95'
        ? `${Math.round(Number(value))}ms`
        : `${Number(value)} 次`
  const bound = rule.metric === 'availability' ? `${(rule.threshold * 100).toFixed(0)}%` : rule.threshold
  const where = channelId == null ? '全部渠道' : `渠道 #${channelId}`
  return `${where} ${metricLabel} ${formatted}（阈值 ${rule.comparator === 'gt' ? '>' : '<'} ${bound}，窗口 ${rule.window_minutes} 分钟）`
}

export class ChannelMonitor {
  constructor(db = getDb()) {
    this.db = db
    this._insertProbe = db.prepare(`
      INSERT INTO channel_probes (channel_id, egress_id, ok, latency_ms, status_code, scope, error, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this._probesByChannel = db.prepare(
      'SELECT * FROM channel_probes WHERE channel_id = ? AND checked_at >= ? ORDER BY id DESC LIMIT ?',
    )
    this._probesByEgress = db.prepare(
      'SELECT * FROM channel_probes WHERE egress_id = ? AND checked_at >= ? ORDER BY id DESC LIMIT ?',
    )
    this._recentProbes = db.prepare('SELECT * FROM channel_probes WHERE checked_at >= ? ORDER BY id DESC LIMIT ?')
    this._distinctChannels = db.prepare(
      'SELECT DISTINCT channel_id FROM channel_probes WHERE checked_at >= ? AND channel_id IS NOT NULL',
    )
    this._pruneProbes = db.prepare('DELETE FROM channel_probes WHERE checked_at < ?')

    this._listRules = db.prepare('SELECT * FROM channel_alert_rules ORDER BY id')
    this._getRule = db.prepare('SELECT * FROM channel_alert_rules WHERE id = ?')
    this._insertRule = db.prepare(`
      INSERT INTO channel_alert_rules
        (name, channel_id, metric, comparator, threshold, window_minutes, min_samples, severity, enabled, cooldown_minutes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this._updateRule = db.prepare(`
      UPDATE channel_alert_rules
         SET name = ?, channel_id = ?, metric = ?, comparator = ?, threshold = ?, window_minutes = ?,
             min_samples = ?, severity = ?, enabled = ?, cooldown_minutes = ?, updated_at = ?
       WHERE id = ?
    `)
    this._touchRule = db.prepare('UPDATE channel_alert_rules SET last_fired_at = ?, updated_at = ? WHERE id = ?')
    this._deleteRule = db.prepare('DELETE FROM channel_alert_rules WHERE id = ?')

    this._insertEvent = db.prepare(`
      INSERT INTO channel_alert_events (rule_id, channel_id, metric, value, threshold, severity, message, fired_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this._listEvents = db.prepare('SELECT * FROM channel_alert_events ORDER BY id DESC LIMIT ?')
  }

  recordProbe({ channelId = null, egressId, ok, latencyMs = null, statusCode = null, scope = null, error = null, now = Date.now() } = {}) {
    const egress = String(egressId || '').trim()
    if (!egress) return { ok: false, reason: 'egress_required' }
    this._insertProbe.run(
      channelId == null ? null : Number(channelId),
      egress,
      ok ? 1 : 0,
      Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null,
      Number.isFinite(Number(statusCode)) ? Number(statusCode) : null,
      scope == null ? null : String(scope),
      error == null ? null : String(error).slice(0, 500),
      nowIso(now),
    )
    return { ok: true }
  }

  windowStart(minutes, now = Date.now()) {
    return nowIso(now - Math.max(1, Number(minutes) || 30) * 60 * 1000)
  }

  probes({ channelId = null, egressId = null, windowMinutes = 60, now = Date.now(), limit = 500 } = {}) {
    const since = this.windowStart(windowMinutes, now)
    const n = Math.max(1, Math.min(2000, Number(limit) || 500))
    if (egressId) return this._probesByEgress.all(String(egressId), since, n).map(rowToProbe)
    if (channelId != null) return this._probesByChannel.all(Number(channelId), since, n).map(rowToProbe)
    return this._recentProbes.all(since, n).map(rowToProbe)
  }

  /** Health per channel over the window, for the console and the rule engine. */
  healthByChannel({ windowMinutes = 30, now = Date.now(), channelIds = null } = {}) {
    const ids = channelIds || this._distinctChannels.all(this.windowStart(windowMinutes, now)).map((r) => Number(r.channel_id))
    const out = new Map()
    for (const id of ids) {
      out.set(Number(id), summarizeProbes(this.probes({ channelId: id, windowMinutes, now })))
    }
    return out
  }

  /** Health per egress inside one channel — which bucket is the problem. */
  healthByEgress({ channelId = null, egressIds = [], windowMinutes = 30, now = Date.now() } = {}) {
    const out = new Map()
    for (const egressId of egressIds) {
      out.set(egressId, summarizeProbes(this.probes({ egressId, windowMinutes, now })))
    }
    return out
  }

  // ── rules ──

  listRules() {
    return this._listRules.all().map(rowToRule)
  }

  getRule(id) {
    if (id == null) return null
    return rowToRule(this._getRule.get(Number(id)))
  }

  createRule(input = {}) {
    const name = String(input.name || '').trim()
    if (!name) throw new Error('rule name is required')
    const metric = ALERT_METRICS.includes(input.metric) ? input.metric : 'availability'
    const comparator = ALERT_COMPARATORS.includes(input.comparator) ? input.comparator : metric === 'availability' ? 'lt' : 'gt'
    const threshold = Number(input.threshold)
    if (!Number.isFinite(threshold)) throw new Error('threshold is required')
    const stamp = nowIso()
    const info = this._insertRule.run(
      name,
      input.channel_id == null ? null : Number(input.channel_id),
      metric,
      comparator,
      threshold,
      Math.max(1, Number(input.window_minutes) || 30),
      Math.max(1, Number(input.min_samples) || 3),
      ALERT_SEVERITIES.includes(input.severity) ? input.severity : 'warn',
      input.enabled === false ? 0 : 1,
      Math.max(0, Number(input.cooldown_minutes) || 30),
      stamp,
      stamp,
    )
    return this.getRule(info.lastInsertRowid)
  }

  updateRule(id, patch = {}) {
    const current = this.getRule(id)
    if (!current) return null
    const metric = ALERT_METRICS.includes(patch.metric) ? patch.metric : current.metric
    this._updateRule.run(
      patch.name == null ? current.name : String(patch.name).trim() || current.name,
      patch.channel_id === undefined ? current.channel_id : patch.channel_id == null ? null : Number(patch.channel_id),
      metric,
      ALERT_COMPARATORS.includes(patch.comparator) ? patch.comparator : current.comparator,
      patch.threshold == null ? current.threshold : Number(patch.threshold),
      patch.window_minutes == null ? current.window_minutes : Math.max(1, Number(patch.window_minutes)),
      patch.min_samples == null ? current.min_samples : Math.max(1, Number(patch.min_samples)),
      ALERT_SEVERITIES.includes(patch.severity) ? patch.severity : current.severity,
      patch.enabled == null ? (current.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
      patch.cooldown_minutes == null ? current.cooldown_minutes : Math.max(0, Number(patch.cooldown_minutes)),
      nowIso(),
      Number(id),
    )
    return this.getRule(id)
  }

  removeRule(id) {
    return { removed: this._deleteRule.run(Number(id)).changes > 0 }
  }

  // ── alerts ──

  /**
   * Evaluate every enabled rule against current health and record what fires.
   * The cooldown is written back to the rule so the next tick stays quiet.
   */
  runAlerts({ windowMinutes = null, now = Date.now() } = {}) {
    const rules = this.listRules()
    const byRuleWindow = new Map()
    for (const rule of rules) {
      const w = windowMinutes || rule.window_minutes
      if (!byRuleWindow.has(w)) byRuleWindow.set(w, this.healthByChannel({ windowMinutes: w, now }))
    }
    const fired = []
    const suppressed = []
    for (const rule of rules) {
      const health = byRuleWindow.get(windowMinutes || rule.window_minutes)
      const { fire, suppressed: held } = evaluateAlerts({ rules: [rule], healthByChannel: health, now })
      suppressed.push(...held)
      for (const hit of fire) {
        const message = alertMessage(hit)
        this._insertEvent.run(
          rule.id,
          hit.channelId,
          rule.metric,
          hit.value == null ? null : Number(hit.value),
          rule.threshold,
          rule.severity,
          message,
          nowIso(now),
        )
        this._touchRule.run(nowIso(now), nowIso(now), rule.id)
        fired.push({ ...hit, message })
      }
    }
    return { fired, suppressed, rules: rules.length }
  }

  listEvents(limit = 100) {
    return this._listEvents.all(Math.max(1, Math.min(1000, Number(limit) || 100))).map((row) => ({
      id: Number(row.id),
      rule_id: Number(row.rule_id),
      channel_id: row.channel_id == null ? null : Number(row.channel_id),
      metric: row.metric,
      value: row.value == null ? null : Number(row.value),
      threshold: row.threshold == null ? null : Number(row.threshold),
      severity: row.severity,
      message: row.message,
      fired_at: row.fired_at,
    }))
  }

  /** Retention for probe history. */
  pruneProbes(days = 14, now = Date.now()) {
    const cutoff = nowIso(now - Math.max(1, Number(days) || 14) * 24 * 60 * 60 * 1000)
    return { removed: this._pruneProbes.run(cutoff).changes }
  }
}
