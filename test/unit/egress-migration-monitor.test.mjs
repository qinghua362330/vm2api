import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { EgressBindingsRepo } from '../../src/lib/db/repos/egress-bindings-repo.mjs'
import { resolveUserSlot } from '../../src/lib/pool/egress-binding.mjs'
import {
  DEFAULT_EGRESS_MIGRATION,
  createEgressMigrationMonitor,
  normalizeEgressMigrationConfig,
} from '../../src/lib/pool/egress-migration-monitor.mjs'

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-egress-monitor-'))
  return { dir, repo: new EgressBindingsRepo(createDatabase({ dataDir: dir })) }
}

function slot(id, proxyId, { cred = true, schedulable = true } = {}) {
  return {
    id,
    name: id,
    status: 'running',
    schedulable,
    platform: 'claude',
    family: 'claude',
    claude: cred ? { has_access: true, has_refresh: true } : {},
    proxy_cli_enabled: true,
    proxy: { id: proxyId, host: '127.0.0.1', port: 1080, url: 'socks5h://127.0.0.1:1080' },
  }
}

/** A projectRoot whose listVms() returns exactly these slots. */
function project(vms) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-egress-monitor-proj-'))
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  for (const vm of vms) fs.writeFileSync(path.join(dir, `${vm.id}.json`), JSON.stringify(vm))
  fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({ active_vm: vms[0]?.id || null }))
  return root
}

test('the sweep is off unless an operator turns it on', () => {
  assert.equal(DEFAULT_EGRESS_MIGRATION.enabled, false)
  assert.equal(normalizeEgressMigrationConfig({}).enabled, false)
  assert.equal(normalizeEgressMigrationConfig({ enabled: true }).enabled, true)

  const { repo } = tmpRepo()
  const monitor = createEgressMigrationMonitor({ projectRoot: null, repo })
  assert.deepEqual(monitor.start(), { started: false, reason: 'disabled' })
  monitor.stop()
})

test('config clamps the interval and defaults run_on_start on', () => {
  const one = normalizeEgressMigrationConfig({ enabled: true, interval_sec: 1 })
  assert.equal(one.interval_sec, 5, 'never faster than 5s')
  const big = normalizeEgressMigrationConfig({ enabled: true, interval_sec: 99999 })
  assert.equal(big.interval_sec, 3600)
  assert.equal(normalizeEgressMigrationConfig({ enabled: true }).run_on_start, true)
  assert.equal(normalizeEgressMigrationConfig({ enabled: true, run_on_start: false }).run_on_start, false)
  assert.equal(normalizeEgressMigrationConfig({}).dry_run, false)
})

test('an unexhausted fleet is left alone', async () => {
  const vms = [slot('vm-01', 'px-a'), slot('vm-02', 'px-a')]
  const root = project(vms)
  const { repo, dir } = tmpRepo()
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })

  const monitor = createEgressMigrationMonitor({ projectRoot: root, repo })
  const run = await monitor.runOnce()
  assert.equal(run.moved, 0)
  assert.equal(run.failed, 0)
  assert.equal(repo.getSlotBinding('u1').slot_id, 'vm-01', 'nothing moved')

  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the sweep moves a user off a slot whose window is spent', async () => {
  const vms = [slot('vm-01', 'px-a'), slot('vm-02', 'px-a')]
  const root = project(vms)
  const { repo, dir } = tmpRepo()
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })
  assert.equal(repo.getSlotBinding('u1').slot_id, 'vm-01')

  const accountQuota = {
    canAccept: (accountId) => (accountId === 'vm-01' ? { ok: false, reason: 'quota_5h_cli', detail: { window: '5h' } } : { ok: true }),
  }
  const monitor = createEgressMigrationMonitor({ projectRoot: root, accountQuota, repo })
  const run = await monitor.runOnce()

  assert.equal(run.moved, 1)
  assert.equal(repo.getSlotBinding('u1').slot_id, 'vm-02')
  assert.equal(repo.getSlotBinding('u1').last_reason, 'quota_exhausted')
  assert.equal(repo.getEgressBinding('u1').egress_id, 'px-a', 'same IP')
  assert.equal(run.results[0].reason, 'quota_exhausted')

  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('dry run reports without moving anyone', async () => {
  const vms = [slot('vm-01', 'px-a'), slot('vm-02', 'px-a')]
  const root = project(vms)
  const { repo, dir } = tmpRepo()
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })

  const accountQuota = { canAccept: () => ({ ok: false, reason: 'quota_7d_safety' }) }
  const monitor = createEgressMigrationMonitor({
    projectRoot: root,
    accountQuota,
    repo,
    getConfig: () => ({ enabled: true, dry_run: true }),
  })
  const run = await monitor.runOnce()
  assert.equal(run.dry_run, true)
  assert.equal(run.moved, 0)
  assert.equal(run.results.length, 1)
  assert.equal(run.results[0].dry_run, true)
  assert.equal(repo.getSlotBinding('u1').slot_id, 'vm-01', 'dry run wrote nothing')

  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a cooldown parks a slot without ending the binding', async () => {
  const vms = [slot('vm-01', 'px-a'), slot('vm-02', 'px-a')]
  const root = project(vms)
  const { repo, dir } = tmpRepo()
  resolveUserSlot({ userId: 'u1', vms, egressId: 'px-a' }, { repo })

  const runtimeRepo = {
    get: (id) => (id === 'vm-01' ? { status: 'cooldown', cooldown_until: Date.now() + 60_000, cooldown_reason: 'rate_limited' } : null),
  }
  const monitor = createEgressMigrationMonitor({ projectRoot: root, runtimeRepo, repo })
  const run = await monitor.runOnce()
  assert.equal(run.moved, 1)
  assert.equal(run.results[0].reason, 'cooldown')
  assert.equal(repo.getSlotBinding('u1').slot_id, 'vm-02')
  assert.equal(repo.getEgressBinding('u1').egress_id, 'px-a')

  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('start/stop keeps a single timer and the snapshot records the last run', async () => {
  const vms = [slot('vm-01', 'px-a')]
  const root = project(vms)
  const { repo, dir } = tmpRepo()
  const monitor = createEgressMigrationMonitor({
    projectRoot: root,
    repo,
    getConfig: () => ({ enabled: true, interval_sec: 300, run_on_start: false }),
  })
  assert.equal(monitor.getSnapshot(), null)
  const started = monitor.start()
  assert.equal(started.started, true)
  monitor.start()
  monitor.stop()
  assert.equal(monitor.getConfig().interval_sec, 300)
  await monitor.runOnce()
  assert.ok(monitor.getSnapshot()?.at)

  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(dir, { recursive: true, force: true })
})
