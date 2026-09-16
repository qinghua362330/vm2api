import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api, readTrace } from '../harness.mjs'
import { CRS_OFFICIAL_SYSTEM } from '../../src/lib/identity/crs-persona.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('default POST /v1/messages uses Go worker pool, not CLI', async () => {
  const gw = await startGateway({ mockText: 'pong' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] },
    })
    assert.equal(r.status, 200, r.text)
    const tr = readTrace(gw)
    assert.equal(tr.via, 'go-worker')
    assert.ok(!tr.argv)
    // routing.json defaults to persona_preset=official_full, whose layout is
    // billing + identity + agent + environment (docs/PROTOCOL.md). The older
    // 3-block `rewrite` layout is no longer the shipped default.
    assert.equal(tr.system.length, 4)
    assert.equal(tr.system[1].text, CRS_OFFICIAL_SYSTEM)
  } finally {
    await gw.stop()
  }
})

test('CRS identity: VM device, unofficial session minted, OAuth account', async () => {
  const gw = await startGateway()
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: {
        model: MODEL,
        max_tokens: 8,
        metadata: { user_id: JSON.stringify({ device_id: 'caller-dev', account_uuid: '', session_id: 'caller-sess' }) },
        messages: [{ role: 'user', content: 'hi' }],
      },
    })
    assert.equal(r.status, 200, r.text)
    const tr = readTrace(gw)
    const uid = JSON.parse(tr.body.metadata.user_id)
    assert.notEqual(uid.device_id, 'caller-dev')
    assert.equal(uid.account_uuid, 'acct-seed')
    assert.notEqual(uid.session_id, 'caller-sess')
    assert.match(uid.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  } finally {
    await gw.stop()
  }
})

test('explicit x-kin-forward: cli is ignored by Go-only inference path', async () => {
  const gw = await startGateway({ mockText: 'pong' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli' },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(r.status, 200, r.text)
    const tr = readTrace(gw)
    assert.equal(tr.via, 'go-worker')
    assert.equal(tr.argv, undefined)
  } finally {
    await gw.stop()
  }
})
