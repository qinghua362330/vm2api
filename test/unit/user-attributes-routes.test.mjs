import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, openDatabase } from '../../src/lib/db/database.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { AuditLog } from '../../src/lib/admin/audit-log.mjs'

/**
 * 用户属性的 HTTP 面：前端的 `attr_<key>` 前缀、`attributes` 请求体、以及定义
 * CRUD 必须和服务端一致。这里走真实路由而不是直接调类，因为两边各写一次的字符串
 * 正是最容易静默失配的地方。
 */

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-attr-routes-'))
  const prev = process.env.KIN_DB_PATH
  process.env.KIN_DB_PATH = path.join(dir, 'kin.db')
  const db = openDatabase()
  const usersRepo = new UsersRepo(db)
  usersRepo.insert({ id: 'seed', username: 'seed', email: 'seed@t.local', password_hash: 'x', role: 'user' })
  const panelUsers = new PanelUserStore({ db })

  let body = {}
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project: dir, root: dir } },
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => body,
    panelUsers,
    usersRepo,
  })

  const call = async (method, url, nextBody) => {
    body = nextBody
    delete response.status
    delete response.body
    const handled = await handlePanel({ method, headers: {} }, {}, new URL(`http://localhost${url}`))
    assert.equal(handled, true, `${method} ${url} was not handled`)
    // A snapshot, not the shared response object: holding the live object would
    // let the next call overwrite what the previous assertion is about to read.
    return { status: response.status, body: response.body }
  }

  const cleanup = () => {
    closeDatabase()
    if (prev === undefined) delete process.env.KIN_DB_PATH
    else process.env.KIN_DB_PATH = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }

  return { dir, db, call, cleanup, panelUsers }
}

test('attribute definitions round-trip over the panel API', async () => {
  const h = harness()
  try {
    const created = await h.call('POST', '/api/panel/user-attributes', {
      name: '渠道来源',
      type: 'select',
      options: ['抖音', 'B站'],
      show_in_filter: true,
    })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    assert.equal(created.body.data.attribute.key, '渠道来源')
    assert.equal(created.body.data.attribute.show_in_filter, true)

    const listed = await h.call('GET', '/api/panel/user-attributes')
    assert.equal(listed.status, 200)
    assert.deepEqual(
      listed.body.data.attributes.map((d) => d.key),
      ['渠道来源'],
    )

    const bad = await h.call('POST', '/api/panel/user-attributes', { name: '空选项', type: 'select', options: [] })
    assert.equal(bad.status, 400, 'a select without options must be refused')

    const patched = await h.call('PATCH', `/api/panel/user-attributes/${created.body.data.attribute.id}`, {
      options: ['抖音', 'B站', '朋友推荐'],
    })
    assert.deepEqual(patched.body.data.attribute.options, ['抖音', 'B站', '朋友推荐'])
  } finally {
    h.cleanup()
  }
})

test('a user created with attributes is filterable through attr_ params', async () => {
  const h = harness()
  try {
    await h.call('POST', '/api/panel/user-attributes', { name: 'source', type: 'select', options: ['douyin', 'bili'] })
    await h.call('POST', '/api/panel/user-attributes', { name: 'vip', type: 'bool' })

    const created = await h.call('POST', '/api/panel/users', {
      username: 'alice',
      password: 'pw-alice-1',
      attributes: { source: 'douyin', vip: 'yes' },
    })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    // bool is stored canonically, not as the word the operator typed.
    assert.deepEqual(created.body.data.attributes.applied, [
      { key: 'source', value: 'douyin' },
      { key: 'vip', value: 'true' },
    ])

    const hit = await h.call('GET', '/api/panel/users?attr_source=douyin')
    assert.equal(hit.body.data.total, 1)
    assert.equal(hit.body.data.users[0].username, 'alice')
    assert.equal(hit.body.data.users[0].attributes.vip, 'true')

    const miss = await h.call('GET', '/api/panel/users?attr_source=bili')
    assert.equal(miss.body.data.total, 0)

    const both = await h.call('GET', '/api/panel/users?attr_source=douyin&attr_vip=true')
    assert.equal(both.body.data.total, 1)
    const contradiction = await h.call('GET', '/api/panel/users?attr_source=douyin&attr_vip=false')
    assert.equal(contradiction.body.data.total, 0)

    // A user without the attribute never matches a filter on it.
    const seed = await h.call('GET', '/api/panel/users?attr_source=douyin&search=seed')
    assert.equal(seed.body.data.total, 0)
  } finally {
    h.cleanup()
  }
})

