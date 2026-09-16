/**
 * Egress migration monitor — runs the binding sweep on a timer.
 *
 * A slot can stop serving without anything in the request path noticing: its 5h
 * window fills, the grant dies, the proxy is pulled. `autoMigrateExhausted`
 * moves the users pinned to it, along the failover chain, and this monitor is
 * what calls it on a cadence so users do not have to hit a 503 first.
 *
 * Mirrors the usage-probe monitor shape: start/stop/setConfig/runOnce/getSnapshot.
 * The sweep is idempotent, so an overlapping tick is a no-op rather than a
 * double move.
 */

import { listVms, getVm } from '../vm/vm-registry.mjs'
import { resolveHostIdentity } from '../vm/host-identity.mjs'
import { autoMigrateExhausted } from './egress-binding.mjs'
import { buildEgressGates } from './egress-gates.mjs'
import { EgressBindingsRepo } from '../db/repos/egress-bindings-repo.mjs'

export const DEFAULT_EGRESS_MIGRATION = Object.freeze({
  /** Off by default: moving a user changes their egress, so an operator opts in. */
  enabled: false,
  interval_sec: 60,
  run_on_start: true,
  /** Report only; write nothing. Useful before turning this on in production. */
  dry_run: false,
})

export function normalizeEgressMigrationConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const interval = Number(src.interval_sec)
  return {
    enabled: src.enabled === true,
    interval_sec: Number.isFinite(interval) ? Math.min(3600, Math.max(5, Math.round(interval))) : 60,
    run_on_start: src.run_on_start !== false,
    dry_run: src.dry_run === true,
  }
}

export function createEgressMigrationMonitor({
  projectRoot,
  accountQuota = null,
  runtimeRepo = null,
  getConfig = () => ({}),
  nowFn = () => Date.now(),
  repo = null,
} = {}) {
  let config = normalizeEgressMigrationConfig(getConfig())
  let timer = null
  let inflight = null
  let lastRun = null

  const bindingsRepo = () => repo || new EgressBindingsRepo()

  const runOnce = async () => {
    if (inflight) return inflight
    const started = nowFn()
    inflight = (async () => {
      // listVms returns summaries; the slot gate and the egress derivation need
      // full records (claude, proxy, schedulable).
      const vms = projectRoot
        ? listVms(projectRoot)
            .map((summary) => getVm(projectRoot, summary.id))
            .filter(Boolean)
        : []
      const hostIdentity = resolveHostIdentity()
      const gates = buildEgressGates({ quota: accountQuota, runtimeRepo })
      const sweep = autoMigrateExhausted(
        { vms, hostIdentity, gates, dryRun: config.dry_run },
        { repo: bindingsRepo() },
      )
      lastRun = {
        at: new Date(nowFn()).toISOString(),
        duration_ms: nowFn() - started,
        dry_run: config.dry_run,
        slots: vms.length,
        moved: sweep.moved,
        failed: sweep.failed,
        results: sweep.results,
      }
      return lastRun
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  const stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  const start = ({ immediate = false } = {}) => {
    stop()
    if (!config.enabled) return { started: false, reason: 'disabled' }
    timer = setInterval(() => {
      runOnce().catch(() => {})
    }, config.interval_sec * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    if (immediate && config.run_on_start) {
      queueMicrotask(() => {
        runOnce().catch(() => {})
      })
    }
    return { started: true, interval_sec: config.interval_sec, dry_run: config.dry_run }
  }

  const setConfig = (next, { restart = true } = {}) => {
    config = normalizeEgressMigrationConfig(next)
    if (restart) start({ immediate: false })
    return config
  }

  return {
    getConfig: () => config,
    setConfig,
    getSnapshot: () => lastRun,
    runOnce,
    start,
    stop,
  }
}
