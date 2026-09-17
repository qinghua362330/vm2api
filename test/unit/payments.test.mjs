import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { BalanceLedger } from '../../src/lib/billing/balance-ledger.mjs'
import {
  EASYPAY_ACK,
  easypaySign,
  easypayTradeSuccess,
  parseStripeSignature,
  safeEqual,
  verifyEasypay,
  verifyStripeSignature,
} from '../../src/lib/payment/sign.mjs'
import { OrderService, newOrderNo } from '../../src/lib/payment/orders.mjs'
import {
  buildEasypayRedirect,
  mergePaymentConfig,
  publicPaymentConfig,
  usableChannels,
} from '../../src/lib/payment/config.mjs'

/**
 * 支付：回调会重试，网关会重复投递 —— 入账必须恰好一次；金额必须与订单一致。
 * These two are the ways a payment system loses money, so they carry the tests.
 */

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-pay-'))
  const db = createDatabase({ dataDir: dir })
  const users = new UsersRepo(db)
  users.insert({ id: 'u1', username: 'u1', email: 'u1@test.local', password_hash: 'scrypt$fake', role: 'user' })
  return { dir, db, users, orders: new OrderService(db), ledger: new BalanceLedger(db) }
}

// ── signatures ──────────────────────────────────────────────────────────────

test('safeEqual is constant-time shaped and length-safe', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'abcd'), false)
  assert.equal(safeEqual(undefined, ''), true, 'both empty')
})

test('easypay signs sorted non-empty params with the key appended', () => {
  const key = 'secret-key'
  const params = { pid: '1001', out_trade_no: 'P1', money: '10.00', name: 'x', sign_type: 'MD5' }
  // Reference value computed independently: sorted pairs, empties and sign/sign_type dropped
  const expected = crypto
    .createHash('md5')
    .update('money=10.00&name=x&out_trade_no=P1&pid=1001' + key, 'utf8')
    .digest('hex')
  assert.equal(easypaySign(params, key), expected)
})

test('easypay ignores empty params and the sign fields themselves', () => {
  const key = 'k'
  const a = easypaySign({ pid: '1', money: '5', note: '', sign: 'zzz', sign_type: 'MD5' }, key)
  const b = easypaySign({ pid: '1', money: '5' }, key)
  assert.equal(a, b)
})

test('easypay verification accepts a good sign and rejects the rest', () => {
  const key = 'k'
  const params = { pid: '1', out_trade_no: 'P1', money: '10.00', trade_status: 'TRADE_SUCCESS' }
  const signed = { ...params, sign: easypaySign(params, key) }

  assert.equal(verifyEasypay(signed, key).ok, true)
  assert.equal(verifyEasypay({ ...signed, money: '0.01' }, key).ok, false, 'tampering with the amount must fail')
  assert.equal(verifyEasypay({ ...signed, sign: '' }, key).ok, false)
  assert.equal(verifyEasypay(signed, 'wrong-key').ok, false)
})

test('easypay only treats TRADE_SUCCESS as paid', () => {
  assert.equal(easypayTradeSuccess({ trade_status: 'TRADE_SUCCESS' }), true)
  assert.equal(easypayTradeSuccess({ trade_status: 'trade_success' }), true)
  assert.equal(easypayTradeSuccess({ trade_status: 'WAIT_BUYER_PAY' }), false)
  assert.equal(easypayTradeSuccess({}), false)
  assert.equal(EASYPAY_ACK, 'success', 'anything else gets the callback re-delivered forever')
})

// ── stripe ──────────────────────────────────────────────────────────────────

test('parseStripeSignature keeps every v1 during a rotation', () => {
  const parsed = parseStripeSignature('t=1700000000,v1=aaa,v1=bbb,v0=ccc')
  assert.equal(parsed.t, 1700000000)
  assert.deepEqual(parsed.v1, ['aaa', 'bbb'])
  assert.deepEqual(parsed.v0, ['ccc'])
})

test('stripe webhook verifies over the raw payload', () => {
  const secret = 'whsec_test'
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' })
  const t = 1_700_000_000
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')

  const good = verifyStripeSignature(payload, `t=${t},v1=${sig}`, secret, { now: t * 1000 })
  assert.equal(good.ok, true)

  const reordered = JSON.stringify({ type: 'checkout.session.completed', id: 'evt_1' })
  assert.equal(
    verifyStripeSignature(reordered, `t=${t},v1=${sig}`, secret, { now: t * 1000 }).reason,
    'bad_sign',
    're-serialising JSON changes the bytes, so the raw body is the only valid input',
  )
})

