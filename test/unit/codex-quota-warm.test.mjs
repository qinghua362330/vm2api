import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { writeCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'

/**
 * codex 额度快照的自动预热。
 *
 * 线上现象：codex 槽明明导了凭证、跑起来了，面板上还是
 * `5 小时已用 0% / 7 天已用 0% / 重置 —`，因为快照只有那个
 * 「查询重置券」按钮会去拉。这组测试锁住三个触发点：导入凭证、
 * 启动槽、打开详情页；顺带锁住节流与"claude 槽不预热"。
 */

function writeVm(dir, id, vm) {
  fs.mkdirSync(path.join(dir, 'vms', id), { recursive: true })
  fs.writeFileSync(path.join(dir, 'vms', `${id}.json`), JSON.stringify({ id, ...vm }, null, 2))
}

function fixture({ withCredential = true, kind = 'codex' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-quota-warm-'))
  const prevDb = process.env.KIN_DB_PATH
  process.env.KIN_DB_PATH = path.join(dir, 'kin.db')
  const db = openDatabase()
  const usersRepo = new UsersRepo(db)
  if (!usersRepo.getById('u-1')) {
    usersRepo.insert({ id: 'u-1', username: 'u1', email: 'u1@t.local', password_hash: 'x', role: 'user' })
  }
  const panelUsers = new PanelUserStore({ db })

  writeVm(dir, 'vm-codex', {
    platform: kind === 'codex' ? 'openai' : 'anthropic',
    family: kind,
    status: 'running',
    schedulable: true,
    proxy: { id: 'px-1', host: '127.0.0.1', port: 1080, username: 'u', password: 'p' },
  })
  if (withCredential) {
    writeCodexAccounts(dir, 'vm-codex', [
      { id: 'a@t.local', email: 'a@t.local', access_token: 'at-1', refresh_token: 'rt-1' },
    ])
  }

  const warmed = []
  let body = {}
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project: dir, root: dir }, base_url: 'http://localhost:8787' },
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
    stickyRouter: { repo: { countByEgress: () => ({}), listByUser: () => [] } },
    proxyPool: { probeAll: async () => ({ total: 0, healthy: 0, results: [] }), list: () => [] },
    // 替身：真实实现要经 SOCKS5 打上游，单测里不需要也不应该联网
    async codexQuotaRefresh({ id }) {
      warmed.push(id)
      return { ok: true, data: { vm_id: id } }
    },
  })

  const call = async (method, url, nextBody) => {
    body = nextBody
    delete response.status
    delete response.body
    const handled = await handlePanel({ method, headers: {} }, {}, new URL(`http://localhost${url}`))
    assert.equal(handled, true, `${method} ${url} was not handled`)
    return { status: response.status, body: response.body }
  }

  const cleanup = () => {
    closeDatabase()
    if (prevDb === undefined) delete process.env.KIN_DB_PATH
    else process.env.KIN_DB_PATH = prevDb
    fs.rmSync(dir, { recursive: true, force: true })
  }

  return { dir, call, warmed, cleanup, writeVm: (id, vm) => writeVm(dir, id, vm) }
}

/** 预热是 fire-and-forget，等一轮 microtask + 一次 tick 即可观察 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test('打开 codex 槽详情会顺手预热额度快照，且节流窗口内只拉一次', async () => {
  const f = fixture()
  try {
    const first = await f.call('GET', '/api/panel/vms/vm-codex')
    assert.equal(first.status, 200)
    assert.equal(first.body.ok, true)
    await settle()
    assert.deepEqual(f.warmed, ['vm-codex'], '首次打开详情应触发一次额度刷新')

    await f.call('GET', '/api/panel/vms/vm-codex')
    await settle()
    assert.deepEqual(f.warmed, ['vm-codex'], '3 分钟节流窗口内不应重复拉取')
  } finally {
    f.cleanup()
  }
})

test('claude 槽不会被 codex 额度预热打扰', async () => {
  const f = fixture({ kind: 'claude' })
  try {
    const res = await f.call('GET', '/api/panel/vms/vm-codex')
    assert.equal(res.status, 200)
    await settle()
    assert.deepEqual(f.warmed, [])
  } finally {
    f.cleanup()
  }
})

test('没有凭证的 codex 槽不预热（省一次必然失败的出网）', async () => {
  const f = fixture({ withCredential: false })
  try {
    await f.call('GET', '/api/panel/vms/vm-codex')
    await settle()
    assert.deepEqual(f.warmed, [])
  } finally {
    f.cleanup()
  }
})

test('导入 codex 凭证后立即预热，不受节流限制', async () => {
  const f = fixture({ withCredential: false })
  try {
    await f.call('GET', '/api/panel/vms/vm-codex')
    await settle()
    assert.deepEqual(f.warmed, [], '没凭证时不该预热')

    const res = await f.call('POST', '/api/panel/vms/import', {
      vm_id: 'vm-codex',
      access_token: 'at-2',
      refresh_token: 'rt-2',
      account_id: 'acc-2',
      email: 'b@t.local',
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    await settle()
    assert.deepEqual(f.warmed, ['vm-codex'], '导入后应立刻拉一次额度')
  } finally {
    f.cleanup()
  }
})

test('刷新失败不占用节流窗口，下一次请求还能再试', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-quota-warm-fail-'))
  const prevDb = process.env.KIN_DB_PATH
  process.env.KIN_DB_PATH = path.join(dir, 'kin.db')
  const db = openDatabase()
  const usersRepo = new UsersRepo(db)
  if (!usersRepo.getById('u-1')) {
    usersRepo.insert({ id: 'u-1', username: 'u1', email: 'u1@t.local', password_hash: 'x', role: 'user' })
  }
  writeVm(dir, 'vm-codex', {
    platform: 'openai',
    family: 'codex',
    status: 'running',
    schedulable: true,
    proxy: { id: 'px-1', host: '127.0.0.1', port: 1080 },
  })
  fs.mkdirSync(path.join(dir, 'vms', 'vm-codex'), { recursive: true })
  writeCodexAccounts(dir, 'vm-codex', [{ id: 'a@t.local', access_token: 'at-1', refresh_token: 'rt-1' }])

  const attempts = []
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project: dir, root: dir }, base_url: 'http://localhost:8787' },
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
    readBody: async () => ({}),
    panelUsers: new PanelUserStore({ db }),
    usersRepo,
    stickyRouter: { repo: { countByEgress: () => ({}), listByUser: () => [] } },
    proxyPool: { probeAll: async () => ({ total: 0, healthy: 0, results: [] }), list: () => [] },
    async codexQuotaRefresh() {
      attempts.push(Date.now())
      return { status: 502, body: { ok: false, error: { code: 'upstream_error' } } }
    },
  })

  try {
    const call = async () => {
      delete response.status
      const handled = await handlePanel(
        { method: 'GET', headers: {} },
        {},
        new URL('http://localhost/api/panel/vms/vm-codex'),
      )
      assert.equal(handled, true)
      return response.status
    }
    assert.equal(await call(), 200)
    await settle()
    assert.equal(attempts.length, 1)
    assert.equal(await call(), 200)
    await settle()
    assert.equal(attempts.length, 2, '上一轮失败过就不该被节流挡住')
  } finally {
    closeDatabase()
    if (prevDb === undefined) delete process.env.KIN_DB_PATH
    else process.env.KIN_DB_PATH = prevDb
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
