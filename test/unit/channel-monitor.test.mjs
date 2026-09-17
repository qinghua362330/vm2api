import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import {
  ChannelMonitor,
  alertMessage,
  compare,
  evaluateAlerts,
  metricValue,
  percentile,
  summarizeProbes,
} from '../../src/lib/admin/channel-monitor.mjs'

/**
 * 渠道监控：健康度按窗口算，不按最后一笔算；没有样本 ≠ 0%。
 * Alert evaluation is pure so thresholds, minimum samples and cooldown are
 * testable without a timer or a network.
 */

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-chanmon-'))
  const db = createDatabase({ dataDir: dir })
  return { dir, db, monitor: new ChannelMonitor(db) }
}

const T0 = Date.parse('2026-04-01T00:00:00.000Z')

function probe(ok, latency = 100, error = null, offsetMs = 0) {
  return { ok, latency_ms: latency, error, checked_at: new Date(T0 - offsetMs).toISOString() }
}

// ── percentile ──────────────────────────────────────────────────────────────

test('percentile is nearest-rank, not interpolated', () => {
  const values = [10, 20, 30, 40, 50]
  assert.equal(percentile(values, 0.5), 30)
  assert.equal(percentile(values, 0.95), 50)
  assert.equal(percentile(values, 0), 10)
  assert.equal(percentile([], 0.5), null)
  // Nearest-rank never invents a value that was not observed.
  assert.equal(percentile([10, 20], 0.75), 20)
})

// ── summarize ───────────────────────────────────────────────────────────────

test('no samples reports null availability, not 0%', () => {
  const health = summarizeProbes([])
  assert.equal(health.samples, 0)
  assert.equal(health.availability, null, '0% would read as totally down')
  assert.equal(health.latency_p95, null)
  assert.equal(health.consecutive_failures, 0)
})

test('availability and latency come from the probe list', () => {
  const health = summarizeProbes([probe(true, 100), probe(true, 300), probe(false, 50, 'timeout'), probe(true, 200)])
  assert.equal(health.samples, 4)
  assert.equal(health.ok_count, 3)
  assert.equal(health.availability, 0.75)
  assert.equal(health.latency_p50, 200)
  assert.equal(health.latency_p95, 300, 'failures do not contribute a latency')
})

test('consecutive failures count the leading run only', () => {
  const health = summarizeProbes([probe(false), probe(false), probe(false), probe(true), probe(false)])
  assert.equal(health.consecutive_failures, 3)
  const recovered = summarizeProbes([probe(true), probe(false), probe(false)])
  assert.equal(recovered.consecutive_failures, 0)
})

test('last_ok_at and last_error come from the newest relevant probe', () => {
  const health = summarizeProbes([probe(false, 0, 'refused', 0), probe(true, 120, null, 60_000)])
  assert.equal(health.last_error, 'refused')
  assert.equal(health.last_ok_at, new Date(T0 - 60_000).toISOString())
})

// ── metric + compare ────────────────────────────────────────────────────────

test('a metric with too few samples is not evaluated', () => {
  const health = summarizeProbes([probe(true)])
  const rule = { metric: 'availability', min_samples: 3, threshold: 0.9, comparator: 'lt' }
  assert.equal(metricValue(rule, health), null, 'one sample must not fire an alert')
})

test('consecutive failures is available without a filled latency window', () => {
  const health = summarizeProbes([probe(false), probe(false)])
  const rule = { metric: 'consecutive_failures', min_samples: 1, threshold: 1, comparator: 'gt' }
  assert.equal(metricValue(rule, health), 2)
})

test('compare handles both directions and rejects a missing value', () => {
  assert.equal(compare(0.5, 'lt', 0.9), true)
  assert.equal(compare(0.95, 'lt', 0.9), false)
  assert.equal(compare(500, 'gt', 300), true)
  assert.equal(compare(null, 'gt', 0), false)
  assert.equal(compare(500, 'gt', Number.NaN), false)
})

// ── evaluateAlerts ──────────────────────────────────────────────────────────

