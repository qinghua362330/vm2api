import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { EgressBindingsRepo } from '../../src/lib/db/repos/egress-bindings-repo.mjs'
import {
  autoMigrateExhausted,
  checkUserSlotEgress,
  directEgressId,
  egressSharingReport,
  ensureUserEgress,
  isDirectEgress,
  migrateUser,
  migrateUserWithinEgress,
  pickLeastLoadedEgress,
  rebindUserEgress,
  releaseSlot,
  resolveUserSlot,
  slotEgressId,
  slotIsUsable,
  slotVerdict,
} from '../../src/lib/pool/egress-binding.mjs'

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-egress-binding-'))
  const db = createDatabase({ dataDir: dir })
  return { dir, db, repo: new EgressBindingsRepo(db) }
}

/** A slot the shared gate accepts: claude credential + a bound proxy. */
function slot(id, { proxyId = 'px-a', schedulable = true, cred = true, status = 'running' } = {}) {
  return {
    id,
    name: id,
    status,
    schedulable,
    platform: 'claude',
    family: 'claude',
    claude: cred ? { has_access: true, has_refresh: true } : {},
    proxy_cli_enabled: true,
    proxy: proxyId ? { id: proxyId, host: '127.0.0.1', port: 1080, url: 'socks5h://127.0.0.1:1080' } : null,
  }
}

// ── identity ────────────────────────────────────────────────────────────────

test('slotEgressId prefers the bound proxy, falls back to the host identity', () => {
  assert.equal(slotEgressId(slot('vm-1', { proxyId: 'px-a' })), 'px-a')
  assert.equal(slotEgressId(slot('vm-2', { proxyId: null }), { hostIdentity: '1.2.3.4' }), 'direct:1.2.3.4')
  assert.equal(slotEgressId({ id: 'vm-3', proxy_id: 'px-b' }), 'px-b')
  assert.equal(isDirectEgress(directEgressId('1.2.3.4')), true)
  assert.equal(isDirectEgress('px-a'), false)
})

test('first resolve pins the user to an egress and a slot inside it', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-b' })]
  const res = resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  assert.equal(res.ok, true)
  assert.equal(res.egressId, 'px-a')
  assert.equal(res.slotId, 'vm-1')
  assert.equal(repo.getEgressBinding('u1').egress_id, 'px-a')
  assert.equal(repo.getSlotBinding('u1').migrations, 0)
})

test('a healthy bound slot is reused without churn', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-a' })]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  const again = resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  assert.equal(again.ok, true)
  assert.equal(again.migrated, false)
  assert.equal(repo.getSlotBinding('u1').migrations, 0)
  assert.equal(repo.listMigrations({ userId: 'u1' }).length, 0)
})

// ── step 1: same egress ─────────────────────────────────────────────────────

test('credential death migrates the user to another slot on the SAME ip first', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-a' })]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  assert.equal(repo.getSlotBinding('u1').slot_id, 'vm-1')

  const after = [slot('vm-1', { proxyId: 'px-a', cred: false, schedulable: false }), slot('vm-2', { proxyId: 'px-a' })]
  const res = resolveUserSlot({ userId: 'u1', vms: after, reason: 'credential_dead' }, { repo })

  assert.equal(res.ok, true)
  assert.equal(res.scope, 'same_egress')
  assert.equal(res.slotId, 'vm-2')
  assert.equal(res.egressId, 'px-a', 'same-IP migration must not change the egress')
  assert.equal(repo.getEgressBinding('u1').egress_id, 'px-a')
  assert.equal(repo.getSlotBinding('u1').migrations, 1)
  assert.equal(repo.getSlotBinding('u1').last_reason, 'credential_dead')
  const audit = repo.listMigrations({ userId: 'u1' })
  assert.equal(audit[0].reason, 'credential_dead')
  assert.equal(audit[0].from_slot, 'vm-1')
  assert.equal(audit[0].to_slot, 'vm-2')
})

