import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { OrderService } from '../../src/lib/payment/orders.mjs'
import { SubscriptionService } from '../../src/lib/billing/subscription-service.mjs'
import { BalanceLedger } from '../../src/lib/billing/balance-ledger.mjs'
import { ChannelsRepo } from '../../src/lib/db/repos/channels-repo.mjs'
import { EgressBindingsRepo } from '../../src/lib/db/repos/egress-bindings-repo.mjs'
import {
  DAY_MS,
  OpsDashboard,
  bucketByDay,
  conversionRate,
  dayKey,
  deltaPercent,
  tailSum,
} from '../../src/lib/admin/ops-dashboard.mjs'

/**
 * 运营大盘：日序列必须补零（稀疏的图会撒谎），环比在没有基期时是 null 而不是 +∞。
 */

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ops-'))
  const db = createDatabase({ dataDir: dir })
  return { dir, db, ops: new OpsDashboard(db) }
}

const T0 = Date.parse('2026-05-10T12:00:00.000Z')

// ── pure helpers ────────────────────────────────────────────────────────────

test('dayKey normalises both ISO strings and epoch numbers', () => {
  assert.equal(dayKey('2026-05-10T12:00:00.000Z'), '2026-05-10')
  assert.equal(dayKey(T0), '2026-05-10')
  assert.equal(dayKey('nonsense'), null)
  assert.equal(dayKey(null), null)
})

test('a daily series is dense — missing days are zeros, not gaps', () => {
  const rows = [
    { amount: 10, created_at: new Date(T0).toISOString() },
    { amount: 5, created_at: new Date(T0 - 2 * DAY_MS).toISOString() },
  ]
  const series = bucketByDay(rows, { days: 5, now: T0, value: (r) => r.amount })
  assert.equal(series.length, 5, 'five buckets for five days')
  assert.deepEqual(
    series.map((p) => p.value),
    [0, 0, 5, 0, 10],
    'the empty middle day appears as 0 — a sparse chart would draw straight through it',
  )
  assert.equal(series[4].count, 1)
  assert.equal(series[4].date, '2026-05-10')
})

test('rows outside the window are ignored, not clamped in', () => {
  const series = bucketByDay([{ amount: 99, created_at: new Date(T0 - 30 * DAY_MS).toISOString() }], {
    days: 3,
    now: T0,
    value: (r) => r.amount,
  })
  assert.deepEqual(
    series.map((p) => p.value),
    [0, 0, 0],
  )
})

test('a series is ordered oldest to newest', () => {
  const series = bucketByDay([], { days: 3, now: T0 })
  assert.deepEqual(
    series.map((p) => p.date),
    ['2026-05-08', '2026-05-09', '2026-05-10'],
  )
})

test('the default value counts rows rather than summing them', () => {
  const series = bucketByDay([{ created_at: new Date(T0).toISOString() }, { created_at: new Date(T0).toISOString() }], {
    days: 1,
    now: T0,
  })
  assert.equal(series[0].value, 2)
})

test('deltaPercent is null without a base, not infinite', () => {
  assert.equal(deltaPercent(150, 100), 50)
  assert.equal(deltaPercent(50, 100), -50)
  assert.equal(deltaPercent(0, 0), 0)
  assert.equal(deltaPercent(5, 0), null, 'growth from nothing has no percentage')
})

test('conversionRate excludes pending, which is not an outcome yet', () => {
  assert.equal(conversionRate({ paid: 8, failed: 2 }), 0.8)
  assert.equal(conversionRate({ paid: 0, failed: 0, expired: 0 }), null)
  assert.equal(conversionRate({}), null)
})

test('tailSum takes the newest buckets', () => {
  const series = [{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }]
  assert.equal(tailSum(series, 2), 7)
  assert.equal(tailSum(series, 99), 10)
})

// ── snapshot ────────────────────────────────────────────────────────────────

test('an empty install reports zeros rather than nulls', () => {
  const { ops } = tmp()
  const snap = ops.snapshot({ vms: [], days: 7, now: T0 })
  assert.equal(snap.revenue.d30, 0)
  assert.equal(snap.revenue.delta_7d_pct, 0)
  assert.equal(snap.users.total, 0)
  assert.equal(snap.usage.requests, 0)
  assert.equal(snap.health.channels, 0)
  assert.equal(snap.orders.conversion, null, 'no settled orders means no conversion, not 0%')
})

