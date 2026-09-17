import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { workerPaths, CODEX_SLOT_NOT_WORKER, workerHealth } from '../../src/lib/transport/go-worker-client.mjs'
import { slotExec } from '../../src/lib/vm/slot-runtime.mjs'
import { withCodexKernelExec, codexKernelPaths } from '../../src/lib/transport/codex-kernel-client.mjs'

/**
 * 「拿 Claude 的协议去问 codex 槽」这一整类 bug。
 *
 * 线上表现是一句裸的
 *   connect ENOENT /opt/vm2api/vms/vm-03/run/worker.sock
 * 看着像文件丢了，其实是：codex 槽按设计没有 go worker（它的内核叫 codex-kernel，
 * socket 也叫 codex-kernel.sock），而一堆 Claude 形状的探针（oauth 状态、身份采集、
 * 额度探测、live 凭证采集）只按 vm id 拼路径，谁也没看槽的类型。
 *
 * 这组测试锁两层：
 *   1. 坐标层：codex exec 解不出 worker.sock，显式给了 codex socket 的照旧能用；
 *   2. 路由层：面板路由遇到 codex 槽回一句人话（明确 code/消息），不是 ENOENT。
 */

const CODEX_VM = {
  id: 'vm-03',
  name: 'codex-03',
  platform: 'openai',
  family: 'codex',
  status: 'running',
  schedulable: true,
  proxy: { id: 'px-1', host: '127.0.0.1', port: 1080, username: 'u', password: 'p' },
}