test('quota exhaustion uses the same same-ip migration path', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-a' })]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  const res = migrateUser({ userId: 'u1', vms, reason: 'quota_exhausted' }, { repo })
  assert.equal(res.ok, true)
  assert.equal(res.scope, 'same_egress')
  assert.equal(res.slotId, 'vm-2')
  assert.equal(repo.getSlotBinding('u1').last_reason, 'quota_exhausted')
  assert.equal(repo.getEgressBinding('u1').egress_id, 'px-a')
})

// ── step 2: failover to the least-loaded other egress ───────────────────────

test('a dead whole egress fails over to the least-loaded other ip', () => {
  const { repo } = tmpRepo()
  const vms = [
    slot('vm-1', { proxyId: 'px-a' }),
    slot('vm-2', { proxyId: 'px-b' }),
    slot('vm-3', { proxyId: 'px-c' }),
    slot('vm-4', { proxyId: 'px-c' }),
  ]
  // px-b already carries more users than px-c
  resolveUserSlot({ userId: 'ub1', vms, egressId: 'px-b' }, { repo })
  resolveUserSlot({ userId: 'ub2', vms, egressId: 'px-b' }, { repo })
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  assert.equal(repo.getEgressBinding('u1').egress_id, 'px-a')

  // the whole px-a egress dies
  const after = [slot('vm-1', { proxyId: 'px-a', cred: false, schedulable: false }), ...vms.slice(1)]
  const res = resolveUserSlot({ userId: 'u1', vms: after }, { repo })

  assert.equal(res.ok, true)
  assert.equal(res.scope, 'failover_egress')
  assert.equal(res.fromEgressId, 'px-a')
  assert.equal(res.egressId, 'px-c', 'must pick the egress with the fewest users')
  assert.equal(res.slotId, 'vm-3')
  assert.equal(repo.getEgressBinding('u1').egress_id, 'px-c')
  assert.equal(repo.getSlotBinding('u1').egress_id, 'px-c')

  const audit = repo.listMigrations({ userId: 'u1' })
  assert.equal(audit[0].reason, 'egress_failover')
  assert.match(audit[0].detail, /users=0/)
})

test('failover skips egresses that have no usable slot left', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-b' })]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  const after = [
    slot('vm-1', { proxyId: 'px-a', cred: false, schedulable: false }),
    slot('vm-2', { proxyId: 'px-b', cred: false, schedulable: false }),
  ]
  const other = pickLeastLoadedEgress({ vms: after, excludeEgress: ['px-a'] }, { repo })
  assert.equal(other.ok, false)
})

// ── step 3: the host's own ip ───────────────────────────────────────────────

test('when no egress has capacity the user lands on the host ip', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-d', { proxyId: null })]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })

  const after = [slot('vm-1', { proxyId: 'px-a', cred: false, schedulable: false }), slot('vm-d', { proxyId: null })]
  const res = resolveUserSlot({ userId: 'u1', vms: after, hostIdentity: '203.0.113.9' }, { repo })

  assert.equal(res.ok, true)
  assert.equal(res.scope, 'direct')
  assert.equal(res.egressId, 'direct:203.0.113.9')
  assert.equal(res.slotId, 'vm-d')
  assert.equal(repo.listMigrations({ userId: 'u1' })[0].reason, 'direct_fallback')
})

test('failover can be disabled so a user waits rather than gaining a second ip', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-9', { proxyId: 'px-b' })]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })

  const after = [slot('vm-1', { proxyId: 'px-a', cred: false, schedulable: false }), slot('vm-9', { proxyId: 'px-b' })]
  const res = resolveUserSlot({ userId: 'u1', vms: after, allowFailover: false, allowDirect: false }, { repo })

  assert.equal(res.ok, false)
  assert.equal(repo.getEgressBinding('u1').egress_id, 'px-a', 'egress stays pinned')
  assert.equal(repo.getSlotBinding('u1').slot_id, 'vm-1', 'failed migration must not move the user')
  assert.equal(repo.listMigrations({ userId: 'u1' })[0].reason, 'no_target')
})

