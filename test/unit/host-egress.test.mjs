import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { EgressBindingsRepo } from '../../src/lib/db/repos/egress-bindings-repo.mjs'
import {
  autoMigrateExhausted,
  directEgressId,
  egressSharingReport,
  pickLeastLoadedEgress,
  resolveUserSlot,
  slotEgressId,
} from '../../src/lib/pool/egress-binding.mjs'
import {
  detectPublicIp,
  hostEgressStatus,
  looksLikeIp,
  resetHostIdentityCache,
  resolveHostIdentity,
} from '../../src/lib/vm/host-identity.mjs'

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-host-egress-'))
  const db = createDatabase({ dataDir: dir })
  return { dir, db, repo: new EgressBindingsRepo(db) }
}

/** Proxy-less slot: its traffic leaves through the VPS IP. */
function directSlot(id, { cred = true, schedulable = true } = {}) {
  return {
    id,
    name: id,
    status: 'running',
    schedulable,
    platform: 'claude',
    family: 'claude',
    claude: cred ? { has_access: true, has_refresh: true } : {},
    proxy_cli_enabled: false,
    proxy: null,
  }
}

function proxySlot(id, proxyId) {
  return {
    id,
    name: id,
    status: 'running',
    schedulable: true,
    platform: 'claude',
    family: 'claude',
    claude: { has_access: true, has_refresh: true },
    proxy_cli_enabled: true,
    proxy: { id: proxyId, host: '127.0.0.1', port: 1080, url: 'socks5h://127.0.0.1:1080' },
  }
}

// ── host identity ───────────────────────────────────────────────────────────

test('host identity prefers explicit env, then hostname, and never a live lookup', () => {
  resetHostIdentityCache()
  assert.equal(resolveHostIdentity({ env: { VM2API_DIRECT_IDENTITY: '203.0.113.7' } }), '203.0.113.7')
  assert.equal(resolveHostIdentity({ env: { KIN_DIRECT_IDENTITY: 'legacy-id' } }), 'legacy-id')
  assert.equal(resolveHostIdentity({ env: {}, hostname: 'vps-01' }), 'vps-01')
  assert.equal(resolveHostIdentity({ env: {}, hostname: '' }), 'host')
  // module default is stable across calls
  assert.equal(resolveHostIdentity(), resolveHostIdentity())
})

test('looksLikeIp only accepts dotted quads', () => {
  assert.equal(looksLikeIp('203.0.113.7'), true)
  assert.equal(looksLikeIp('vps-01'), false)
  assert.equal(looksLikeIp(''), false)
})