function ruleFixture(over = {}) {
  return {
    id: 1,
    name: '可用率',
    channel_id: null,
    metric: 'availability',
    comparator: 'lt',
    threshold: 0.9,
    window_minutes: 30,
    min_samples: 1,
    severity: 'warn',
    enabled: true,
    cooldown_minutes: 30,
    last_fired_at: null,
    ...over,
  }
}

test('a breached rule fires for every matching channel', () => {
  const health = new Map([
    [1, summarizeProbes([probe(false), probe(false)])],
    [2, summarizeProbes([probe(true), probe(true)])],
  ])
  const { fire, suppressed } = evaluateAlerts({ rules: [ruleFixture()], healthByChannel: health, now: T0 })
  assert.equal(fire.length, 1)
  assert.equal(fire[0].channelId, 1)
  assert.equal(suppressed.length, 0)
})

test('cooldown suppresses a repeat and says when it clears', () => {
  const health = new Map([[1, summarizeProbes([probe(false), probe(false)])]])
  const rule = ruleFixture({ last_fired_at: new Date(T0 - 5 * 60_000).toISOString(), cooldown_minutes: 30 })

  const held = evaluateAlerts({ rules: [rule], healthByChannel: health, now: T0 })
  assert.equal(held.fire.length, 0)
  assert.equal(held.suppressed.length, 1)
  assert.equal(held.suppressed[0].reason, 'cooldown')
  assert.ok(held.suppressed[0].retry_at)

  const later = evaluateAlerts({ rules: [rule], healthByChannel: health, now: T0 + 31 * 60_000 })
  assert.equal(later.fire.length, 1, 'past the cooldown it fires again')
})

test('a disabled rule never fires', () => {
  const health = new Map([[1, summarizeProbes([probe(false), probe(false)])]])
  const { fire } = evaluateAlerts({ rules: [ruleFixture({ enabled: false })], healthByChannel: health, now: T0 })
  assert.equal(fire.length, 0)
})

test('a channel-scoped rule only looks at its own channel', () => {
  const health = new Map([
    [1, summarizeProbes([probe(false), probe(false)])],
    [2, summarizeProbes([probe(false), probe(false)])],
  ])
  const { fire } = evaluateAlerts({ rules: [ruleFixture({ channel_id: 2 })], healthByChannel: health, now: T0 })
  assert.equal(fire.length, 1)
  assert.equal(fire[0].channelId, 2)
})

test('a healthy channel never fires', () => {
  const health = new Map([[1, summarizeProbes([probe(true), probe(true), probe(true)])]])
  const { fire } = evaluateAlerts({ rules: [ruleFixture()], healthByChannel: health, now: T0 })
  assert.equal(fire.length, 0)
})