test('stripe rejects a stale timestamp as a replay', () => {
  const secret = 'whsec_test'
  const payload = '{}'
  const t = 1_700_000_000
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')
  const stale = verifyStripeSignature(payload, `t=${t},v1=${sig}`, secret, { now: (t + 3600) * 1000 })
  assert.equal(stale.ok, false)
  assert.equal(stale.reason, 'timestamp_out_of_tolerance')
})

test('stripe rejects a missing or malformed header', () => {
  assert.equal(verifyStripeSignature('{}', '', 's').reason, 'missing_signature')
  assert.equal(verifyStripeSignature('{}', 'v1=abc', 's').reason, 'missing_timestamp')
  assert.equal(verifyStripeSignature('{}', 't=abc,v1=xyz', 's').reason, 'bad_timestamp')
  assert.equal(verifyStripeSignature('{}', 't=1700000000', 's').reason, 'missing_signature')
})

// ── orders ──────────────────────────────────────────────────────────────────

test('order numbers are time-ordered and unique', () => {
  const a = newOrderNo({ now: 1_700_000_000_000 })
  const b = newOrderNo({ now: 1_700_000_000_000 })
  assert.match(a, /^P\d{14}[0-9A-F]{8}$/)
  assert.notEqual(a, b)
})

test('creating an order validates its inputs', () => {
  const { orders } = tmp()
  assert.equal(orders.create({ userId: '', amount: 10 }).reason, 'user_required')
  assert.equal(orders.create({ userId: 'u1', amount: 0 }).reason, 'amount_required')
  assert.equal(orders.create({ userId: 'u1', amount: -5 }).reason, 'amount_required')
  assert.equal(orders.create({ userId: 'u1', amount: 10, channel: 'paypal' }).reason, 'invalid_channel')
})

test('a package can credit more than it charges', () => {
  const { orders } = tmp()
  const res = orders.create({ userId: 'u1', amount: 50, credit: 55, packageId: 'p50' })
  assert.equal(res.ok, true)
  assert.equal(res.order.amount, 50)
  assert.equal(res.order.credit, 55)
  assert.equal(res.order.status, 'pending')
  assert.ok(res.order.expires_at)
})

test('a valid callback credits once', () => {
  const { orders, users, ledger } = tmp()
  const { order } = orders.create({ userId: 'u1', amount: 50, credit: 55 })

  const settled = orders.markPaid({ orderNo: order.order_no, providerTradeNo: 'TP1', paidAmount: 50 })
  assert.equal(settled.ok, true)
  assert.equal(settled.credited, 55)
  assert.equal(settled.balance, 55)
  assert.equal(users.getById('u1').balance, 55)

  const entry = ledger.history({ userId: 'u1' })[0]
  assert.equal(entry.source, 'payment')
  assert.equal(entry.ref, order.order_no, 'the ledger must point at the order')
})

test('a repeated callback does not credit twice', () => {
  const { orders, users, ledger } = tmp()
  const { order } = orders.create({ userId: 'u1', amount: 50, credit: 55 })
  orders.markPaid({ orderNo: order.order_no, paidAmount: 50 })

  const retry = orders.markPaid({ orderNo: order.order_no, paidAmount: 50 })
  assert.equal(retry.ok, true)
  assert.equal(retry.alreadyPaid, true)
  assert.equal(users.getById('u1').balance, 55, 'this is the bug that costs money')
  assert.equal(ledger.history({ userId: 'u1' }).length, 1)
})

test('an amount mismatch is refused, not settled at the wrong value', () => {
  const { orders, users } = tmp()
  const { order } = orders.create({ userId: 'u1', amount: 100, credit: 100 })

  const wrong = orders.markPaid({ orderNo: order.order_no, paidAmount: 1 })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.reason, 'amount_mismatch')
  assert.equal(wrong.expected, 100)
  assert.equal(wrong.received, 1)
  assert.equal(users.getById('u1').balance, 0, 'a ¥1 payment must not settle a ¥100 order')
  assert.equal(orders.get(order.order_no).status, 'failed')
})

