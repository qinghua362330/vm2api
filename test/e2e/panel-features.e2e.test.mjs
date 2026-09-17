import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

/**
 * 已移植功能在真实 HTTP 上的验证。
 *
 * handler 级测试用 `requireAuth` 桩掉了身份，而身份正是最容易出问题的一层：
 * `req.panelUserId` 来自会话，路由里每一次"自己的 / 别人的"判断都依赖它。
 * 这条测试用真服务 + 真登录跑一遍，覆盖 HTTP → 鉴权 → 身份 → 路由 → service。
 */

async function login(gw, username, password) {
  const response = await fetch(`${gw.baseUrl}/api/panel/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (response.status !== 200) return { ok: false, status: response.status, cookie: '' }
  return { ok: true, status: response.status, cookie: response.headers.get('set-cookie') || '' }
}

const withCookie = (gw, cookie, method, urlPath, body) =>
  api(gw, method, urlPath, {
    body,
    headers: cookie ? { cookie, authorization: '' } : undefined,
  })

test('运营面：用户属性定义 → 带属性建号 → attr_ 筛选', async () => {
  const gw = await startGateway()
  try {
    const master = await withCookie(gw, '', 'GET', '/api/panel/user-attributes')
    assert.equal(master.status, 200, master.text)
    assert.deepEqual(master.json.data.attributes, [])

    const def = await withCookie(gw, '', 'POST', '/api/panel/user-attributes', {
      name: '渠道来源',
      type: 'select',
      options: ['抖音', 'B站'],
      show_in_filter: true,
    })
    assert.equal(def.status, 200, def.text)

    const created = await withCookie(gw, '', 'POST', '/api/panel/users', {
      username: 'tenant-a',
      password: 'tenant-a',
      role: 'user',
      attributes: { 渠道来源: '抖音' },
    })
    assert.equal(created.status, 200, created.text)
    assert.equal(created.json.data.attributes.applied.length, 1)

    const hit = await withCookie(gw, '', 'GET', `/api/panel/users?attr_${encodeURIComponent('渠道来源')}=抖音`)
    assert.equal(hit.status, 200, hit.text)
    assert.equal(hit.json.data.total, 1)
    assert.equal(hit.json.data.users[0].attributes['渠道来源'], '抖音')

    const miss = await withCookie(gw, '', 'GET', `/api/panel/users?attr_${encodeURIComponent('渠道来源')}=B站`)
    assert.equal(miss.json.data.total, 0)

    // A filter for an attribute that does not exist must not hide every row:
    // the count has to match the unfiltered list, whatever else is seeded.
    const unfiltered = await withCookie(gw, '', 'GET', '/api/panel/users')
    const stale = await withCookie(gw, '', 'GET', '/api/panel/users?attr_nope=1')
    assert.equal(stale.json.data.total, unfiltered.json.data.total)
    assert.deepEqual(stale.json.data.ignored_attribute_filters, ['nope'])
  } finally {
    await gw.stop()
  }
})

test('租户：登录后只看得到自己的钱包与额度', async () => {
  const gw = await startGateway()
  try {
    const created = await withCookie(gw, '', 'POST', '/api/panel/users', {
      username: 'tenant-b',
      password: 'tenant-b',
      role: 'user',
    })
    assert.equal(created.status, 200, created.text)
    const tenantId = created.json.data.user.id
    await withCookie(gw, '', 'POST', '/api/panel/billing/adjust', { user_id: tenantId, amount: 30 })
    await withCookie(gw, '', 'POST', '/api/panel/subscriptions', { user_id: tenantId, days: 7, daily_quota: 5 })

    const session = await login(gw, 'tenant-b', 'tenant-b')
    assert.equal(session.ok, true, 'tenant login')

    const wallet = await withCookie(gw, session.cookie, 'GET', '/api/panel/wallet')
    assert.equal(wallet.status, 200, wallet.text)
    assert.equal(wallet.json.data.user_id, tenantId)
    assert.equal(wallet.json.data.balance, 30)
    assert.equal(wallet.json.data.subscription.active, true)

    const own = await withCookie(gw, session.cookie, 'GET', `/api/panel/subscriptions/user/${tenantId}`)
    assert.equal(own.status, 200, own.text)
    assert.equal(own.json.data.usage.active, true)

    // Somebody else's allowance is not a tenant's business.
    const other = await withCookie(gw, session.cookie, 'GET', '/api/panel/subscriptions/user/admin')
    assert.equal(other.status, 403, other.text)

    // And the operator surfaces stay shut.
    for (const [method, url] of [
      ['GET', '/api/panel/users'],
      ['GET', '/api/panel/audit-logs'],
      ['GET', '/api/panel/user-attributes'],
      ['GET', '/api/panel/redeem'],
      ['GET', '/api/panel/channel-monitor'],
      ['GET', '/api/panel/ops'],
      ['POST', '/api/panel/billing/adjust'],
    ]) {
      const response = await withCookie(
        gw,
        session.cookie,
        method,
        url,
        method === 'POST' ? { user_id: tenantId, amount: 1 } : undefined,
      )
      assert.ok([403, 404].includes(response.status), `${method} ${url} -> ${response.status}`)
    }

    // The tenant's own top-up path exists, and refuses only because no payment
    // channel is configured on a fresh install.
    const checkout = await withCookie(gw, session.cookie, 'POST', '/api/panel/payments/checkout', { amount: 10 })
    assert.equal(checkout.status, 400, checkout.text)
    assert.equal(checkout.json.error.code, 'channel_unavailable')
  } finally {
    await gw.stop()
  }
})

test('公告与兑换码在真实 HTTP 上可用', async () => {
  const gw = await startGateway()
  try {
    const announcement = await withCookie(gw, '', 'POST', '/api/panel/announcements', {
      title: '上线通知',
      body: '已上线',
      status: 'published',
      audience: 'all',
    })
    assert.equal(announcement.status, 200, announcement.text)

    const batch = await withCookie(gw, '', 'POST', '/api/panel/redeem', {
      count: 1,
      value: 20,
      type: 'balance',
      max_uses: 1,
    })
    assert.equal(batch.status, 200, batch.text)
    const code = batch.json.data.codes[0]

    const created = await withCookie(gw, '', 'POST', '/api/panel/users', {
      username: 'tenant-c',
      password: 'tenant-c',
      role: 'user',
    })
    const tenantId = created.json.data.user.id

    const used = await withCookie(gw, '', 'POST', `/api/panel/redeem/${encodeURIComponent(code)}/use`, {
      user_id: tenantId,
    })
    assert.equal(used.status, 200, used.text)
    assert.equal(used.json.data.ok, true)

    const wallet = await withCookie(gw, '', 'GET', `/api/panel/wallet?user_id=${tenantId}`)
    assert.equal(wallet.json.data.balance, 20)

    const audit = await withCookie(gw, '', 'GET', '/api/panel/audit-logs')
    assert.equal(audit.status, 200, audit.text)
    const actions = audit.json.data.entries.map((entry) => entry.action)
    assert.ok(actions.includes('redeem.create_batch'), actions.join(','))
    assert.ok(actions.includes('announcement.create'), actions.join(','))
  } finally {
    await gw.stop()
  }
})
