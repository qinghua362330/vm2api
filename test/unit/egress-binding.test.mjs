import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { EgressBindingsRepo } from '../../src/lib/db/repos/egress-bindings-repo.mjs'
import {
  directEgressId,
  egressSharingReport,
  ensureUserEgress,
  isDirectEgress,
  migrateUserWithinEgress,
  rebindUserEgress,
  releaseSlot,
  resolveUserSlot,
  checkUserSlotEgress,
  slotEgressId,
  slotIsUsable,
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
  assert.equal(res.migrated, false)
  assert.equal(repo.getEgressBinding('u1').egress_id, 'px-a')
  assert.equal(repo.getSlotBinding('u1').slot_id, 'vm-1')
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

test('credential death migrates the user to another slot on the SAME ip', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-a' })]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  assert.equal(repo.getSlotBinding('u1').slot_id, 'vm-1')

  // vm-1 loses its grant
  const after = [slot('vm-1', { proxyId: 'px-a', cred: false, schedulable: false }), slot('vm-2', { proxyId: 'px-a' })]
  const res = resolveUserSlot({ userId: 'u1', vms: after, reason: 'credential_dead' }, { repo })

  assert.equal(res.ok, true)
  assert.equal(res.migrated, true)
  assert.equal(res.slotId, 'vm-2')
  assert.equal(res.egressId, 'px-a', 'egress must not change on migration')
  assert.equal(repo.getEgressBinding('u1').egress_id, 'px-a')
  const binding = repo.getSlotBinding('u1')
  assert.equal(binding.slot_id, 'vm-2')
  assert.equal(binding.egress_id, 'px-a')
  assert.equal(binding.migrations, 1)
  assert.equal(binding.last_reason, 'credential_dead')

  const audit = repo.listMigrations({ userId: 'u1' })
  assert.equal(audit.length, 1)
  assert.equal(audit[0].reason, 'credential_dead')
  assert.equal(audit[0].from_slot, 'vm-1')
  assert.equal(audit[0].to_slot, 'vm-2')
})

test('quota exhaustion uses the same same-ip migration path', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-a' })]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  const res = migrateUserWithinEgress(
    { userId: 'u1', vms, reason: 'quota_exhausted' },
    { repo },
  )
  assert.equal(res.ok, true)
  assert.equal(res.slotId, 'vm-2')
  assert.equal(repo.getSlotBinding('u1').last_reason, 'quota_exhausted')
  assert.equal(repo.getEgressBinding('u1').egress_id, 'px-a')
})

test('migration never crosses egress: no target means the user waits', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-a' })]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })

  // both px-a slots die; a healthy px-b slot must NOT be used
  const after = [slot('vm-1', { proxyId: 'px-a', cred: false }), slot('vm-2', { proxyId: 'px-a', cred: false }), slot('vm-9', { proxyId: 'px-b' })]
  const res = resolveUserSlot({ userId: 'u1', vms: after, reason: 'credential_dead' }, { repo })

  assert.equal(res.ok, false)
  assert.equal(res.reason, 'no_usable_slot')
  assert.equal(repo.getEgressBinding('u1').egress_id, 'px-a', 'egress stays pinned')
  assert.equal(repo.getSlotBinding('u1').slot_id, 'vm-1', 'failed migration must not move the user')
  const audit = repo.listMigrations({ userId: 'u1' })
  assert.equal(audit.length, 1)
  assert.equal(audit[0].reason, 'no_target')
  assert.equal(audit[0].to_slot, null)
})

test('a user with no slot in their egress fails closed instead of drifting', () => {
  const { repo } = tmpRepo()
  ensureUserEgress({ userId: 'u1', egressId: 'px-a' }, { repo })
  const res = resolveUserSlot({ userId: 'u1', vms: [slot('vm-9', { proxyId: 'px-b' })] }, { repo })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'no_slot_in_egress')
  assert.equal(repo.getSlotBinding('u1'), null)
})

test('admin rebind is the only path that changes a pinned egress', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-b' })]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })

  // auto calls cannot move the egress
  const blocked = ensureUserEgress({ userId: 'u1', egressId: 'px-b' }, { repo })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'egress_locked')

  const res = rebindUserEgress({ userId: 'u1', egressId: 'px-b', vms, boundBy: 'admin' }, { repo })
  assert.equal(res.ok, true)
  assert.equal(res.from, 'px-a')
  assert.equal(res.slotId, 'vm-2')
  assert.equal(repo.getEgressBinding('u1').egress_id, 'px-b')
  assert.equal(repo.getEgressBinding('u1').reason, 'admin')
  assert.equal(repo.getSlotBinding('u1').slot_id, 'vm-2')
  const audit = repo.listMigrations({ userId: 'u1' })
  assert.equal(audit.some((m) => m.reason === 'admin'), true)
})

test('automatic migration refuses to cross egress even when asked', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-b' })]
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  const res = migrateUserWithinEgress({ userId: 'u1', vms, egressId: 'px-b' }, { repo })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'egress_mismatch')
  assert.equal(repo.getEgressBinding('u1').egress_id, 'px-a')
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
  assert.equal(report.shared[0].kind, 'proxy')
  assert.equal(report.shared[0].slots_count, 3)
  assert.equal(report.shared[0].users, 2)
  assert.deepEqual(report.shared[0].slots, ['vm-1', 'vm-2', 'vm-3'])
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
  assert.equal(check.expected, 'px-a')
  assert.equal(check.actual, 'px-z')
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

  const after = resolveUserSlot({ userId: 'u1', vms: [slot('vm-2', { proxyId: 'px-a' })] }, { repo })
  assert.equal(after.ok, true)
  assert.equal(after.slotId, 'vm-2')
  assert.equal(after.egressId, 'px-a')
})

test('the shared gate still governs who may receive a user', () => {
  const { repo } = tmpRepo()
  const vms = [slot('vm-1', { proxyId: 'px-a' }), slot('vm-2', { proxyId: 'px-a', proxyId2: null })]
  assert.equal(slotIsUsable(vms[0]), true)

  const paused = slot('vm-2', { proxyId: 'px-a', schedulable: false })
  assert.equal(slotIsUsable(paused), false)

  const noProxy = slot('vm-3', { proxyId: null })
  assert.equal(slotIsUsable(noProxy), false)

  const noCred = slot('vm-4', { proxyId: 'px-a', cred: false, schedulable: false })
  assert.equal(slotIsUsable(noCred), false)
})
