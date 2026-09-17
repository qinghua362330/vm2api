import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authorizePanelRoute, viewsForRole, hasCapability, canViewPage } from '../../src/lib/admin/panel-acl.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

const serverSrc = [
  fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/lib/admin/panel-routes.mjs'),
    'utf8',
  ),
  fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/server.mjs'), 'utf8'),
].join('\n')

test('user sees vm / proxies / keys / billing / logs + 自助钱包与公告', () => {
  assert.deepEqual(viewsForRole('user'), ['vm', 'proxies', 'keys', 'billing', 'logs', 'wallet', 'announcements'])
  assert.equal(canViewPage('user', 'vm'), true)
  assert.equal(canViewPage('user', 'overview'), false)
  assert.equal(canViewPage('super', 'vm'), true)
  assert.equal(canViewPage('admin', 'users'), true)
  assert.equal(canViewPage('admin', 'api'), true)
  assert.equal(canViewPage('user', 'api'), false)
  assert.equal(canViewPage('admin', 'database'), true)
  assert.equal(canViewPage('super', 'database'), false)
  assert.equal(canViewPage('user', 'database'), false)
  assert.equal(hasCapability('super', 'vm.schedule'), true)
  assert.equal(hasCapability('user', 'vm.schedule'), true)
})

test('user can manage owned vm/proxy/key surfaces and nothing else', () => {
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms', 'user').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-01', 'user').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/create', 'user').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/schedulable', 'user').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/import', 'user').ok, true)
  assert.equal(authorizePanelRoute('DELETE', '/api/panel/vms/vm-01', 'user').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/proxies', 'user').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/api-keys', 'user').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/request-logs', 'user').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/dashboard', 'user').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/usage', 'user').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/official-cc-bootstrap', 'user').ok, false)
  assert.equal(authorizePanelRoute('PATCH', '/api/panel/vms/vm-01/owner', 'user').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/users', 'user').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/database/metrics', 'user').ok, false)
})

test('super can schedule VMs but cannot touch credentials or delete', () => {
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-01', 'super').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/schedulable', 'super').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/cooldown/clear', 'super').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/import', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/oauth/refresh', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/oauth/generate-auth-url', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/oauth/exchange-code', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/oauth/to-setup-token', 'super').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-01/oauth/credential', 'super').ok, false)
  assert.equal(authorizePanelRoute('PUT', '/api/panel/vms/vm-01/oauth/credential', 'super').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-01/oauth/credential', 'user').ok, false)
  assert.equal(authorizePanelRoute('DELETE', '/api/panel/vms/vm-01', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/create', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/users', 'super').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/database/metrics', 'super').ok, false)
})

test('前台 nav 里的每个 view 都要被 admin 授权（防漂移）', () => {
  // 侧边栏按 me.views 过滤：ACL 漏一个 view，那个页面就"页面和接口都在、就是点不到"。
  // 这条用例直接从 nav.ts 里读 id，两个文件再也没法悄悄走散。
  const nav = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src/config/nav.ts'),
    'utf8',
  )
  const ids = [...nav.matchAll(/\{ id: '([^']+)'/g)].map((m) => m[1])
  assert.ok(ids.length > 20, `nav.ts 解析出 ${ids.length} 个 view，太少了，解析大概坏了`)
  const allowed = new Set(viewsForRole('admin'))
  const missing = ids.filter((id) => !allowed.has(id))
  assert.deepEqual(missing, [], `这些页面没被授权，控制台里点不到：${missing.join(', ')}`)
})

test('租户视图是 admin 的子集，且能看自己的钱包与公告', () => {
  const admin = new Set(viewsForRole('admin'))
  for (const view of viewsForRole('user')) {
    assert.ok(admin.has(view), `租户视图 ${view} 不在 admin 列表里`)
  }
  assert.equal(canViewPage('user', 'wallet'), true, '租户要能看自己的钱包')
  assert.equal(canViewPage('user', 'announcements'), true, '公告是给租户看的')
  assert.equal(canViewPage('user', 'users'), false, '租户看不到用户管理')
  assert.equal(canViewPage('user', 'ops'), false, '租户看不到运营大盘')
})

test('admin is unrestricted', () => {
  assert.equal(authorizePanelRoute('DELETE', '/api/panel/vms/vm-01', 'admin').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/settings', 'admin').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/import', 'admin').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/database/metrics', 'admin').ok, true)
})

test('managed keys cannot bypass admin role checks through models refresh', async () => {
  let authCalls = 0
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: {},
    requireAuth(req) {
      authCalls += 1
      req.apiKeyKind = 'managed'
      return true
    },
    json(_res, status, body) {
      response.status = status
      response.body = body
    },
  })

  const handled = await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/admin/models/refresh'))
  assert.equal(authCalls, 1)
  assert.equal(handled, true)
  assert.equal(response.status, 403)
  assert.equal(response.body.error.code, 'forbidden')
})

test('admin models refresh stays delegated to the server route', async () => {
  let authCalls = 0
  const handlePanel = createPanelHandler({
    cfg: {},
    requireAuth(req) {
      authCalls += 1
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    json() {
      assert.fail('delegated admin refresh must not respond in the panel handler')
    },
  })

  const handled = await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/admin/models/refresh'))
  assert.equal(authCalls, 1)
  assert.equal(handled, false)
})

test('ACL schedule POSTs have matching server handlers', () => {
  assert.match(serverSrc, /clearVmCooldown/)
  assert.match(serverSrc, /cooldown\\\/clear/)
  assert.match(serverSrc, /\/schedulable\$/)
})

// ── 钱包：租户可以看和动自己的钱，但碰不到别人的 ────────────────────────────

test('a tenant may reach exactly the wallet routes', () => {
  const allowed = [
    ['GET', '/api/panel/wallet'],
    ['GET', '/api/panel/payments/mine'],
    ['POST', '/api/panel/payments/checkout'],
    ['GET', '/api/panel/subscriptions/user/u1'],
  ]
  for (const [method, path] of allowed) {
    assert.equal(authorizePanelRoute(method, path, 'user').ok, true, `${method} ${path} should be allowed`)
  }
})

test('a tenant may not reach the operator money surfaces', () => {
  const denied = [
    ['GET', '/api/panel/payments/orders'],
    ['GET', '/api/panel/payments/config'],
    ['PUT', '/api/panel/payments/config'],
    ['POST', '/api/panel/payments/orders/P1/confirm'],
    ['GET', '/api/panel/billing/ledger'],
    ['POST', '/api/panel/billing/adjust'],
    ['GET', '/api/panel/users'],
    ['POST', '/api/panel/redeem'],
  ]
  for (const [method, path] of denied) {
    assert.equal(authorizePanelRoute(method, path, 'user').ok, false, `${method} ${path} should be denied`)
  }
})

test('the operator still reaches every wallet route', () => {
  for (const [method, path] of [
    ['GET', '/api/panel/payments/orders'],
    ['GET', '/api/panel/payments/config'],
    ['PUT', '/api/panel/payments/config'],
    ['GET', '/api/panel/billing/ledger'],
  ]) {
    assert.equal(authorizePanelRoute(method, path, 'admin').ok, true, `${method} ${path} should be allowed`)
  }
})

test('an unknown path under the money prefix is not waved through', () => {
  assert.equal(authorizePanelRoute('GET', '/api/panel/payments/whatever', 'user').ok, false)
  assert.equal(authorizePanelRoute('DELETE', '/api/panel/wallet', 'user').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/wallet', 'user').ok, false)
})