function harness({ vms = [CODEX_VM] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-paths-'))
  const prevDb = process.env.KIN_DB_PATH
  process.env.KIN_DB_PATH = path.join(dir, 'kin.db')
  const db = openDatabase()
  const usersRepo = new UsersRepo(db)
  if (!usersRepo.getById('u-1')) {
    usersRepo.insert({ id: 'u-1', username: 'u1', email: 'u1@t.local', password_hash: 'x', role: 'user' })
  }
  fs.mkdirSync(path.join(dir, 'vms'), { recursive: true })
  // active_vm 就是线上那个"默认槽"，oauth 状态接口不带 vm_id 时走的正是它
  if (vms[0]) fs.writeFileSync(path.join(dir, 'vms', 'active.json'), JSON.stringify({ active_vm: vms[0].id }))
  for (const vm of vms) {
    fs.mkdirSync(path.join(dir, 'vms', vm.id), { recursive: true })
    fs.writeFileSync(path.join(dir, 'vms', `${vm.id}.json`), JSON.stringify(vm, null, 2))
  }

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
    panelUsers: new PanelUserStore({ db }),
    usersRepo,
    stickyRouter: { repo: { countByEgress: () => ({}), listByUser: () => [] } },
    proxyPool: { probeAll: async () => ({ total: 0, healthy: 0, results: [] }), list: () => [] },
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

  return { dir, call, cleanup }
}

test('codex 槽的坐标是 codex-home，不是 cli-home', () => {
  const exec = slotExec('/opt/vm2api', CODEX_VM)
  assert.equal(exec.kind, 'codex')
  assert.equal(exec.homeDir, '/opt/vm2api/vms/vm-03/codex-home')
  const claude = slotExec('/opt/vm2api', { id: 'vm-01', platform: 'anthropic' })
  assert.equal(claude.kind, 'claude')
  assert.equal(claude.homeDir, '/opt/vm2api/vms/vm-01/cli-home')
})

test('codex 槽解不出 worker.sock，但 codex-kernel 的 socket 仍然可用', () => {
  const exec = slotExec('/opt/vm2api', CODEX_VM)
  const paths = workerPaths(exec)
  assert.equal(paths.codexSlot, true)
  assert.equal(paths.socketPath, null, '不该再拼出 worker.sock')
  // runDir/tokenPath 仍是宿主坐标：codex-kernel-client 靠它们算自己的 socket 与配置
  assert.equal(paths.runDir, '/opt/vm2api/vms/vm-03/run')

  const kernel = codexKernelPaths(exec)
  assert.equal(kernel.socketPath, '/opt/vm2api/vms/vm-03/run/codex-kernel.sock')
  assert.equal(kernel.configPath, '/opt/vm2api/vms/vm-03/run/codex-kernel.json')
  assert.equal(kernel.credentialPath, '/opt/vm2api/vms/vm-03/codex-credentials.json')
  // withCodexKernelExec 之后 go-worker 通道被显式改写，属于合法用法
  assert.equal(workerPaths(withCodexKernelExec(exec)).socketPath, kernel.socketPath)
})

test('误用 go worker 通道时回明确原因，而不是 connect ENOENT', async () => {
  const exec = slotExec('/opt/vm2api', CODEX_VM)
  const health = await workerHealth(exec, { timeoutMs: 300 })
  assert.equal(health.ok, false)
  assert.equal(health.code, CODEX_SLOT_NOT_WORKER)
  assert.match(String(health.error), /codex/)
  assert.doesNotMatch(String(health.error || ''), /ENOENT/)
})

test('GET /api/panel/oauth 对 codex 槽回答 codex 的事，不再抛 worker.sock ENOENT', async () => {
  const f = harness()
  try {
    const res = await f.call('GET', '/api/panel/oauth')
    assert.equal(res.status, 200)
    const data = res.body.data
    assert.equal(data.vm_id, 'vm-03')
    assert.equal(data.platform, 'openai')
    assert.match(String(data.refresh_owner), /^codex-(cli|kernel)$/)
    assert.ok(!('worker' in data), 'codex 槽不该有 worker 字段')
    assert.ok(!JSON.stringify(res.body).includes('worker.sock'), JSON.stringify(res.body))
    // 没有 codex 二进制（测试环境）→ auto 落到 http 引擎 → 才该探 codex-kernel
    if (data.engine === 'http') assert.ok(data.kernel, 'http 引擎应回 codex-kernel 健康')
    else assert.equal(data.kernel, null, 'CLI 引擎没有常驻 kernel，别拿它当健康标准')
  } finally {
    f.cleanup()
  }
})

test('CLI 引擎下 codex 槽的健康看凭证，不看常驻 kernel', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-cli-engine-'))
  const prev = { db: process.env.KIN_DB_PATH, engine: process.env.KIN_CODEX_ENGINE, bin: process.env.KIN_CODEX_BIN }
  process.env.KIN_DB_PATH = path.join(dir, 'kin.db')
  process.env.KIN_CODEX_ENGINE = 'cli'
  process.env.KIN_CODEX_BIN = 'codex' // PATH 上的裸命令 → codexBinaryPresent 为真
  const db = openDatabase()
  const usersRepo = new UsersRepo(db)
  if (!usersRepo.getById('u-1')) {
    usersRepo.insert({ id: 'u-1', username: 'u1', email: 'u1@t.local', password_hash: 'x', role: 'user' })
  }
  fs.mkdirSync(path.join(dir, 'vms', 'vm-03'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'vms', 'vm-03.json'), JSON.stringify(CODEX_VM))
  fs.writeFileSync(path.join(dir, 'vms', 'active.json'), JSON.stringify({ active_vm: 'vm-03' }))
  fs.writeFileSync(
    path.join(dir, 'vms', 'vm-03', 'codex-credentials.json'),
    JSON.stringify({ accounts: [{ id: 'a@t.local', access_token: 'at-1', refresh_token: 'rt-1' }] }),
  )
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
  })
  try {
    await handlePanel({ method: 'GET', headers: {} }, {}, new URL('http://localhost/api/panel/oauth'))
    const data = response.body.data
    assert.equal(data.engine, 'cli')
    assert.equal(data.kernel, null)
    assert.equal(data.ok, true, '有凭证的 CLI 引擎槽是健康的')
    assert.equal(data.credential.has_access, true)
    assert.equal(data.credential.email, null) // 夹具没写 email
  } finally {
    closeDatabase()
    for (const [key, value] of Object.entries({
      KIN_DB_PATH: prev.db,
      KIN_CODEX_ENGINE: prev.engine,
      KIN_CODEX_BIN: prev.bin,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('count_tokens / 身份采集对 codex 槽直说不支持，且不提 worker.sock', async () => {
  const f = harness()
  try {
    const tokens = await f.call('POST', '/api/panel/vms/vm-03/count-tokens', {
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(tokens.status, 400)
    assert.equal(tokens.body.error.code, 'count_tokens_unsupported')
    assert.match(tokens.body.error.message, /codex/)

    const identity = await f.call('POST', '/api/panel/vms/vm-03/collect-identity', {})
    assert.equal(identity.status, 400)
    assert.equal(identity.body.error.code, 'identity_unsupported_for_codex')
    assert.ok(!JSON.stringify(identity.body).includes('ENOENT'))
  } finally {
    f.cleanup()
  }
})

test('面板详情对 codex 槽仍然正常（kernel 健康走 codex-kernel）', async () => {
  const f = harness()
  try {
    const res = await f.call('GET', '/api/panel/vms/vm-03')
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.ok(res.body.data.vm)
    assert.ok(!JSON.stringify(res.body).includes('worker.sock'))
  } finally {
    f.cleanup()
  }
})

test('Claude 池不会去问 codex 槽的 worker（坐标按类型，健康探测直接短路）', async () => {
  const { PoolScheduler } = await import('../../src/lib/pool/pool-scheduler.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-pool-'))
  try {
    const scheduler = new PoolScheduler({
      projectRoot: dir,
      workerHealth: async () => {
        throw new Error('不该走到这里：codex 槽没有 go worker')
      },
    })
    const exec = scheduler.executionContext(CODEX_VM, 'acc-1')
    assert.equal(exec.kind, 'codex')
    assert.equal(exec.homeDir, path.join(dir, 'vms', 'vm-03', 'codex-home'))
    const health = await scheduler.getWorkerHealth(exec)
    assert.equal(health.code, CODEX_SLOT_NOT_WORKER)
    assert.equal(health.source, 'codex-slot')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
