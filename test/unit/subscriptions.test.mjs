import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import {
  DAY_MS,
  SubscriptionService,
  windowState,
} from '../../src/lib/billing/subscription-service.mjs'

/**
 * 订阅：一个用户一个有效订阅，授予是延长而不是叠加；日窗口是滚动 24h。
 * Stacking would silently double a quota, and a midnight reset makes every user
 * hit at the same instant.
 */

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-subs-'))
  const db = createDatabase({ dataDir: dir })
  const users = new UsersRepo(db)
  for (const id of ['u1', 'u2']) {
    users.insert({ id, username: id, email: `${id}@test.local`, password_hash: 'scrypt$fake', role: 'user' })
  }
  return { dir, db, subs: new SubscriptionService(db) }
}

const T0 = Date.parse('2026-03-01T00:00:00.000Z')

test('granting creates an active subscription with an expiry', () => {
  const { subs } = tmp()
  const res = subs.grant({ userId: 'u1', days: 30, dailyQuota: 100, now: T0 })
  assert.equal(res.ok, true)
  assert.equal(res.extended, false)
  assert.equal(res.subscription.status, 'active')
  assert.equal(res.subscription.daily_quota, 100)
  assert.equal(Date.parse(res.subscription.expires_at), T0 + 30 * DAY_MS)
})

test('granting again extends rather than stacking', () => {
  const { subs } = tmp()
  const first = subs.grant({ userId: 'u1', days: 30, dailyQuota: 100, now: T0 })
  const second = subs.grant({ userId: 'u1', days: 10, now: T0 + 1000 })

  assert.equal(second.extended, true)
  assert.equal(second.subscription.id, first.subscription.id, 'one row, not two')
  assert.equal(subs.allOf('u1').length, 1, 'a second row would double the quota')
  assert.equal(Date.parse(second.subscription.expires_at), T0 + 40 * DAY_MS, 'days add up')
  assert.equal(second.subscription.daily_quota, 100, 'quota survives an extension that omits it')
})

test('renewing an expired subscription starts from now, not from the old expiry', () => {
  const { subs } = tmp()
  subs.grant({ userId: 'u1', days: 1, dailyQuota: 10, now: T0 })
  const later = T0 + 5 * DAY_MS
  assert.equal(subs.activeOf('u1', later), null, 'past expiry is not active')

  const again = subs.grant({ userId: 'u1', days: 7, now: later })
  assert.equal(Date.parse(again.subscription.expires_at), later + 7 * DAY_MS, 'starts from now')
})

test('an expired subscription is swept to expired status', () => {
  const { subs } = tmp()
  subs.grant({ userId: 'u1', days: 1, now: T0 })
  const sweep = subs.sweepExpired(T0 + 2 * DAY_MS)
  assert.equal(sweep.expired, 1)
  assert.equal(subs.get(subs.allOf('u1')[0].id).status, 'expired')
})

test('a user with no subscription has no allowance', () => {
  const { subs } = tmp()
  assert.deepEqual(subs.usage('u1', T0), { active: false, reason: 'no_subscription' })
  const res = subs.consume({ userId: 'u1', amount: 1, now: T0 })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'no_subscription')
})

test('consume charges the day window and reports what is left', () => {
  const { subs } = tmp()
  subs.grant({ userId: 'u1', days: 30, dailyQuota: 100, now: T0 })

  const first = subs.consume({ userId: 'u1', amount: 30, now: T0 + 1000 })
  assert.equal(first.ok, true)
  assert.equal(first.used, 30)
  assert.equal(first.remaining, 70)

  const second = subs.consume({ userId: 'u1', amount: 20, now: T0 + 2000 })
  assert.equal(second.used, 50)
  assert.equal(second.remaining, 50)
})

test('the window rolls after 24h and the allowance comes back', () => {
  const { subs } = tmp()
  subs.grant({ userId: 'u1', days: 30, dailyQuota: 100, now: T0 })
  subs.consume({ userId: 'u1', amount: 100, now: T0 + 1000 })

  const blocked = subs.consume({ userId: 'u1', amount: 1, now: T0 + 2000 })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'quota_exceeded')
  assert.equal(blocked.remaining, 0)
  assert.ok(blocked.resets_at, 'a refusal must say when it clears')

  const afterRoll = subs.consume({ userId: 'u1', amount: 1, now: T0 + 1000 + DAY_MS })
  assert.equal(afterRoll.ok, true)
  assert.equal(afterRoll.used, 1, 'the window reset')
})

test('a refused charge moves nothing', () => {
  const { subs } = tmp()
  subs.grant({ userId: 'u1', days: 30, dailyQuota: 10, now: T0 })
  subs.consume({ userId: 'u1', amount: 8, now: T0 + 1000 })

  const refused = subs.consume({ userId: 'u1', amount: 5, now: T0 + 2000 })
  assert.equal(refused.ok, false)
  assert.equal(subs.usage('u1', T0 + 2000).used, 8, 'a partial charge would be worse than a refusal')
})