test('paid orders land in the revenue series and the totals', () => {
  const { db, ops } = tmp()
  const users = new UsersRepo(db)
  users.insert({ id: 'u1', username: 'u1', email: 'u1@t.local', password_hash: 'x', role: 'user' })
  const orders = new OrderService(db)

  const a = orders.create({ userId: 'u1', amount: 100, now: T0 - 2 * DAY_MS })
  const b = orders.create({ userId: 'u1', amount: 50, now: T0 - 1 * DAY_MS })
  orders.create({ userId: 'u1', amount: 999, now: T0 }) // left pending on purpose
  orders.markPaid({ orderNo: a.order.order_no, paidAmount: 100, now: T0 - 2 * DAY_MS })
  orders.markPaid({ orderNo: b.order.order_no, paidAmount: 50, now: T0 - 1 * DAY_MS })

  const snap = ops.snapshot({ vms: [], days: 5, now: T0 })
  assert.deepEqual(
    snap.revenue.series.map((p) => p.value),
    [0, 0, 100, 50, 0],
  )
  assert.equal(snap.revenue.d7, 150)
  assert.equal(snap.revenue.all_time, 150, 'a pending order is not revenue')
  assert.equal(snap.orders.pending, 1)
  assert.equal(snap.orders.paid_30d, 2)
})

test('the balance liability sums what is still owed to users', () => {
  const { db, ops } = tmp()
  const users = new UsersRepo(db)
  users.insert({ id: 'u1', username: 'u1', email: 'u1@t.local', password_hash: 'x', role: 'user' })
  users.insert({ id: 'u2', username: 'u2', email: 'u2@t.local', password_hash: 'x', role: 'user' })
  const ledger = new BalanceLedger(db)
  ledger.credit({ userId: 'u1', amount: 30, source: 'admin' })
  ledger.credit({ userId: 'u2', amount: 20, source: 'redeem' })
  ledger.debit({ userId: 'u1', amount: 5, source: 'usage' })

  const snap = ops.snapshot({ vms: [], days: 30, now: T0 })
  assert.equal(snap.balance.liability, 45)
  assert.equal(snap.balance.consumed_30d, 5)
})

test('users and subscriptions are counted', () => {
  const { db, ops } = tmp()
  const users = new UsersRepo(db)
  users.insert({ id: 'u1', username: 'u1', email: 'u1@t.local', password_hash: 'x', role: 'user' })
  users.insert({ id: 'u2', username: 'u2', email: 'u2@t.local', password_hash: 'x', role: 'user' })
  new SubscriptionService(db).grant({ userId: 'u1', days: 30, dailyQuota: 10, now: T0 })

  const snap = ops.snapshot({ vms: [], days: 30, now: T0 })
  assert.equal(snap.users.total, 2)
  assert.equal(snap.users.with_subscription, 1)
})

test('a user holding several buckets is counted as multi-bucket', () => {
  const { db, ops } = tmp()
  const bindings = new EgressBindingsRepo(db)
  bindings.upsertEgressBinding({ userId: 'u1', egressId: 'px-a' })
  bindings.addBucket({ userId: 'u1', egressId: 'px-b' })
  bindings.upsertEgressBinding({ userId: 'u2', egressId: 'px-c' })

  const snap = ops.snapshot({ vms: [], days: 30, now: T0 })
  assert.equal(snap.users.multi_bucket, 1)
})

test('the fleet section reflects the vms the scheduler sees', () => {
  const { ops } = tmp()
  const snap = ops.snapshot({
    vms: [
      { id: 'vm-1', schedulable: true },
      { id: 'vm-2', schedulable: false },
    ],
    days: 7,
    now: T0,
  })
  assert.equal(snap.fleet.slots, 2)
  assert.equal(snap.fleet.schedulable, 1)
})

test('a degraded channel is counted only when it has samples', () => {
  const { db, ops } = tmp()
  const channels = new ChannelsRepo(db)
  const channel = channels.create({ name: 'A' })
  const monitor = ops.monitor
  // Only failures → availability 0 → degraded.
  monitor.recordProbe({ channelId: channel.id, egressId: 'px-a', ok: false, error: 'down', now: T0 })
  assert.equal(ops.snapshot({ vms: [], days: 7, now: T0 }).health.degraded, 1)

  // A second channel with no probes must not count as degraded.
  channels.create({ name: 'B' })
  assert.equal(ops.snapshot({ vms: [], days: 7, now: T0 }).health.degraded, 1)
  assert.equal(ops.snapshot({ vms: [], days: 7, now: T0 }).health.probed, 1)
})

test('recent migrations and failovers are separated', () => {
  const { db, ops } = tmp()
  const bindings = new EgressBindingsRepo(db)
  bindings.recordMigration({ userId: 'u1', egressId: 'px-a', reason: 'quota_exhausted' })
  bindings.recordMigration({ userId: 'u1', egressId: 'px-b', reason: 'egress_failover' })

  const snap = ops.snapshot({ vms: [], days: 7, now: Date.now() })
  assert.equal(snap.health.migrations_7d, 2)
  assert.equal(snap.health.failovers_7d, 1, 'a same-IP move is not a failover')
})

test('the snapshot carries its window and generation time', () => {
  const { ops } = tmp()
  const snap = ops.snapshot({ vms: [], days: 14, now: T0 })
  assert.equal(snap.window_days, 14)
  assert.equal(snap.generated_at, new Date(T0).toISOString())
})
