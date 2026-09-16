/**
 * Live gates for the egress-binding policy.
 *
 * `egress-binding.mjs` stays dependency-free and testable; this module is the
 * thin adapter that feeds it real pool state:
 *
 *   cooldown → account_runtime_states (sub2api-shaped temp_unschedulable_*)
 *   quota    → AccountQuota.canAccept (5h/7d windows, safety ratios)
 *
 * Both are keyed by account id, so a slot is mapped through `accountIdForSlot`.
 */

/** Slot → upstream account id. `account_id` in the accounts table is the account UUID. */
export function defaultAccountIdForSlot(vm = {}) {
  return String(vm?.account_uuid || vm?.claude?.account_uuid || vm?.claude?.account_id || '').trim() || null
}

/**
 * Skip slots that are cooling down (429 / overload / grant-death park).
 * Mirrors `account-runtime-repo` state: `cooldown_until` is ms-epoch.
 */
export function cooldownGate(runtimeRepo, { accountIdForSlot = defaultAccountIdForSlot, now = () => Date.now() } = {}) {
  if (!runtimeRepo?.get) return null
  return (slotId, vm) => {
    const accountId = accountIdForSlot(vm) || slotId
    let state = null
    try {
      state = runtimeRepo.get(accountId)
    } catch {
      state = null
    }
    if (!state) return { cooling: false }
    if (String(state.status || '') === 'disabled') {
      return { cooling: true, until: null, reason: state.cooldown_reason || 'disabled' }
    }
    const until = Number(state.cooldown_until) || 0
    if (until > now()) {
      return { cooling: true, until, reason: state.cooldown_reason || 'cooldown' }
    }
    return { cooling: false }
  }
}

/**
 * Report an account whose Claude windows are spent.
 *
 * Only hard quota reasons count. A concurrency or session limit means "come back
 * in a moment", and moving a user's IP for that would be both churn and a new
 * egress identity — `egress-binding.slotVerdict` downgrades those to
 * `transient:<reason>` and never migrates on them.
 */
export function quotaGate(quota, { accountIdForSlot = defaultAccountIdForSlot } = {}) {
  if (!quota?.canAccept) return null
  return (slotId, vm) => {
    const accountId = accountIdForSlot(vm) || slotId
    let verdict = null
    try {
      verdict = quota.canAccept(accountId)
    } catch {
      return { ok: true }
    }
    if (!verdict || verdict.ok !== false) return { ok: true }
    return {
      ok: false,
      reason: verdict.reason || 'quota',
      window: verdict.detail?.window || null,
    }
  }
}

/** Build both gates from live pool objects. Missing pieces are simply omitted. */
export function buildEgressGates({ quota = null, runtimeRepo = null, accountIdForSlot = defaultAccountIdForSlot, now } = {}) {
  const gates = {}
  const cd = cooldownGate(runtimeRepo, now ? { accountIdForSlot, now } : { accountIdForSlot })
  if (cd) gates.cooldown = cd
  const q = quotaGate(quota, { accountIdForSlot })
  if (q) gates.quota = q
  return gates
}

/** Put a slot into a timed cooldown, the way the scheduler already parks accounts. */
export function coolSlot(
  { slotId, vm = {}, minutes = 5, reason = 'quota_exhausted', runtimeRepo, accountIdForSlot = defaultAccountIdForSlot } = {},
) {
  if (!runtimeRepo?.markCooldown) return { ok: false, reason: 'runtime_repo_required' }
  const accountId = accountIdForSlot(vm) || String(slotId || '').trim()
  if (!accountId) return { ok: false, reason: 'account_required' }
  const ms = Math.max(1, Number(minutes) || 5) * 60_000
  const until = Date.now() + ms
  runtimeRepo.markCooldown(accountId, {
    vmId: slotId || vm?.id || null,
    until,
    reason,
    status: 'cooldown',
  })
  return { ok: true, accountId, until, reason }
}
