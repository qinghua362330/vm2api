import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startGateway } from '../harness.mjs'

/**
 * 子路径部署（反代把 /vm2api/ 转到本机 8787）。
 *
 * 单测只能证明剥离函数对；真正会坏的是"剥了但没告诉下游"—— 面板路由自己从 url 里
 * 取 pathname，剥完不写回去就一路 404。这条用真服务把控制台、资源与面板接口都走一遍。
 */
test('PUBLIC_BASE_PATH：带前缀的控制台与面板接口都可达', async () => {
  const gw = await startGateway({ env: { PUBLIC_BASE_PATH: '/vm2api' } })
  try {
    // e2e 的临时工程里没有构建产物；放一份最小的 index.html，才能验证前缀下的静态服务。
    const dist = path.join(gw.project, 'web', 'dist')
    fs.mkdirSync(dist, { recursive: true })
    fs.writeFileSync(path.join(dist, 'index.html'), '<html><body><div id="root"></div></body></html>')
    const health = await fetch(`${gw.baseUrl}/vm2api/health`)
    assert.equal(health.status, 200)
    const body = await health.json()
    assert.equal(body.base_path, '/vm2api')
    assert.equal(body.status, 'ok')

    const consolePage = await fetch(`${gw.baseUrl}/vm2api/console`)
    assert.equal(consolePage.status, 200, '带前缀要能拿到控制台')
    assert.match(await consolePage.text(), /<div id="root"|<html/i)

    const login = await fetch(`${gw.baseUrl}/vm2api/api/panel/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'testpass' }),
    })
    assert.equal(login.status, 200, '面板登录也要能带前缀')
    const session = await login.json()
    assert.equal(session.ok, true)

    const cookie = login.headers.get('set-cookie') || ''
    const me = await fetch(`${gw.baseUrl}/vm2api/api/panel/me`, { headers: { cookie } })
    assert.equal(me.status, 200, '带会话的面板接口同样走前缀')

    // 不带前缀仍然可达：鉴权不在这层，少一层隐式 404 更好排障
    const bare = await fetch(`${gw.baseUrl}/health`)
    assert.equal(bare.status, 200)
    assert.equal((await bare.json()).base_path, '/vm2api')
  } finally {
    await gw.stop()
  }
})
