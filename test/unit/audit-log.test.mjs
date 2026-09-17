import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { AUDIT_ACTIONS, AuditLog, REDACTED, redactDeep } from '../../src/lib/admin/audit-log.mjs'

/**
 * 审计日志：调用方可以整包把 body 传进来 —— 脱敏是入口的安全网，不是约定。
 * And recording must never fail the operation it describes.
 */

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-audit-'))
  const db = createDatabase({ dataDir: dir })
  return { dir, db, log: new AuditLog(db) }
}

// ── redaction ───────────────────────────────────────────────────────────────

test('secret-looking keys are redacted by name', () => {
  const out = redactDeep({
    name: 'main',
    key: 'super-secret',
    secret_key: 'sk_live_123',
    webhook_secret: 'whsec_abc',
    password: 'hunter2',
    session_token: 'tok',
    access_token: 'at',
    sign: 'abc123',
  })
  assert.equal(out.name, 'main', 'non-secret fields survive')
  for (const field of ['key', 'secret_key', 'webhook_secret', 'password', 'session_token', 'access_token', 'sign']) {
    assert.equal(out[field], REDACTED, `${field} must be redacted`)
  }
})

test('redaction walks nested objects and arrays', () => {
  const out = redactDeep({
    channels: { easypay: { pid: '1001', key: 'k' }, stripe: { secret_key: 's' } },
    list: [{ password: 'p' }, { ok: 1 }],
  })
  assert.equal(out.channels.easypay.pid, '1001')
  assert.equal(out.channels.easypay.key, REDACTED)
  assert.equal(out.channels.stripe.secret_key, REDACTED)
  assert.equal(out.list[0].password, REDACTED)
  assert.equal(out.list[1].ok, 1)
})

test('redaction keeps non-secret lookalikes readable', () => {
  const out = redactDeep({ key_id: 'not-secret', monkey: 'banana', keyword: 'x', notes: 'hello' })
  // `key_id` and `keyword` are not the secret field; over-redacting makes an
  // audit useless, so the pattern is anchored rather than a loose contains.
  assert.equal(out.notes, 'hello')
  assert.equal(out.monkey, 'banana')
  assert.equal(out.keyword, 'x')
})

test('redaction is depth- and size-limited so a huge body cannot hang the write', () => {
  let deep = { v: 1 }
  for (let i = 0; i < 20; i++) deep = { nested: deep }
  const out = redactDeep(deep)
  assert.ok(JSON.stringify(out).includes('depth-limit'))

  const wide = {}
  for (let i = 0; i < 500; i++) wide[`k${i}`] = i
  const trimmed = redactDeep(wide)
  assert.equal(trimmed.__truncated__, true)
})

// ── recording ───────────────────────────────────────────────────────────────

test('recording stores who did what to which target', () => {
  const { log } = tmp()
  const res = log.record({
    actor: 'admin',
    actorRole: 'admin',
    action: AUDIT_ACTIONS.balanceAdjust,
    targetType: 'user',
    targetId: 'u1',
    detail: { amount: -10 },
    ip: '203.0.113.9',
  })
  assert.equal(res.ok, true)

  const [entry] = log.list()
  assert.equal(entry.actor, 'admin')
  assert.equal(entry.actor_role, 'admin')
  assert.equal(entry.action, 'balance.adjust')
  assert.equal(entry.target_type, 'user')
  assert.equal(entry.target_id, 'u1')
  assert.deepEqual(entry.detail, { amount: -10 })
  assert.equal(entry.ip, '203.0.113.9')
  assert.ok(entry.created_at)
})

test('a caller passing the whole request body cannot leak a secret', () => {
  const { log } = tmp()
  log.record({
    actor: 'admin',
    action: AUDIT_ACTIONS.paymentConfig,
    targetType: 'payment',
    targetId: 'config',
    // exactly the shape the panel route passes
    detail: { enabled: true, channels: { easypay: { pid: '1001', key: 'merchant-key' } } },
  })
  const [entry] = log.list()
  assert.equal(entry.detail.channels.easypay.key, REDACTED)
  assert.equal(entry.detail.channels.easypay.pid, '1001')
  assert.equal(JSON.stringify(entry).includes('merchant-key'), false)
})

test('recording an empty action is refused', () => {
  const { log } = tmp()
  const res = log.record({ actor: 'admin' })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'action_required')
  assert.equal(log.list().length, 0)
})

test('a write failure is reported, not thrown', () => {
  const { db, log } = tmp()
  // Close the DB underneath the service: the audit must not take the request down.
  db.close()
  const res = log.record({ actor: 'admin', action: 'user.update' })
  assert.equal(res.ok, false, 'the caller learns it failed')
  assert.equal(res.reason, 'write_failed')
})

test('list filters by action, actor and target', () => {
  const { log } = tmp()
  log.record({ actor: 'a', action: 'user.create', targetType: 'user', targetId: 'u1' })
  log.record({ actor: 'b', action: 'user.update', targetType: 'user', targetId: 'u1' })
  log.record({ actor: 'a', action: 'channel.create', targetType: 'channel', targetId: '1' })

  assert.equal(log.list().length, 3)
  assert.equal(log.list({ action: 'user.create' }).length, 1)
  assert.equal(log.list({ actor: 'a' }).length, 2)
  assert.equal(log.list({ targetType: 'user', targetId: 'u1' }).length, 2)
  assert.equal(log.list({ targetType: 'channel', targetId: '1' }).length, 1)
})

test('stats roll up by action with the newest timestamp', () => {
  const { log } = tmp()
  log.record({ action: 'user.update', now: 1000 })
  log.record({ action: 'user.update', now: 2000 })
  log.record({ action: 'redeem.use', now: 3000 })

  const stats = log.stats()
  assert.equal(stats.total, 3)
  const update = stats.actions.find((a) => a.action === 'user.update')
  assert.equal(update.count, 2)
  assert.equal(Date.parse(update.last_at), 2000)
})

test('purging drops only what is older than the window', () => {
  const { log } = tmp()
  const old = Date.now() - 100 * 24 * 60 * 60 * 1000
  log.record({ action: 'user.update', now: old })
  log.record({ action: 'user.update' })

  const res = log.purgeOlderThan(90)
  assert.equal(res.removed, 1)
  assert.equal(log.list().length, 1, 'the recent entry stays')
})

test('a malformed stored detail is still returned rather than crashing the list', () => {
  const { db, log } = tmp()
  db.prepare(
    "INSERT INTO audit_logs (actor, action, detail, created_at) VALUES ('a', 'user.update', 'not json', '2026-01-01T00:00:00.000Z')",
  ).run()
  const [entry] = log.list()
  assert.equal(entry.action, 'user.update')
  assert.deepEqual(entry.detail, { raw: 'not json' })
})

test('every declared action name is namespaced', () => {
  for (const [key, value] of Object.entries(AUDIT_ACTIONS)) {
    assert.match(value, /^[a-z_]+\.[a-z_]+$/, `${key} should read domain.action`)
  }
})