test('the same-ip-only helper never crosses egress', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-b' })]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  const res = migrateUserWithinEgress({ userId: 'u1', vms, egressId: 'px-b' }, { repo })
  assert.equal(res.ok, false, 'only the same egress may be considered')
  assert.equal(repo.getEgressBinding('u1').egress_id, 'px-a')
  assert.equal(repo.getSlotBinding('u1').slot_id, 'vm-1')
})

test('nothing anywhere records a no_target audit row', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' })]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  const after = [slot('vm-1', { proxyId: 'px-a', cred: false, schedulable: false })]
  const res = resolveUserSlot({ userId: 'u1', vms: after, hostIdentity: '' }, { repo })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'no_target')
  assert.equal(repo.listMigrations({ userId: 'u1' })[0].reason, 'no_target')
})

// ── gates: quota + cooldown ─────────────────────────────────────────────────

test('a spent quota window moves the user, a concurrency limit does not', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-a' })]

  const quotaSpent = {
    quota: (slotId) => (slotId === 'vm-1' ? { ok: false, reason: 'quota_5h_cli', window: '5h' } : { ok: true }),
  }
  assert.equal(slotVerdict(vms[0], quotaSpent).ok, false)
  assert.equal(slotVerdict(vms[0], quotaSpent).reason, 'quota_5h_cli')

  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  const res = resolveUserSlot({ userId: 'u1', vms, gates: quotaSpent }, { repo })
  assert.equal(res.ok, true)
  assert.equal(res.slotId, 'vm-2')
  assert.equal(res.scope, 'same_egress')
  assert.equal(repo.getSlotBinding('u1').last_reason, 'quota_exhausted')

  // concurrency is transient — the user waits, the binding is untouched
  const { repo: repo2 } = tmpRepo()
  const busy = { quota: (slotId) => (slotId === 'vm-1' ? { ok: false, reason: 'concurrency_limit' } : { ok: true }) }
  resolveUserSlot({ userId: 'u2', vms, egressId: 'px-a' }, { repo: repo2 })
  const held = resolveUserSlot({ userId: 'u2', vms, gates: busy }, { repo: repo2 })
  assert.equal(held.ok, false)
  assert.equal(held.transient, true)
  assert.equal(held.retry, true)
  assert.equal(repo2.getSlotBinding('u2').slot_id, 'vm-1', 'no migration for a transient limit')
  assert.equal(repo2.listMigrations({ userId: 'u2' }).length, 0)
})

test('a cooling slot is skipped and the user moves inside the same ip', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-a' })]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })

  const cooling = {
    cooldown: (slotId) => (slotId === 'vm-1' ? { cooling: true, until: Date.now() + 60_000, reason: 'rate_limited' } : { cooling: false }),
  }
  const res = resolveUserSlot({ userId: 'u1', vms, gates: cooling }, { repo })
  assert.equal(res.ok, true)
  assert.equal(res.slotId, 'vm-2')
  assert.equal(res.egressId, 'px-a')
})

test('autoMigrateExhausted sweeps only the slots that cannot serve', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-a' }), slot('vm-3', { proxyId: 'px-b' })]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo }) // vm-1
  resolveUserSlot({ userId: 'u2', vms, egressId: 'px-b' }, { repo }) // vm-3

  const gates = {
    quota: (slotId) => (slotId === 'vm-1' ? { ok: false, reason: 'quota_7d_safety', window: '7d' } : { ok: true }),
  }
  const sweep = autoMigrateExhausted({ vms, gates }, { repo })
  assert.equal(sweep.moved, 1)
  assert.equal(repo.getSlotBinding('u1').slot_id, 'vm-2')
  assert.equal(repo.getSlotBinding('u1').last_reason, 'quota_exhausted')
  assert.equal(repo.getSlotBinding('u2').slot_id, 'vm-3', 'untouched user keeps their slot')

  // dry run reports without moving
  const dry = autoMigrateExhausted({ vms, gates, dryRun: true }, { repo })
  assert.equal(dry.moved, 0)
  assert.equal(dry.results.length, 0, 'vm-1 already drained, nothing left to report')
})

