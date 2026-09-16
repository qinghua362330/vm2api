import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { BalanceLedger } from '../../src/lib/billing/balance-ledger.mjs'
import { RedeemService, generateCode } from '../../src/lib/billing/redeem-service.mjs'

/**
 * 余额只能经过 balance_ledger 移动，兑换码只能被同一个人用一次。
 * Money without a trail is not debuggable; a code that can be redeemed twice is
 * a defect, not a race.
 */

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-billing-'))
  const db = createDatabase({ dataDir: dir })
  const users = new UsersRepo(db)
  const user = users.insert({
    id: 'u1',
    username: 'u1',
    email: 'u1@test.local',
    password_hash: 'scrypt$fake',
    role: 'user',
  })
  return { dir, db, users, user, ledger: new BalanceLedger(db), redeem: new RedeemService(db) }
}

test('generating a code keeps an unambiguous alphabet', () => {
  const code = generateCode()
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{6}(-[0-9A-HJKMNP-TV-Z]{6}){3}$/)
  // I, L, O and U are deliberately absent: a code gets read aloud and retyped
  assert.doesNotMatch(code, /[ILOU]/)
  assert.notEqual(generateCode(), code, 'codes must not repeat')
})

test('a credit moves the balance and records why', () => {
  const { ledger, users, user } = tmp()
  const res = ledger.credit({ userId: user.id, amount: 25, source: 'admin', notes: '手工充值' })
  assert.equal(res.ok, true)
  assert.equal(res.balance, 25)
  assert.equal(users.getById(user.id).balance, 25)

  const history = ledger.history({ userId: user.id })
  assert.equal(history.length, 1)
  assert.equal(history[0].delta, 25)
  assert.equal(history[0].balance_after, 25)
  assert.equal(history[0].source, 'admin')
  assert.ok(history[0].created_at, 'a ledger row without a timestamp is not an audit trail')
})

test('a debit cannot overdraw unless the caller says so', () => {
  const { ledger, users, user } = tmp()
  ledger.credit({ userId: user.id, amount: 10, source: 'admin' })

  const denied = ledger.debit({ userId: user.id, amount: 30, source: 'usage' })
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'insufficient_balance')
  assert.equal(users.getById(user.id).balance, 10, 'a refused debit must not move money')

  const allowed = ledger.debit({ userId: user.id, amount: 30, source: 'usage', allowNegative: true })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.balance, -20)
})

test('an unknown source is rejected so the ledger stays queryable', () => {
  const { ledger, user } = tmp()
  const res = ledger.credit({ userId: user.id, amount: 1, source: 'whatever' })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'invalid_source')
})

test('a zero or non-numeric delta writes nothing', () => {
  const { ledger, user } = tmp()
  assert.equal(ledger.apply({ userId: user.id, delta: 0, source: 'admin' }).ok, false)
  assert.equal(ledger.apply({ userId: user.id, delta: 'abc', source: 'admin' }).ok, false)
  assert.equal(ledger.history({ userId: user.id }).length, 0)
})

test('totals roll up per source', () => {
  const { ledger, user } = tmp()
  ledger.credit({ userId: user.id, amount: 10, source: 'admin' })
  ledger.credit({ userId: user.id, amount: 5, source: 'redeem' })
  ledger.debit({ userId: user.id, amount: 3, source: 'usage' })
  const totals = ledger.totalsBySource()
  assert.equal(totals.admin.total, 10)
  assert.equal(totals.redeem.total, 5)
  assert.equal(totals.usage.total, -3)
})

// ── redeem codes ────────────────────────────────────────────────────────────

test('a batch creates the requested number of distinct codes', () => {
  const { redeem } = tmp()
  const batch = redeem.createBatch({ count: 5, value: 20, batch: 'launch' })
  assert.equal(batch.length, 5)
  assert.equal(new Set(batch.map((c) => c.code)).size, 5)
  assert.equal(batch[0].batch, 'launch')
  assert.equal(batch[0].max_uses, 1)
  const overview = redeem.overview()
  assert.equal(overview.length, 5)
  assert.equal(overview[0].max_uses, 1)
})