test('detectPublicIp returns the first usable echo answer and never throws', async () => {
  const ok = await detectPublicIp({
    endpoints: ['https://a.test', 'https://b.test'],
    fetchImpl: async (url) =>
      url === 'https://a.test' ? { ok: false, text: async () => '' } : { ok: true, text: async () => '198.51.100.4\n' },
  })
  assert.deepEqual(ok, { ok: true, ip: '198.51.100.4', source: 'https://b.test' })

  const bad = await detectPublicIp({
    endpoints: ['https://a.test'],
    fetchImpl: async () => {
      throw new Error('network down')
    },
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'detect_failed')
})

test('hostEgressStatus lists the shared host egress and its proxy-less slots', () => {
  const vms = [directSlot('vm-1'), directSlot('vm-2'), proxySlot('vm-3', 'px-a')]
  const st = hostEgressStatus({ vms, hostIdentity: '203.0.113.7' })
  assert.equal(st.egress_id, 'direct:203.0.113.7')
  assert.equal(st.shared, true)
  assert.equal(st.available, true)
  assert.deepEqual(st.slots, ['vm-1', 'vm-2'], 'only proxy-less slots egress from the host')

  const none = hostEgressStatus({ vms: [proxySlot('vm-3', 'px-a')], hostIdentity: '203.0.113.7' })
  assert.equal(none.available, false)
  assert.deepEqual(none.slots, [])
})

// ── the fallback itself ─────────────────────────────────────────────────────

test('with no proxy in the pool every slot shares the host IP', () => {
  const { repo } = tmpRepo()
  const vms = [directSlot('vm-1'), directSlot('vm-2'), directSlot('vm-3')]
  const host = directEgressId('203.0.113.7')

  for (const vm of vms) assert.equal(slotEgressId(vm, { hostIdentity: '203.0.113.7' }), host)

  const a = resolveUserSlot({ userId: 'u1', vms, egressId: host, hostIdentity: '203.0.113.7' }, { repo })
  const b = resolveUserSlot({ userId: 'u2', vms, egressId: host, hostIdentity: '203.0.113.7' }, { repo })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.notEqual(a.slotId, b.slotId, 'users still spread across the shared IP slots')
  assert.equal(repo.getEgressBinding('u1').egress_id, host)
  assert.equal(repo.getEgressBinding('u2').egress_id, host)
})

test('the shared host IP is reported as shared, not as a violation', () => {
  const { repo } = tmpRepo()
  const vms = [directSlot('vm-1'), directSlot('vm-2'), directSlot('vm-3')]
  const host = directEgressId('203.0.113.7')
  resolveUserSlot({ userId: 'u1', vms, egressId: host, hostIdentity: '203.0.113.7' }, { repo })
  resolveUserSlot({ userId: 'u2', vms, egressId: host, hostIdentity: '203.0.113.7' }, { repo })

  const report = egressSharingReport({ vms, hostIdentity: '203.0.113.7' }, { repo })
  assert.equal(report.shared_egresses, 1)
  assert.equal(report.shared[0].egressId, host)
  assert.equal(report.shared[0].kind, 'direct')
  assert.equal(report.shared[0].slots_count, 3)
  assert.equal(report.shared[0].users, 2)
})

test('proxy egresses are exhausted before the host IP is offered', () => {
  const { repo } = tmpRepo()
  const vms = [proxySlot('vm-1', 'px-a'), proxySlot('vm-2', 'px-b'), directSlot('vm-9')]
  // px-a already carries two users, px-b none → px-b is the least loaded
  resolveUserSlot({ userId: 'ua1', vms, egressId: 'px-a' }, { repo })
  resolveUserSlot({ userId: 'ua2', vms, egressId: 'px-a' }, { repo })
  const picked = pickLeastLoadedEgress({ vms, hostIdentity: '203.0.113.7' }, { repo })
  assert.equal(picked.ok, true)
  assert.equal(picked.egressId, 'px-b', 'least-loaded proxy egress wins over the host IP')
  assert.notEqual(picked.egressId, directEgressId('203.0.113.7'))
})

test('a user on the shared host IP is not evicted by the sweep', () => {
  const { repo } = tmpRepo()
  const vms = [directSlot('vm-1'), directSlot('vm-2')]
  const host = directEgressId('203.0.113.7')
  resolveUserSlot({ userId: 'u1', vms, egressId: host, hostIdentity: '203.0.113.7' }, { repo })
  assert.equal(repo.getSlotBinding('u1').slot_id, 'vm-1', 'host-IP slots are usable without a proxy')

  // A proxy-less slot must not look "unusable" just because it has no proxy.
  const sweep = autoMigrateExhausted({ vms, hostIdentity: '203.0.113.7', dryRun: true }, { repo })
  assert.equal(sweep.results.length, 0)
})

test('a dead proxy egress lands on the shared host IP as the last resort', () => {
  const { repo } = tmpRepo()
  const vms = [proxySlot('vm-1', 'px-a'), directSlot('vm-9')]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  assert.equal(repo.getSlotBinding('u1').slot_id, 'vm-1')

  const after = [proxySlot('vm-1', 'px-a'), directSlot('vm-9')]
  after[0].claude = {}
  after[0].schedulable = false

  const res = resolveUserSlot({ userId: 'u1', vms: after, hostIdentity: '203.0.113.7' }, { repo })
  assert.equal(res.ok, true)
  assert.equal(res.scope, 'direct')
  assert.equal(res.egressId, 'direct:203.0.113.7')
  assert.equal(res.slotId, 'vm-9')
  assert.equal(repo.listMigrations({ userId: 'u1' })[0].reason, 'direct_fallback')
})

test('without a proxy-less slot the fallback cannot serve and says so', () => {
  const { repo } = tmpRepo()
  const vms = [proxySlot('vm-1', 'px-a')]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  const dead = [proxySlot('vm-1', 'px-a')]
  dead[0].claude = {}
  dead[0].schedulable = false

  const res = resolveUserSlot({ userId: 'u1', vms: dead, hostIdentity: '203.0.113.7' }, { repo })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'no_target')
  const st = hostEgressStatus({ vms: dead, hostIdentity: '203.0.113.7' })
  assert.equal(st.available, false, 'the panel must show that the fallback is unavailable')
})