// ── admin + invariants ──────────────────────────────────────────────────────

test('admin rebind is an explicit, audited ip change', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-b' })]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })

  const blocked = ensureUserEgress({ userId: 'u1', egressId: 'px-b' }, { repo })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'egress_locked')

  const res = rebindUserEgress({ userId: 'u1', egressId: 'px-b', vms, boundBy: 'admin' }, { repo })
  assert.equal(res.ok, true)
  assert.equal(res.from, 'px-a')
  assert.equal(res.slotId, 'vm-2')
  assert.equal(repo.getEgressBinding('u1').reason, 'admin')
  assert.equal(repo.listMigrations({ userId: 'u1' }).some((m) => m.reason === 'admin'), true)
})

test('sharing report exposes egresses carrying several slots', () => {
  const { repo } = tmpRepo()
  const vms = [
    slot('vm-1', { proxyId: 'px-a' }),
    slot('vm-2', { proxyId: 'px-a' }),
    slot('vm-3', { proxyId: 'px-a' }),
    slot('vm-4', { proxyId: 'px-b' }),
  ]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  resolveUserSlot({ userId: 'u2', vms, egressId: 'px-a' }, { repo })

  const report = egressSharingReport({ vms }, { repo })
  assert.equal(report.total_egresses, 2)
  assert.equal(report.shared_egresses, 1)
  assert.equal(report.shared[0].egressId, 'px-a')
  assert.equal(report.shared[0].slots_count, 3)
  assert.equal(report.shared[0].users, 2)
})

test('invariant check flags a slot that drifted to another egress', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-a' })]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  assert.equal(checkUserSlotEgress({ userId: 'u1', vms }, { repo }).ok, true)

  const drifted = [slot('vm-1', { proxyId: 'px-z' }), slot('vm-2', { proxyId: 'px-a' })]
  const check = checkUserSlotEgress({ userId: 'u1', vms: drifted }, { repo })
  assert.equal(check.ok, false)
  assert.equal(check.reason, 'egress_drift')
})

test('users spread across an egress instead of piling on one slot', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-a' })]
  assert.equal(resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo }).slotId, 'vm-1')
  assert.equal(resolveUserSlot({ userId: 'u2', vms, egressId: 'px-a' }, { repo }).slotId, 'vm-2')
  assert.equal(resolveUserSlot({ userId: 'u3', vms, egressId: 'px-a' }, { repo }).slotId, 'vm-1')
})

test('a dead slot releases its users but keeps their egress', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-a' })]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  resolveUserSlot({ userId: 'u2', vms, egressId: 'px-a' }, { repo })

  const res = releaseSlot({ slotId: 'vm-1' }, { repo })
  assert.equal(res.released, 1)
  assert.deepEqual(res.users, ['u1'])
  assert.equal(repo.getSlotBinding('u1'), null)
  assert.equal(repo.getEgressBinding('u1').egress_id, 'px-a', 'egress ownership survives')
})

test('the shared gate still governs who may receive a user', () => {
  assert.equal(slotIsUsable(slot('vm-1', { proxyId: 'px-a' })), true)
  assert.equal(slotIsUsable(slot('vm-2', { proxyId: 'px-a', schedulable: false })), false)
  assert.equal(slotIsUsable(slot('vm-3', { proxyId: null })), false)
  assert.equal(slotIsUsable(slot('vm-4', { proxyId: 'px-a', cred: false, schedulable: false })), false)
})
