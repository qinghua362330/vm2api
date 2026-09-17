/**
 * 运营大盘 — one screen over the business the last rounds built.
 *
 * The existing dashboard is a fleet view (slots, proxies, credentials). This is
 * the other half: money in, money owed, usage, channel health, and what has been
 * alerting. They are separate queries on purpose — the fleet view is read every
 * few seconds by whoever is watching slots, the ops view is read a few times a
 * day by whoever is watching the business, and joining them would make both slow.
 *
 * The aggregation helpers are pure so the parts that can be wrong quietly
 * (gap-filling a series, period-over-period deltas, conversion) are testable
 * without a database.
 */

import { getDb } from '../db/database.mjs'
import { OrderService } from '../payment/orders.mjs'
import { SubscriptionService } from '../billing/subscription-service.mjs'
import { BalanceLedger } from '../billing/balance-ledger.mjs'
import { ChannelMonitor } from './channel-monitor.mjs'
import { ChannelsRepo } from '../db/repos/channels-repo.mjs'
import { EgressBindingsRepo } from '../db/repos/egress-bindings-repo.mjs'

export const DAY_MS = 24 * 60 * 60 * 1000

/** yyyy-mm-dd in UTC — the bucket key for every daily series. */
export function dayKey(iso) {
  const ms = typeof iso === 'number' ? iso : Date.parse(String(iso || ''))
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Bucket rows into a dense daily series.
 *
 * Gaps are filled with zero. A chart built from sparse buckets silently lies:
 * a day with no sales disappears and the line looks continuous across it.
 */
// Option names are `value` / `at` on purpose: `valueOf`, `toString` and
// `constructor` are inherited by every plain object, so a destructuring default
// for those names never fires and you silently get Object.prototype.valueOf.
export function bucketByDay(rows = [], { days = 30, now = Date.now(), value = () => 1, at = (r) => r.created_at } = {}) {
  const span = Math.max(1, Number(days) || 30)
  const buckets = new Map()
  for (let i = span - 1; i >= 0; i--) {
    buckets.set(dayKey(now - i * DAY_MS), { date: null, value: 0, count: 0 })
  }
  // Ordered oldest → newest so the series reads left to right.
  const keys = [...buckets.keys()]
  for (const key of keys) buckets.get(key).date = key

  for (const row of rows) {
    const key = dayKey(at(row))
    if (!key || !buckets.has(key)) continue
    const bucket = buckets.get(key)
    bucket.value += Number(value(row)) || 0
    bucket.count += 1
  }
  return keys.map((k) => buckets.get(k))
}

/** Percentage change, or null when there is no comparable base. */
export function deltaPercent(current, previous) {
  const now = Number(current) || 0
  const before = Number(previous) || 0
  if (before === 0) return now === 0 ? 0 : null
  return ((now - before) / before) * 100
}

/** Paid / (paid + failed + expired). Pending is excluded — it is not an outcome yet. */
export function conversionRate(counts = {}) {
  const paid = Number(counts.paid) || 0
  const settled = paid + (Number(counts.failed) || 0) + (Number(counts.expired) || 0)
  if (!settled) return null
  return paid / settled
}

/** Sum a series over its last N buckets. */
export function tailSum(series = [], days = 7) {
  const n = Math.max(1, Number(days) || 7)
  return series.slice(-n).reduce((sum, point) => sum + (Number(point.value) || 0), 0)
}

function scalar(db, sql, params = [], fallback = 0) {
  try {
    const row = db.prepare(sql).get(...params)
    const value = row ? Object.values(row)[0] : null
    return value == null ? fallback : Number(value)
  } catch {
    return fallback
  }
}

export class OpsDashboard {
  constructor(db = getDb()) {
    this.db = db
    this.orders = new OrderService(db)
    this.subscriptions = new SubscriptionService(db)
    this.ledger = new BalanceLedger(db)
    this.monitor = new ChannelMonitor(db)
    this.channels = new ChannelsRepo(db)
    this.bindings = new EgressBindingsRepo(db)
  }

  /**
   * @param {object} input
   * @param {Array} input.vms  slot summaries; the fleet section is computed from
   *                           these rather than from the DB so it matches what
   *                           the scheduler actually sees
   */
  snapshot({ vms = [], days = 30, now = Date.now() } = {}) {
    const since = (d) => new Date(now - d * DAY_MS).toISOString()

    // ── 收入：已支付订单 ─────────────────────────────────────────────────────
    let paidOrders = []
    try {
      paidOrders = this.db
        .prepare("SELECT order_no, amount, credit, paid_at, created_at FROM payment_orders WHERE status = 'paid' AND created_at >= ?")
        .all(since(days))
    } catch {
      paidOrders = []
    }
    const revenueSeries = bucketByDay(paidOrders, { days, now, value: (r) => r.amount, at: (r) => r.paid_at || r.created_at })
    const d7 = tailSum(revenueSeries, 7)
    const prev7 = tailSum(revenueSeries.slice(0, -7), 7)
    const d30 = tailSum(revenueSeries, 30)

    const orderCounts = this.orders.totals(now)
    const allTimeRevenue = scalar(this.db, "SELECT SUM(amount) FROM payment_orders WHERE status = 'paid'", [], 0)

    // ── 余额：负债与流向 ─────────────────────────────────────────────────────
    const totalLiability = scalar(this.db, 'SELECT SUM(balance) FROM users WHERE deleted_at IS NULL', [], 0)
    const ledgerTotals = this.ledger.totalsBySource()

    // ── 用户 ─────────────────────────────────────────────────────────────────
    const usersTotal = scalar(this.db, 'SELECT COUNT(*) FROM users WHERE deleted_at IS NULL', [], 0)
    const usersActive = scalar(this.db, "SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND status = 'active'", [], 0)
    const usersNew7 = scalar(this.db, 'SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND created_at >= ?', [since(7)], 0)
    const subsActive = scalar(this.db, "SELECT COUNT(*) FROM subscriptions WHERE status = 'active'", [], 0)
    const bucketsByUser = this.bindings.countBucketsByUser()
    const multiBucket = Object.values(bucketsByUser).filter((n) => n > 1).length

    // ── 用量：请求与 token ──────────────────────────────────────────────────
    let usageRows = []
    try {
      usageRows = this.db
        .prepare('SELECT created_at, total_cost, actual_cost, input_tokens, output_tokens FROM usage_logs WHERE created_at >= ?')
        .all(since(days))
    } catch {
      usageRows = []
    }
    const usageSeries = bucketByDay(usageRows, { days, now, value: () => 1, at: (r) => r.created_at })
    const costSeries = bucketByDay(usageRows, { days, now, value: (r) => r.actual_cost ?? r.total_cost, at: (r) => r.created_at })
    const tokens = usageRows.reduce(
      (acc, row) => {
        acc.input += Number(row.input_tokens) || 0
        acc.output += Number(row.output_tokens) || 0
        return acc
      },
      { input: 0, output: 0 },
    )

    // ── 渠道健康与告警 ──────────────────────────────────────────────────────
    const channelList = this.channels.list()
    const health = this.monitor.healthByChannel({ windowMinutes: 60, now })
    let degraded = 0
    for (const channel of channelList) {
      const h = health.get(channel.id)
      if (h && h.availability != null && h.availability < 0.9) degraded += 1
    }
    const alerts24h = this.monitor.listEvents(500).filter((e) => Date.parse(e.fired_at) >= now - DAY_MS)

    // ── 槽位与出口 ──────────────────────────────────────────────────────────
    const slots = vms.length
    const schedulable = vms.filter((v) => v.schedulable !== false).length
    const shared = this.bindings.listAllBuckets().length
    const migrations7d = scalar(
      this.db,
      'SELECT COUNT(*) FROM egress_migrations WHERE created_at >= ?',
      [since(7)],
      0,
    )
    const failovers7d = scalar(
      this.db,
      "SELECT COUNT(*) FROM egress_migrations WHERE created_at >= ? AND reason IN ('egress_failover','direct_fallback')",
      [since(7)],
      0,
    )
    let sessionsPinned = 0
    try {
      sessionsPinned = scalar(this.db, 'SELECT COUNT(*) FROM sticky_sessions', [], 0)
    } catch {
      sessionsPinned = 0
    }

    return {
      generated_at: new Date(now).toISOString(),
      window_days: days,
      revenue: {
        today: tailSum(revenueSeries, 1),
        d7,
        d30,
        all_time: allTimeRevenue,
        delta_7d_pct: deltaPercent(d7, prev7),
        series: revenueSeries,
      },
      balance: {
        liability: totalLiability,
        credited_30d: Number(ledgerTotals.payment?.total || 0) + Number(ledgerTotals.redeem?.total || 0),
        consumed_30d: Math.abs(Number(ledgerTotals.usage?.total || 0)),
        adjusted_30d: Number(ledgerTotals.admin?.total || 0),
      },
      users: { total: usersTotal, active: usersActive, new_7d: usersNew7, with_subscription: subsActive, multi_bucket: multiBucket },
      orders: {
        pending: Number(orderCounts.pending?.count || 0),
        paid_30d: Number(orderCounts.paid?.count || 0),
        failed_30d: Number(orderCounts.failed?.count || 0),
        expired_30d: Number(orderCounts.expired?.count || 0),
        conversion: conversionRate({
          paid: orderCounts.paid?.count,
          failed: orderCounts.failed?.count,
          expired: orderCounts.expired?.count,
        }),
      },
      usage: {
        requests: usageRows.length,
        requests_series: usageSeries,
        cost_series: costSeries,
        cost_30d: tailSum(costSeries, 30),
        tokens,
      },
      fleet: { slots, schedulable, buckets: shared, sessions_pinned: sessionsPinned },
      health: {
        channels: channelList.length,
        probed: [...health.values()].filter((h) => h.samples > 0).length,
        degraded,
        alerts_24h: alerts24h.length,
        migrations_7d: migrations7d,
        failovers_7d: failovers7d,
      },
    }
  }
}