test('float noise does not trip the amount check', () => {
  const { orders } = tmp()
  const { order } = orders.create({ userId: 'u1', amount: 0.1 + 0.2, credit: 0.3 })
  const res = orders.markPaid({ orderNo: order.order_no, paidAmount: 0.3 })
  assert.equal(res.ok, true)
})

test('an expired order cannot be settled', () => {
  const { orders, users } = tmp()
  const created = orders.create({ userId: 'u1', amount: 10, ttlMs: 1000, now: 1_700_000_000_000 })
  const late = orders.markPaid({
    orderNo: created.order.order_no,
    paidAmount: 10,
    now: 1_700_000_000_000 + 60_000,
  })
  assert.equal(late.ok, false)
  assert.equal(late.reason, 'order_expired')
  assert.equal(users.getById('u1').balance, 0)
})

test('a failed or expired order is not payable', () => {
  const { orders } = tmp()
  const { order } = orders.create({ userId: 'u1', amount: 10 })
  orders.fail(order.order_no, 'gateway said no')
  const retry = orders.markPaid({ orderNo: order.order_no, paidAmount: 10 })
  assert.equal(retry.ok, false)
  assert.equal(retry.reason, 'order_failed')
})

test('an unknown order is reported, not silently created', () => {
  const { orders } = tmp()
  assert.equal(orders.markPaid({ orderNo: 'P000' }).reason, 'order_not_found')
  assert.equal(orders.markPaid({ orderNo: '' }).reason, 'order_required')
})

test('expireDue closes stale pending orders', () => {
  const { orders } = tmp()
  orders.create({ userId: 'u1', amount: 10, ttlMs: 1000, now: 1_700_000_000_000 })
  const swept = orders.expireDue(1_700_000_000_000 + 60_000)
  assert.equal(swept.expired, 1)
  assert.equal(orders.list({ now: 1_700_000_000_000 + 60_000 })[0].status, 'expired')
})

test('totals roll up by status', () => {
  const { orders } = tmp()
  const a = orders.create({ userId: 'u1', amount: 10 })
  orders.create({ userId: 'u1', amount: 20 })
  orders.markPaid({ orderNo: a.order.order_no, paidAmount: 10 })

  const totals = orders.totals()
  assert.equal(totals.paid.count, 1)
  assert.equal(totals.paid.amount, 10)
  assert.equal(totals.pending.count, 1)
  assert.equal(totals.pending.amount, 20)
})

// ── config ──────────────────────────────────────────────────────────────────

test('an empty secret on save leaves the stored secret alone', () => {
  const saved = mergePaymentConfig(
    { channels: { easypay: { key: 'real-key', pid: '1001' } } },
    { channels: { easypay: { key: '', pid: '1002' } } },
  )
  assert.equal(saved.channels.easypay.key, 'real-key', 'saving the form must not wipe the key')
  assert.equal(saved.channels.easypay.pid, '1002')
})

test('the public config marks secrets as set rather than returning them', () => {
  const pub = publicPaymentConfig({ channels: { easypay: { key: 'super-secret', pid: '1001' } } })
  assert.equal(pub.channels.easypay.key, '__SET__')
  assert.equal(pub.channels.easypay.pid, '1001')
  assert.equal(JSON.stringify(pub).includes('super-secret'), false)
})

test('only fully configured channels are usable', () => {
  assert.deepEqual(usableChannels({ enabled: true, channels: { easypay: { enabled: true, pid: '1', key: 'k' } } }), [
    'easypay',
  ])
  assert.deepEqual(usableChannels({ enabled: false, channels: { easypay: { enabled: true, pid: '1', key: 'k' } } }), [])
  assert.deepEqual(usableChannels({ enabled: true, channels: { easypay: { enabled: true, pid: '1' } } }), [])
})

test('the easypay redirect carries a sign over the same params', () => {
  const config = {
    channels: { easypay: { pid: '1001', key: 'k', submit_url: 'https://pay.test/submit.php' } },
  }
  const order = { order_no: 'P1', amount: 10 }
  const sign = easypaySign({ pid: '1001', out_trade_no: 'P1', money: '10.00', name: '充值 10' }, 'k')
  const url = buildEasypayRedirect({ order, config, notifyUrl: 'https://n.test', returnUrl: 'https://r.test', sign })
  assert.match(url, /^https:\/\/pay\.test\/submit\.php\?/)
  assert.match(url, /out_trade_no=P1/)
  assert.match(url, /money=10\.00/)
  assert.match(url, new RegExp(`sign=${sign}`))
})