test('rejected values are reported and do not create rows', async () => {
  const h = harness()
  try {
    await h.call('POST', '/api/panel/user-attributes', { name: 'source', type: 'select', options: ['douyin'] })
    const created = await h.call('POST', '/api/panel/users', {
      username: 'bob',
      password: 'pw-bob-1',
      attributes: { source: 'douyin', nope: 'x' },
    })
    assert.equal(created.status, 200)
    assert.equal(created.body.data.attributes.ok, false)
    assert.deepEqual(created.body.data.attributes.rejected, [{ key: 'nope', reason: 'unknown_attribute' }])

    // The user exists (attributes are applied after the insert) and only the
    // valid key landed.
    const listed = await h.call('GET', '/api/panel/users?search=bob')
    assert.equal(listed.body.data.total, 1)
    assert.deepEqual(listed.body.data.users[0].attributes, { source: 'douyin' })
  } finally {
    h.cleanup()
  }
})

test('PATCH replaces attributes and clearing removes the row', async () => {
  const h = harness()
  try {
    await h.call('POST', '/api/panel/user-attributes', { name: 'vip', type: 'bool' })
    const created = await h.call('POST', '/api/panel/users', {
      username: 'carol',
      password: 'pw-carol-1',
      attributes: { vip: 'true' },
    })
    const id = created.body.data.user.id

    const off = await h.call('PATCH', `/api/panel/users/${id}`, { attributes: { vip: 'no' } })
    assert.equal(off.status, 200, JSON.stringify(off.body))
    assert.deepEqual(off.body.data.attributes.applied, [{ key: 'vip', value: 'false' }])

    const cleared = await h.call('PATCH', `/api/panel/users/${id}`, { attributes: { vip: '' } })
    assert.deepEqual(cleared.body.data.attributes.applied, [{ key: 'vip', value: null }])

    const rows = getDb().prepare('SELECT COUNT(*) AS c FROM user_attribute_values').get()
    assert.equal(Number(rows.c), 0, 'clearing an attribute deletes the value row')
  } finally {
    h.cleanup()
  }
})

test('deleting a definition clears every user value and the filter', async () => {
  const h = harness()
  try {
    const def = await h.call('POST', '/api/panel/user-attributes', { name: 'source', type: 'text' })
    const defId = def.body.data.attribute.id
    await h.call('POST', '/api/panel/users', {
      username: 'dave',
      password: 'pw-dave-1',
      attributes: { source: 'x' },
    })
    assert.equal((await h.call('GET', '/api/panel/users?attr_source=x')).body.data.total, 1)

    const removed = await h.call('DELETE', `/api/panel/user-attributes/${defId}`)
    assert.equal(removed.status, 200)
    assert.equal((await h.call('GET', '/api/panel/user-attributes')).body.data.attributes.length, 0)
    // Once the definition is gone the filter is inert — a stale query string left
    // in a browser tab must not silently hide every user — and the response says
    // which filters it ignored rather than pretending they were applied.
    const stale = await h.call('GET', '/api/panel/users?attr_source=x')
    assert.equal(stale.body.data.total, 2, 'seed + dave')
    assert.deepEqual(stale.body.data.ignored_attribute_filters, ['source'])
    assert.equal(Number(getDb().prepare('SELECT COUNT(*) AS c FROM user_attribute_values').get().c), 0)
  } finally {
    h.cleanup()
  }
})

test('every attribute mutation is audited, with the password redacted', async () => {
  const h = harness()
  try {
    await h.call('POST', '/api/panel/user-attributes', { name: 'source', type: 'text' })
    const user = await h.call('POST', '/api/panel/users', {
      username: 'erin',
      password: 'pw-erin-1',
      attributes: { source: 'x' },
    })
    const logs = new AuditLog(getDb()).list({ limit: 50 })
    const actions = logs.map((entry) => entry.action)
    assert.ok(actions.includes('user_attribute.create'), actions.join(','))
    assert.ok(actions.includes('user.create'), actions.join(','))
    assert.ok(actions.includes('user_attribute.set_values'), actions.join(','))

    const created = logs.find((entry) => entry.action === 'user.create')
    assert.equal(created.actor, 'master')
    assert.equal(created.target_id, user.body.data.user.id, 'the row names the user that was created')
    // The create body carries the password; the audit row must not.
    assert.equal(JSON.stringify(created.detail).includes('pw-erin-1'), false, JSON.stringify(created.detail))

    // A create that fails must not leave an audit row claiming it happened.
    const before = new AuditLog(getDb()).list({ limit: 200 }).filter((e) => e.action === 'user.create').length
    const failed = await h.call('POST', '/api/panel/users', { username: 'erin', password: 'pw-again-1' })
    assert.equal(failed.status, 400, 'duplicate username')
    const after = new AuditLog(getDb()).list({ limit: 200 }).filter((e) => e.action === 'user.create').length
    assert.equal(after, before, 'a rejected create is not an event')
  } finally {
    h.cleanup()
  }
})