test('a supplied code is honoured and a collision is refused', () => {
  const { redeem } = tmp()
  const [code] = redeem.createBatch({ count: 1, value: 5, code: 'GIFT-0001' })
  assert.equal(code.code, 'GIFT-0001')
  assert.throws(() => redeem.createBatch({ count: 1, value: 5, code: 'GIFT-0001' }), /already exists/)
})

test('redeeming credits the balance through the ledger', () => {
  const { redeem, ledger, users, user } = tmp()
  const [code] = redeem.createBatch({ count: 1, value: 30 })

  const res = redeem.redeem({ code: code.code, userId: user.id })
  assert.equal(res.ok, true)
  assert.equal(res.type, 'balance')
  assert.equal(res.applied.balance, 30)
  assert.equal(users.getById(user.id).balance, 30)

  const history = ledger.history({ userId: user.id })
  assert.equal(history.length, 1)
  assert.equal(history[0].source, 'redeem')
  assert.equal(history[0].ref, code.code, 'the ledger must point at the code')
})

test('the same user cannot redeem the same code twice', () => {
  const { redeem, users, user } = tmp()
  const [code] = redeem.createBatch({ count: 1, value: 30, maxUses: 10 })
  assert.equal(redeem.redeem({ code: code.code, userId: user.id }).ok, true)
  const again = redeem.redeem({ code: code.code, userId: user.id })
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'already_redeemed')
  assert.equal(users.getById(user.id).balance, 30, 'a refused redeem must not pay out')
})

test('a multi-use code is exhausted exactly at its limit', () => {
  const { redeem, users } = tmp()
  const second = users.insert({
    id: 'u2',
    username: 'u2',
    email: 'u2@test.local',
    password_hash: 'scrypt$fake',
    role: 'user',
  })
  const third = users.insert({
    id: 'u3',
    username: 'u3',
    email: 'u3@test.local',
    password_hash: 'scrypt$fake',
    role: 'user',
  })
  const [code] = redeem.createBatch({ count: 1, value: 10, maxUses: 2 })

  assert.equal(redeem.redeem({ code: code.code, userId: 'u1' }).ok, true)
  assert.equal(redeem.redeem({ code: code.code, userId: second.id }).ok, true)
  const spent = redeem.redeem({ code: code.code, userId: third.id })
  assert.equal(spent.ok, false)
  assert.equal(spent.reason, 'code_exhausted')

  const [row] = redeem.overview()
  assert.equal(row.used_count, 2)
  assert.equal(row.status, 'used')
  assert.equal(row.redemptions, 2)
})

test('an expired code is refused', () => {
  const { redeem, user } = tmp()
  const [code] = redeem.createBatch({ count: 1, value: 5, expiresAt: '2020-01-01T00:00:00.000Z' })
  const res = redeem.redeem({ code: code.code, userId: user.id })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'code_expired')
})

test('an unknown code reports not-found rather than failing silently', () => {
  const { redeem, user } = tmp()
  const res = redeem.redeem({ code: 'NOPE-0000', userId: user.id })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'code_not_found')
})

test('redeeming is case-insensitive and records the redemption', () => {
  const { redeem, user } = tmp()
  const [code] = redeem.createBatch({ count: 1, value: 7, code: 'LOWER-0001' })
  const res = redeem.redeem({ code: code.code.toLowerCase(), userId: user.id })
  assert.equal(res.ok, true)
  const rows = redeem.redemptions({ userId: user.id })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].value, 7)
})

test('a subscription-days code records the intent without touching balance', () => {
  const { redeem, users, user } = tmp()
  const [code] = redeem.createBatch({ count: 1, value: 30, type: 'subscription_days' })
  const res = redeem.redeem({ code: code.code, userId: user.id })
  assert.equal(res.ok, true)
  assert.equal(res.type, 'subscription_days')
  assert.equal(res.applied.value, 30)
  assert.equal(users.getById(user.id).balance, 0, 'days are not money')
})

test('an unsupported type is refused at creation', () => {
  const { redeem } = tmp()
  assert.throws(() => redeem.createBatch({ count: 1, value: 1, type: 'nonsense' }), /unsupported redeem type/)
})

test('deleting a code removes it from the overview', () => {
  const { redeem } = tmp()
  const [code] = redeem.createBatch({ count: 1, value: 1 })
  redeem.remove(code.id)
  assert.equal(redeem.overview().length, 0)
})
