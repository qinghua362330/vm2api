import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { EgressBindingsRepo } from '../../src/lib/db/repos/egress-bindings-repo.mjs'
import { assignUserEgress, resolveUserDispatch, resolveUserSlot } from '../../src/lib/pool/egress-binding.mjs'

/**
 * Priority contract: a conversation keeps its credential, the user's bucket set
 * bounds what it may use, and the generic pool pick is last.
 *
 *   1. session binding   — one conversation, one credential
 *   2. bucket preference — where a NEW conversation starts
 *   3. pool pick / failover
 *
 * A session pin that falls outside the user's buckets is stale and is dropped,
 * so a conversation can never escape the buckets it was granted.
 */

test('a conversation keeps its slot even when the user prefers another bucket', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = scheduler(root, { stickyRouter: stickyRouterFor({ vmId: 'vm-02', accountId: 'account-2' }) })
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'conv-1',
    preferVmId: 'vm-01',
    allowedEgressIds: ['px-a', 'px-b'],
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-02', 'the running conversation must not switch credential')
  assert.equal(selected.selectionReason, 'sticky')
  selected.release()
})

test('a session pin outside the user buckets is dropped, not honoured', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let unbound = 0
  const pool = scheduler(root, {
    stickyRouter: {
      resolve: () => ({ vmId: 'vm-03', accountId: 'account-3' }),
      bind: () => {},
      unbind: () => {
        unbound++
      },
    },
  })
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'conv-1',
    preferVmId: 'vm-01',
    // the admin moved this user into a different bucket; vm-03 (px-b) is no
    // longer theirs, so the pin to it must not be honoured
    allowedEgressIds: ['px-a'],
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-01', 'falls back inside the granted buckets')
  assert.equal(unbound, 1, 'the stale pin is cleared')
  selected.release()
})

test('without a session pin a new conversation starts in the preferred bucket', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = scheduler(root)
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'conv-new',
    preferVmId: 'vm-01',
    allowedEgressIds: ['px-a', 'px-b'],
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-01')
  assert.equal(selected.selectionReason, 'user-binding')
  selected.release()
})

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-user-binding-'))
  const vms = path.join(root, 'vms')
  fs.mkdirSync(vms, { recursive: true })
  const write = (id, accountId, proxyId) => {
    fs.writeFileSync(
      path.join(vms, `${id}.json`),
      JSON.stringify({
        id,
        name: id,
        status: 'running',
        schedulable: true,
        proxy_cli_enabled: true,
        proxy: { id: proxyId, url: `socks5h://127.0.0.1:1080` },
        runtime: { worker_socket: path.join(vms, id, 'run', 'worker.sock') },
        policy: { maxConcurrency: 2, concurrencyOverride: true, weight: 1, priority: 0 },
        claude: {
          account_uuid: accountId,
          account_tier: 'max',
          access_token: `access-${accountId}`,
          refresh_token: `refresh-${accountId}`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    )
  }
  write('vm-01', 'account-1', 'px-a')
  write('vm-02', 'account-2', 'px-b')
  write('vm-03', 'account-3', 'px-b')
  fs.writeFileSync(path.join(vms, 'active.json'), JSON.stringify({ active_vm: 'vm-01' }))
  return root
}

class RuntimeRepo {
  states = new Map()
  get(id) {
    return this.states.get(id) || null
  }
  clearExpired() {}
  upsert(state) {
    this.states.set(state.account_id, state)
    return state
  }
  clearGrantRevokeCooldown() {
    return false
  }
  markCooldown(id, update) {
    const state = this.states.get(id) || { account_id: id, model_states: {} }
    state.cooldown_until = update.until
    state.cooldown_reason = update.reason
    state.status = update.status
    this.states.set(id, state)
    return state
  }
}

function scheduler(root, extras = {}) {
  return new PoolScheduler({
    projectRoot: root,
    runtimeRepo: extras.runtimeRepo || new RuntimeRepo(),
    stickyRouter: extras.stickyRouter || null,
    accountQuota: extras.accountQuota || { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { fallback_wait_timeout_ms: 5, sticky_wait_timeout_ms: 5 },
  })
}

/** Minimal sticky router: one bound key → { vmId, accountId }. */
function stickyRouterFor(binding) {
  return {
    resolve: () => binding,
    bind: () => {},
    unbind: () => {},
  }
}

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-user-binding-db-'))
  return { dir, repo: new EgressBindingsRepo(createDatabase({ dataDir: dir })) }
}

test('without a preference the sticky session still wins', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = scheduler(root, { stickyRouter: stickyRouterFor({ vmId: 'vm-02', accountId: 'account-2' }) })
  const selected = await pool.selectAndReserve({ model: 'claude-test', stickyKey: 'conv-1', allowWait: false })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-02')
  assert.equal(selected.selectionReason, 'sticky')
  selected.release()
})

test('a preference that is not a candidate falls through instead of failing', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = scheduler(root, { stickyRouter: stickyRouterFor({ vmId: 'vm-02', accountId: 'account-2' }) })
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'conv-1',
    preferVmId: 'vm-does-not-exist',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-02', 'unknown preference degrades to sticky')
  selected.release()
})

