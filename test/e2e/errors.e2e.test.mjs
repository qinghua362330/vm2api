import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'
import { callAnthropicMessages, streamAnthropicMessages } from '../../src/lib/protocol/anthropic-messages.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('host-process Anthropic hop stays 501 (CRS is uid/mock)', async () => {
  const a = await callAnthropicMessages({ accessToken: 'sk-ant-oat01-FAKE' })
  const b = await streamAnthropicMessages({ accessToken: 'sk-ant-oat01-FAKE' })
  assert.equal(a.status, 501)
  assert.equal(b.status, 501)
})

test('VM without credentials is excluded and pool fails closed', async () => {
  const gw = await startGateway({ oauth: false })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(r.status, 503, r.text)
    const blob = JSON.stringify(r.json)
    // 没有**可用**的 Claude 槽 ≠ 号池在排队：这里回"稍后再试"会让客户端一直重试一条
    // 永远不可能成功的路。措辞变了，但两条纪律没变：失败要 fail closed、不能把内部
    // 错误码漏给客户端。
    assert.equal(r.json?.error?.code, 'no_claude_slot', r.text)
    assert.match(blob, /没有可用的 Claude 槽/)
    assert.match(blob, /\/v1\/responses/)
    assert.doesNotMatch(blob, /eligible|no ready api|account_pool_exhausted/i)
  } finally {
    await gw.stop()
  }
})

test('unknown model is rejected without hop', async () => {
  const gw = await startGateway()
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: { model: 'gpt-4o', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.ok(r.status >= 400, r.text)
    assert.match(JSON.stringify(r.json), /model/i)
  } finally {
    await gw.stop()
  }
})

test('legacy CLI selector header is ignored — Go worker still serves', async () => {
  const gw = await startGateway({ scenario: 'hang', timeoutMs: 800 })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli' },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(r.status, 200, r.text)
  } finally {
    await gw.stop()
  }
})

test('single-account rate limit is returned after bounded pool exhaustion', async () => {
  const gw = await startGateway({ scenario: 'rate_limit' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(r.status, 429, r.text)
    assert.match(JSON.stringify(r.json), /rate.limit|quota/i)
    const q = await api(gw, 'GET', '/admin/quota')
    assert.equal(q.status, 200, q.text)
    assert.ok(q.json)
  } finally {
    await gw.stop()
  }
})