test('alertMessage names the metric, the value and the threshold', () => {
  const msg = alertMessage({ rule: ruleFixture(), channelId: 3, value: 0.5 })
  assert.match(msg, /渠道 #3/)
  assert.match(msg, /可用率/)
  assert.match(msg, /50\.0%/)
  assert.match(msg, /<\s*90%/)
})

// ── persistence ─────────────────────────────────────────────────────────────

test('probes persist and window filtering excludes old rows', () => {
  const { monitor } = tmp()
  monitor.recordProbe({ channelId: 1, egressId: 'px-a', ok: true, latencyMs: 120, now: T0 })
  monitor.recordProbe({ channelId: 1, egressId: 'px-a', ok: false, error: 'refused', now: T0 + 1000 })

  const recent = monitor.probes({ channelId: 1, windowMinutes: 60, now: T0 + 2000 })
  assert.equal(recent.length, 2)
  assert.equal(recent[0].ok, false, 'newest first')
  assert.equal(recent[0].error, 'refused')

  const old = monitor.probes({ channelId: 1, windowMinutes: 60, now: T0 + 10 * 60 * 60 * 1000 })
  assert.equal(old.length, 0)
})

test('a probe without an egress is refused', () => {
  const { monitor } = tmp()
  assert.equal(monitor.recordProbe({ channelId: 1, egressId: '' }).ok, false)
  assert.equal(monitor.recordProbe({ channelId: 1 }).reason, 'egress_required')
})

test('healthByChannel only covers channels that actually reported', () => {
  const { monitor } = tmp()
  monitor.recordProbe({ channelId: 7, egressId: 'px-a', ok: true, latencyMs: 90, now: T0 })
  const health = monitor.healthByChannel({ windowMinutes: 30, now: T0 + 1000 })
  assert.equal(health.has(7), true)
  assert.equal(health.get(7).availability, 1)
  assert.equal(health.has(8), false, 'an unprobed channel is absent, not 0%')
})

test('healthByEgress points at the offending bucket', () => {
  const { monitor } = tmp()
  monitor.recordProbe({ channelId: 1, egressId: 'px-good', ok: true, latencyMs: 100, now: T0 })
  monitor.recordProbe({ channelId: 1, egressId: 'px-bad', ok: false, error: 'timeout', now: T0 })
  const perEgress = monitor.healthByEgress({ channelId: 1, egressIds: ['px-good', 'px-bad'], now: T0 + 1000 })
  assert.equal(perEgress.get('px-good').availability, 1)
  assert.equal(perEgress.get('px-bad').availability, 0)
  assert.equal(perEgress.get('px-bad').last_error, 'timeout')
})

test('runAlerts records the event and stamps the rule for cooldown', () => {
  const { monitor } = tmp()
  const rule = monitor.createRule({
    name: '可用率',
    metric: 'availability',
    comparator: 'lt',
    threshold: 0.9,
    min_samples: 1,
    cooldown_minutes: 30,
  })
  monitor.recordProbe({ channelId: 1, egressId: 'px-a', ok: false, error: 'down', now: T0 })

  const first = monitor.runAlerts({ now: T0 })
  assert.equal(first.fired.length, 1)
  assert.equal(monitor.getRule(rule.id).last_fired_at, new Date(T0).toISOString())
  assert.equal(monitor.listEvents().length, 1)

  const second = monitor.runAlerts({ now: T0 + 1000 })
  assert.equal(second.fired.length, 0, 'the cooldown is written back, not just computed')
  assert.equal(second.suppressed.length, 1)
  assert.equal(monitor.listEvents().length, 1)
})

test('rule CRUD validates and defaults sensibly', () => {
  const { monitor } = tmp()
  assert.throws(() => monitor.createRule({ name: '' }), /name is required/)
  assert.throws(() => monitor.createRule({ name: 'x' }), /threshold is required/)

  // A threshold has no safe default: the wrong one fires alerts nobody asked
  // for, so it is required rather than guessed.
  assert.throws(() => monitor.createRule({ name: '慢', metric: 'latency_p95' }), /threshold is required/)

  const rule = monitor.createRule({ name: '慢', metric: 'latency_p95', threshold: 300 })
  assert.equal(rule.comparator, 'gt', 'latency defaults to greater-than')
  assert.equal(rule.enabled, true)
  assert.equal(rule.severity, 'warn')

  const availability = monitor.createRule({ name: '掉线', metric: 'availability', threshold: 0.9 })
  assert.equal(availability.comparator, 'lt')

  const updated = monitor.updateRule(rule.id, { threshold: 800, enabled: false })
  assert.equal(updated.threshold, 800)
  assert.equal(updated.enabled, false)

  assert.equal(monitor.removeRule(rule.id).removed, true)
  assert.equal(monitor.getRule(rule.id), null)
})

test('an unknown metric or severity is not written', () => {
  const { monitor } = tmp()
  const rule = monitor.createRule({ name: 'x', metric: 'nonsense', threshold: 1, severity: 'apocalyptic' })
  assert.equal(rule.metric, 'availability')
  assert.equal(rule.severity, 'warn')

  const patched = monitor.updateRule(rule.id, { metric: 'also-nonsense', severity: 'nope' })
  assert.equal(patched.metric, 'availability')
  assert.equal(patched.severity, 'warn')
})

test('pruning drops only old probes', () => {
  const { monitor } = tmp()
  const old = T0 - 30 * 24 * 60 * 60 * 1000
  monitor.recordProbe({ channelId: 1, egressId: 'px-a', ok: true, now: old })
  monitor.recordProbe({ channelId: 1, egressId: 'px-a', ok: true, now: T0 })

  const res = monitor.pruneProbes(14, T0)
  assert.equal(res.removed, 1)
  assert.equal(monitor.probes({ channelId: 1, windowMinutes: 60 * 24, now: T0 }).length, 1)
})