test('a busy bound slot is waited for, not swapped onto another egress', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = scheduler(root)
  // fill vm-01 to its concurrency limit; the wait reason is a waitable one
  const first = await pool.selectAndReserve({ model: 'claude-test', preferVmId: 'vm-01', allowWait: false })
  assert.equal(first.vmId, 'vm-01')
  await pool.selectAndReserve({ model: 'claude-test', preferVmId: 'vm-01', allowWait: false })

  const blocked = await pool.selectAndReserve({
    model: 'claude-test',
    preferVmId: 'vm-01',
    allowWait: true,
    deadline: Date.now() + 20,
  })
  assert.equal(blocked.ok, false, 'must wait for the bound slot rather than use another IP')
  first.release()
})

// ── assignment ──────────────────────────────────────────────────────────────

test('a new user is assigned the least-loaded egress, then resolved to its slot', () => {
  const { repo } = tmpRepo()
  /** A slot the shared gate accepts: schedulable, credentialed, proxy-bound. */
  const slot = (id, proxyId) => ({
    id,
    status: 'running',
    schedulable: true,
    platform: 'claude',
    family: 'claude',
    claude: { has_access: true, has_refresh: true },
    proxy_cli_enabled: true,
    proxy: { id: proxyId, host: '127.0.0.1', port: 1080, url: 'socks5h://127.0.0.1:1080' },
  })
  const vms = [slot('vm-01', 'px-a'), slot('vm-02', 'px-b'), slot('vm-03', 'px-b')]
  // px-a already carries a user, so px-b is the least loaded
  resolveUserSlot({ userId: 'other', vms, egressId: 'px-a' }, { repo })

  const assigned = assignUserEgress({ userId: 'u1', vms }, { repo })
  assert.equal(assigned.ok, true)
  assert.equal(assigned.egressId, 'px-b')
  assert.equal(assigned.created, true)

  const resolved = resolveUserDispatch({ userId: 'u1', vms }, { repo })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.egressId, 'px-b')
  assert.equal(resolved.assigned, false, 'the binding already existed after assignment')
})

test('with no proxy at all a new user lands on the shared host IP', () => {
  const { repo } = tmpRepo()
  const vms = [
    { id: 'vm-01', proxy: null, claude: { has_access: true } },
    { id: 'vm-02', proxy: null, claude: { has_access: true } },
  ]
  const assigned = assignUserEgress({ userId: 'u1', vms, hostIdentity: '203.0.113.9' }, { repo })
  assert.equal(assigned.ok, true)
  assert.equal(assigned.egressId, 'direct:203.0.113.9')
  assert.equal(assigned.direct, true)

  const resolved = resolveUserDispatch({ userId: 'u1', vms, hostIdentity: '203.0.113.9' }, { repo })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.egressId, 'direct:203.0.113.9')
})

test('an existing binding is never reassigned by the dispatch path', () => {
  const { repo } = tmpRepo()
  const vms = [
    { id: 'vm-01', proxy: { id: 'px-a' } },
    { id: 'vm-02', proxy: { id: 'px-b' } },
  ]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  const again = assignUserEgress({ userId: 'u1', vms }, { repo })
  assert.equal(again.ok, true)
  assert.equal(again.existing, true)
  assert.equal(again.egressId, 'px-a')
})

test('dispatch reports the failure but keeps the IP when nothing can serve', () => {
  const { repo } = tmpRepo()
  const vms = [{ id: 'vm-01', proxy: { id: 'px-a' }, schedulable: false, claude: {} }]
  const resolved = resolveUserDispatch({ userId: 'u1', vms }, { repo })
  assert.equal(resolved.ok, false)
  assert.equal(resolved.reason, 'no_egress_available')
})