test('daily_quota 0 means unlimited', () => {
  const { subs } = tmp()
  subs.grant({ userId: 'u1', days: 30, dailyQuota: 0, now: T0 })
  const res = subs.consume({ userId: 'u1', amount: 999999, now: T0 + 1000 })
  assert.equal(res.ok, true)
  assert.equal(res.unlimited, true)
  assert.equal(res.remaining, Infinity)
})

test('an expired subscription refuses consumption even inside its window', () => {
  const { subs } = tmp()
  subs.grant({ userId: 'u1', days: 1, dailyQuota: 100, now: T0 })
  subs.consume({ userId: 'u1', amount: 1, now: T0 + 1000 })

  const after = subs.consume({ userId: 'u1', amount: 1, now: T0 + 2 * DAY_MS })
  assert.equal(after.ok, false)
  assert.equal(after.reason, 'no_subscription', 'expiry is resolved by activeOf first')
})

test('revoking stops consumption immediately', () => {
  const { subs } = tmp()
  const granted = subs.grant({ userId: 'u1', days: 30, dailyQuota: 100, now: T0 })
  subs.revoke(granted.subscription.id, { now: T0 + 1000 })

  assert.equal(subs.activeOf('u1', T0 + 2000), null)
  const res = subs.consume({ userId: 'u1', amount: 1, now: T0 + 2000 })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'no_subscription')
})

test('usage reports the window without charging', () => {
  const { subs } = tmp()
  subs.grant({ userId: 'u1', days: 30, dailyQuota: 50, now: T0 })
  subs.consume({ userId: 'u1', amount: 20, now: T0 + 1000 })

  const used = subs.usage('u1', T0 + 2000)
  assert.equal(used.active, true)
  assert.equal(used.used, 20)
  assert.equal(used.remaining, 30)
  assert.equal(used.unlimited, false)

  const again = subs.usage('u1', T0 + 3000)
  assert.equal(again.used, 20, 'reading usage must not advance anything')
})

test('a rolled window is persisted, not just reported', () => {
  const { db, subs } = tmp()
  subs.grant({ userId: 'u1', days: 30, dailyQuota: 10, now: T0 })
  subs.consume({ userId: 'u1', amount: 10, now: T0 + 1000 })

  subs.usage('u1', T0 + 1000 + DAY_MS)
  const row = db.prepare('SELECT daily_used, window_start FROM subscriptions WHERE user_id = ?').get('u1')
  assert.equal(Number(row.daily_used), 0, 'the roll is written so a restart cannot resurrect the old count')
  assert.equal(Date.parse(row.window_start), T0 + 1000 + DAY_MS)
})

test('two users keep separate windows', () => {
  const { subs } = tmp()
  subs.grant({ userId: 'u1', days: 30, dailyQuota: 10, now: T0 })
  subs.grant({ userId: 'u2', days: 30, dailyQuota: 10, now: T0 })
  subs.consume({ userId: 'u1', amount: 9, now: T0 + 1000 })
  assert.equal(subs.usage('u1', T0 + 2000).remaining, 1)
  assert.equal(subs.usage('u2', T0 + 2000).remaining, 10)
})

test('grant rejects a missing user or a non-positive span', () => {
  const { subs } = tmp()
  assert.equal(subs.grant({ userId: '', days: 30 }).ok, false)
  assert.equal(subs.grant({ userId: 'u1', days: 0 }).ok, false)
  assert.equal(subs.grant({ userId: 'u1', days: -5 }).ok, false)
  assert.equal(subs.consume({ userId: 'u1', amount: 0 }).ok, false)
})

test('overview attaches the live window and days left', () => {
  const { subs } = tmp()
  subs.grant({ userId: 'u1', plan: 'pro', days: 10, dailyQuota: 200, now: T0 })
  subs.consume({ userId: 'u1', amount: 50, now: T0 + 1000 })

  const [row] = subs.overview(T0 + 2000)
  assert.equal(row.plan, 'pro')
  assert.equal(row.window.used, 50)
  assert.equal(row.window.remaining, 150)
  assert.equal(row.days_left, 10)
})

test('windowState is pure', () => {
  const { subs } = tmp()
  subs.grant({ userId: 'u1', days: 30, dailyQuota: 10, now: T0 })
  const sub = subs.activeOf('u1', T0 + 1000)
  const before = JSON.stringify(sub)
  windowState(sub, T0 + 1000 + DAY_MS)
  assert.equal(JSON.stringify(sub), before, 'the row object must not be mutated')
})

test('update can change the quota and status, and refuses unknown statuses', () => {
  const { subs } = tmp()
  const granted = subs.grant({ userId: 'u1', days: 30, dailyQuota: 10, now: T0 })
  const raised = subs.update(granted.subscription.id, { daily_quota: 500 }, { now: T0 + 1000 })
  assert.equal(raised.daily_quota, 500)

  const bogus = subs.update(granted.subscription.id, { status: 'whatever' }, { now: T0 + 2000 })
  assert.equal(bogus.status, 'active', 'an unknown status must not be written')
})
