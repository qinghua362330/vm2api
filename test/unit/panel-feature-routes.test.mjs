import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, openDatabase } from '../../src/lib/db/database.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { EgressBindingsRepo } from '../../src/lib/db/repos/egress-bindings-repo.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'

/**
 * 已移植功能的冒烟测试：每个功能至少走一次真实路由。
 *
 * 这组测试的存在理由很具体：`panel-routes.mjs` 里曾经有 33 处 `audit(req, …)`
 * 调用指向一个从未定义的名字，于是"审计"变成了"500" —— 而此前所有测试都是直接
 * 调用 service 类，没有一条路由被真正执行过，所以全绿。凡是"功能已实现"的断言，
 * 都应该由一次真实请求来证明，而不是由模块存在来证明。
 */

function harness({ role = 'admin', dir: sharedDir = null, sticky = false } = {}) {
  const dir = sharedDir || fs.mkdtempSync(path.join(os.tmpdir(), 'kin-feature-routes-'))
  const prevDb = process.env.KIN_DB_PATH
  process.env.KIN_DB_PATH = path.join(dir, 'kin.db')
  const db = openDatabase()
  const usersRepo = new UsersRepo(db)
  if (!usersRepo.getById('u-1')) {
    usersRepo.insert({ id: 'u-1', username: 'u1', email: 'u1@t.local', password_hash: 'x', role: 'user' })
    usersRepo.insert({ id: 'u-2', username: 'u2', email: 'u2@t.local', password_hash: 'x', role: 'user', balance: 999 })
  }
  const panelUsers = new PanelUserStore({ db })

  // 同一个实例喂给 handler 也返回给测试，避免"写这个读那个"的假通过。
  const stickyRouter = sticky ? new StickyRouter({ db }) : { repo: { countByEgress: () => ({}), listByUser: () => [] } }

  let body = {}
  const response = {}
  const probed = []
  const handlePanel = createPanelHandler({
    cfg: { paths: { project: dir, root: dir }, base_url: 'http://localhost:8787' },
    requireAuth(req) {
      if (role === 'admin') {
        req.apiKeyKind = 'master'
        req.panelRole = 'admin'
      } else {
        req.panelUser = 'u1'
        req.panelUserId = 'u-1'
        req.panelRole = role
      }
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
    stickyRouter,
    proxyPool: {
      probeAll: async () => {
        probed.push(1)
        return { total: 0, healthy: 0, results: [] }
      },
      list: () => [],
    },
  })

  const call = async (method, url, nextBody) => {
    body = nextBody
    delete response.status
    delete response.body
    const handled = await handlePanel({ method, headers: {} }, {}, new URL(`http://localhost${url}`))
    assert.equal(handled, true, `${method} ${url} was not handled`)
    return { status: response.status, body: response.body, probed: probed.length }
  }

  const cleanup = () => {
    closeDatabase()
    if (prevDb === undefined) delete process.env.KIN_DB_PATH
    else process.env.KIN_DB_PATH = prevDb
    fs.rmSync(dir, { recursive: true, force: true })
  }

  return { dir, db, call, cleanup, stickyRouter }
}

const ok = (response, label) => {
  assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.body)}`)
  return response.body.data
}

test('兑换码：生成 → 列表 → 核销入账 → 删除', async () => {
  const h = harness()
  try {
    const created = ok(
      await h.call('POST', '/api/panel/redeem', { count: 2, value: 25, type: 'balance', max_uses: 1, batch: 'b1' }),
      'create batch',
    )
    assert.equal(created.created, 2)
    const code = created.codes[0]

    const list = ok(await h.call('GET', '/api/panel/redeem'), 'list')
    assert.equal(list.codes.length, 2)

    const used = ok(await h.call('POST', `/api/panel/redeem/${code}/use`, { user_id: 'u-1' }), 'redeem')
    assert.equal(used.ok, true)
    assert.equal(Number(getDb().prepare('SELECT balance FROM users WHERE id = ?').get('u-1').balance), 25)

    // A code with max_uses 1 cannot be spent twice.
    const again = await h.call('POST', `/api/panel/redeem/${code}/use`, { user_id: 'u-1' })
    assert.equal(again.body.data.ok, false)

    const removed = ok(await h.call('DELETE', `/api/panel/redeem/${list.codes[1].id ?? list.codes[1]._id}`), 'delete')
    assert.ok(removed.removed != null)
  } finally {
    h.cleanup()
  }
})

test('订阅：发放 → 概览 → 续期 → 撤销', async () => {
  const h = harness()
  try {
    const granted = ok(
      await h.call('POST', '/api/panel/subscriptions', { user_id: 'u-1', days: 30, daily_quota: 100 }),
      'grant',
    )
    assert.equal(granted.subscription.user_id, 'u-1')
    assert.equal(granted.subscription.daily_quota, 100)

    const overview = ok(await h.call('GET', '/api/panel/subscriptions'), 'overview')
    assert.equal(overview.subscriptions.length, 1)

    const extended = ok(await h.call('POST', '/api/panel/subscriptions', { user_id: 'u-1', days: 10 }), 'extend')
    assert.equal(extended.extended, true)
    assert.ok(
      Date.parse(extended.subscription.expires_at) > Date.parse(granted.subscription.expires_at),
      'renewal extends rather than restarts',
    )

    const mine = ok(await h.call('GET', '/api/panel/subscriptions/user/u-1'), 'user view')
    assert.ok(mine.usage)

    const id = extended.subscription.id
    const revoked = ok(await h.call('DELETE', `/api/panel/subscriptions/${id}`), 'revoke')
    assert.equal(revoked.subscription.status, 'revoked')
    // Revoking ends the allowance but keeps the row: the console shows it as
    // history, and the reason it no longer applies has to stay visible.
    const after = ok(await h.call('GET', '/api/panel/subscriptions'), 'after revoke')
    assert.equal(after.subscriptions.length, 1)
    assert.equal(after.subscriptions[0].status, 'revoked')
    const usage = ok(await h.call('GET', '/api/panel/subscriptions/user/u-1'), 'usage after revoke')
    assert.equal(usage.usage.active, false)
  } finally {
    h.cleanup()
  }
})

test('公告：发布 → 面向用户可见 → 下线', async () => {
  const h = harness()
  try {
    const created = ok(
      await h.call('POST', '/api/panel/announcements', {
        title: '维护通知',
        body: '今晚 23:00 维护',
        status: 'published',
        audience: 'all',
      }),
      'create',
    )
    assert.equal(created.announcement.title, '维护通知')

    const all = ok(await h.call('GET', '/api/panel/announcements?all=1'), 'admin list')
    assert.equal(all.announcements.length, 1)

    const visible = ok(await h.call('GET', '/api/panel/announcements'), 'visible list')
    assert.equal(visible.announcements.length, 1)

    ok(await h.call('PATCH', `/api/panel/announcements/${created.announcement.id}`, { status: 'draft' }), 'update')
    const afterDraft = ok(await h.call('GET', '/api/panel/announcements'), 'visible after draft')
    assert.equal(afterDraft.announcements.length, 0, 'a draft is not announced')

    ok(await h.call('DELETE', `/api/panel/announcements/${created.announcement.id}`), 'delete')
    assert.equal(
      ok(await h.call('GET', '/api/panel/announcements?all=1'), 'admin after delete').announcements.length,
      0,
    )
  } finally {
    h.cleanup()
  }
})

test('渠道：建渠道 → 绑定出口 → 定价 → 报价', async () => {
  const h = harness()
  try {
    const created = ok(
      await h.call('POST', '/api/panel/channels', {
        name: '主渠道',
        buckets: ['direct:1.2.3.4'],
        pricing: [{ models: ['claude-sonnet-4-5'], input_price: 3, output_price: 15 }],
      }),
      'create channel',
    )
    const channel = created.channel
    assert.equal(channel.name, '主渠道')

    const listed = ok(await h.call('GET', '/api/panel/channels'), 'list')
    assert.equal(listed.channels.length, 1)
    assert.deepEqual(listed.channels[0].buckets, ['direct:1.2.3.4'])

    const price = ok(
      await h.call('GET', `/api/panel/channels/price?model=claude-sonnet-4-5&channel_id=${channel.id}`),
      'price',
    )
    assert.deepEqual(price.price.models, ['claude-sonnet-4-5'])
    assert.equal(Number(price.price.input_price), 3)

    // A dated model id resolves through its alias — that is what the gateway
    // sees in real traffic.
    const dated = ok(
      await h.call('GET', `/api/panel/channels/price?model=claude-sonnet-4-5-20251001&channel_id=${channel.id}`),
      'dated price',
    )
    assert.equal(Number(dated.price.input_price), 3)

    // An unpriced model is a null price, not a zero one: 0 would look free.
    const unpriced = ok(
      await h.call('GET', `/api/panel/channels/price?model=gpt-4o&channel_id=${channel.id}`),
      'unpriced model',
    )
    assert.equal(unpriced.price, null)
  } finally {
    h.cleanup()
  }
})

test('渠道监控：建规则 → 跑规则（可带探测）→ 事件 → 删除规则', async () => {
  const h = harness()
  try {
    const created = ok(
      await h.call('POST', '/api/panel/channel-monitor/rules', {
        name: '可用率告警',
        channel_id: null,
        metric: 'availability',
        comparator: 'lt',
        threshold: 0.9,
      }),
      'create rule',
    )
    assert.ok(created.rule.id)

    ok(await h.call('GET', '/api/panel/channel-monitor'), 'overview')

    const run = ok(await h.call('POST', '/api/panel/channel-monitor/run', { probe: true }), 'run')
    assert.ok(Array.isArray(run.fired))
    assert.equal(run.probe?.total, 0, 'probe ran through the proxy pool')

    ok(await h.call('GET', '/api/panel/channel-monitor/probes'), 'probes')

    ok(await h.call('DELETE', `/api/panel/channel-monitor/rules/${created.rule.id}`), 'delete rule')
    assert.equal(ok(await h.call('GET', '/api/panel/channel-monitor'), 'after delete').rules.length, 0)
  } finally {
    h.cleanup()
  }
})

test('充值：下单 → 订单列表 → 手动确认入账 → 幂等', async () => {
  const h = harness()
  try {
    // A fresh install has no payable channel, and checkout must refuse rather
    // than invent one — that refusal is part of the contract.
    const fresh = ok(await h.call('GET', '/api/panel/payments/config'), 'config')
    assert.deepEqual(fresh.usable_channels, [])
    const refused = await h.call('POST', '/api/panel/payments/checkout', { user_id: 'u-1', amount: 50 })
    assert.equal(refused.status, 400)
    assert.equal(refused.body.error.code, 'channel_unavailable')

    // Configure 易支付, then the whole path runs.
    const saved = ok(
      await h.call('PUT', '/api/panel/payments/config', {
        enabled: true,
        channels: { easypay: { enabled: true, pid: '1001', key: 'secret-key', gateway: 'https://pay.example.com' } },
      }),
      'save config',
    )
    assert.deepEqual(saved.usable_channels, ['easypay'])

    const order = ok(
      await h.call('POST', '/api/panel/payments/checkout', {
        user_id: 'u-1',
        amount: 50,
        channel: saved.usable_channels[0],
      }),
      'checkout',
    )
    assert.ok(order.pay_url, 'a redirect URL is what the checkout page needs')

    const paid = ok(await h.call('POST', `/api/panel/payments/orders/${order.order.order_no}/confirm`), 'confirm')
    assert.equal(paid.credited, 50)

    const twice = ok(
      await h.call('POST', `/api/panel/payments/orders/${order.order.order_no}/confirm`),
      'confirm again',
    )
    assert.equal(twice.alreadyPaid, true, 'a paid order cannot be credited twice')
    assert.equal(Number(getDb().prepare('SELECT balance FROM users WHERE id = ?').get('u-1').balance), 50)

    const orders = ok(await h.call('GET', '/api/panel/payments/orders'), 'orders')
    assert.equal(orders.orders.length, 1)
  } finally {
    h.cleanup()
  }
})

test('余额：手工调账写流水并改变余额', async () => {
  const h = harness()
  try {
    const credited = ok(
      await h.call('POST', '/api/panel/billing/adjust', { user_id: 'u-1', amount: 12.5, notes: '补偿' }),
      'credit',
    )
    assert.equal(credited.balance, 12.5)

    const debited = ok(
      await h.call('POST', '/api/panel/billing/adjust', { user_id: 'u-1', amount: -2.5, notes: '冲正' }),
      'debit',
    )
    assert.equal(debited.balance, 10)

    const ledger = ok(await h.call('GET', '/api/panel/billing/ledger'), 'ledger')
    assert.equal(ledger.entries.length, 2)
    assert.ok(ledger.totals)
  } finally {
    h.cleanup()
  }
})

test('运营大盘与审计日志都能出数', async () => {
  const h = harness()
  try {
    // Make one audited change so the log is not trivially empty.
    ok(await h.call('POST', '/api/panel/billing/adjust', { user_id: 'u-1', amount: 1 }), 'adjust')

    const ops = ok(await h.call('GET', '/api/panel/ops?days=7'), 'ops')
    assert.ok(ops.fleet || ops.users, `ops snapshot shape: ${Object.keys(ops).join(',')}`)

    const logs = ok(await h.call('GET', '/api/panel/audit-logs'), 'audit list')
    assert.ok(
      logs.entries.some((entry) => entry.action === 'balance.adjust'),
      logs.entries.map((e) => e.action).join(','),
    )
    assert.ok(logs.stats && typeof logs.stats === 'object')
  } finally {
    h.cleanup()
  }
})

test('除审计与定义外，普通用户拿不到运营面', async () => {
  const h = harness({ role: 'user' })
  try {
    // A tenant identity instead of the master key: same handler, lower role.
    const calls = [
      ['GET', '/api/panel/users'],
      ['GET', '/api/panel/redeem'],
      ['GET', '/api/panel/subscriptions'],
      ['GET', '/api/panel/audit-logs'],
      ['GET', '/api/panel/channel-monitor'],
      ['GET', '/api/panel/ops'],
      ['GET', '/api/panel/channels'],
      ['GET', '/api/panel/user-attributes'],
      ['GET', '/api/panel/payments/orders'],
      ['GET', '/api/panel/billing/ledger'],
      ['POST', '/api/panel/billing/adjust'],
    ]
    for (const [method, url] of calls) {
      const response = await h.call(method, url)
      // 403 from the route, or 404 when an earlier gate in the handler refuses:
      // both mean the operator surface is not reachable by a tenant.
      assert.ok([403, 404].includes(response.status), `${method} ${url} -> ${response.status}`)
    }
  } finally {
    h.cleanup()
  }
})

test('租户只看得到自己的钱包，运营能看到指定用户', async () => {
  const tenant = harness({ role: 'user' })
  // Same database, operator identity: the contrast is what proves scoping.
  const ops = harness({ role: 'admin', dir: tenant.dir })
  try {
    const mine = ok(await tenant.call('GET', '/api/panel/wallet'), 'tenant wallet')
    assert.equal(mine.user_id, 'u-1')
    assert.equal(mine.balance, 0)

    // Asking for somebody else's wallet as a tenant returns your own, not theirs.
    const snooped = ok(await tenant.call('GET', '/api/panel/wallet?user_id=u-2'), 'tenant snoop')
    assert.equal(snooped.user_id, 'u-1')
    assert.equal(snooped.balance, 0)

    const theirs = ok(await ops.call('GET', '/api/panel/wallet?user_id=u-2'), 'operator view')
    assert.equal(theirs.user_id, 'u-2')
    assert.equal(theirs.balance, 999, 'an operator may read any wallet')

    assert.deepEqual(ok(await tenant.call('GET', '/api/panel/payments/mine'), 'my orders').orders, [])

    // The one operator route a tenant may reach, and only for themselves.
    assert.equal(
      ok(await tenant.call('GET', '/api/panel/subscriptions/user/u-1'), 'my subscription').usage.active,
      false,
    )
    const notMine = await tenant.call('GET', '/api/panel/subscriptions/user/u-2')
    assert.equal(notMine.status, 403, "somebody else's allowance is not a tenant's business")
    assert.equal(
      ok(await ops.call('GET', '/api/panel/subscriptions/user/u-2'), 'operator reads u-2').usage.active,
      false,
    )
  } finally {
    tenant.cleanup()
  }
})

test('单用户详情列出名下所有 IP，并标出主/次与该 IP 上的活跃会话', async () => {
  const h = harness({ sticky: true })
  try {
    const repo = new EgressBindingsRepo(h.db)
    // 原生出口：最早绑定的那个（模拟首次分配）。
    repo.addBucket({ userId: 'u-1', egressId: 'direct:1.1.1.1', reason: 'auto' })
    // 跨 IP 迁移追加的桶，并成为 primary —— 老 IP 不删。
    repo.setPrimaryBucket({ userId: 'u-1', egressId: 'proxy-new', reason: 'auto' })
    repo.upsertSlotBinding({ userId: 'u-1', slotId: 'slot-9', egressId: 'proxy-new', reason: 'auto' })
    // 两个对话，一个在新 IP，一个还钉在老 IP 上。
    h.stickyRouter.bind('k1', { accountId: 'a1', vmId: 'slot-9', userId: 'u-1', egressId: 'proxy-new' })
    h.stickyRouter.bind('k2', { accountId: 'a2', vmId: 'slot-3', userId: 'u-1', egressId: 'direct:1.1.1.1' })

    const detail = ok(await h.call('GET', '/api/panel/egress-bindings/u-1'), 'detail')
    // primary 镜像与桶集合必须一致：这是"他下一秒从哪出去"。
    assert.equal(detail.egress.egress_id, 'proxy-new')
    assert.deepEqual(
      detail.buckets.map((bucket) => bucket.egress_id),
      ['proxy-new', 'direct:1.1.1.1'],
      'primary first',
    )
    const byId = new Map(detail.buckets.map((bucket) => [bucket.egress_id, bucket]))
    assert.equal(byId.get('proxy-new').is_primary, true)
    assert.equal(byId.get('direct:1.1.1.1').is_primary, false)
    // 会话是"他此刻正在用哪个 IP"，跟 primary 不是一回事。
    assert.equal(byId.get('proxy-new').sessions, 1)
    assert.equal(byId.get('direct:1.1.1.1').sessions, 1)
  } finally {
    h.cleanup()
  }
})
