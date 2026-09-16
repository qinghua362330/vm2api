/**
 * User ↔ egress(IP) binding + slot migration with a fallback chain.
 *
 *   user ──(stable)──► egress(IP) ──1:N──► slot ──1:1──► credential
 *
 * A user's egress is their stable IP identity; the account behind it rotates.
 * When the bound slot can no longer serve (credential death, quota window full,
 * slot disabled, cooling), the user moves along this chain:
 *
 *   1. another usable slot in the SAME egress            → same IP, new device
 *   2. the LEAST-LOADED other egress that has capacity   → new IP, audited
 *   3. the host's own egress (`direct:<host>`)           → last resort
 *   4. nothing                                           → no_target, the user waits
 *
 * Step 1 is preferred because same-IP + a different device is ordinary NAT
 * behaviour. Step 2 exists because an egress can die wholesale (proxy closed,
 * IP burned) and stranding every user behind it is worse than moving them.
 * Step 3 is the operator's own IP, so it is used only when nothing else is left.
 *
 * All crossings of step 2/3 are recorded in `egress_migrations` with a reason,
 * so a user gaining a second IP is always explainable after the fact.
 */

import { evaluateSlotGate } from './schedule-eligibility.mjs'
import { getDb } from '../db/database.mjs'
import { EgressBindingsRepo } from '../db/repos/egress-bindings-repo.mjs'
import { resolveHostIdentity } from '../vm/host-identity.mjs'

export const DIRECT_EGRESS_PREFIX = 'direct:'

/**
 * Audit reasons.
 *   same_egress      — stayed on the IP, only the account changed
 *   egress_failover  — moved to another IP because this one had no capacity
 *   direct_fallback  — moved onto the host's own IP
 *   no_target        — nothing anywhere; recorded so the wait is explainable
 */
export const MIGRATION_REASONS = Object.freeze([
  'credential_dead',
  'quota_exhausted',
  'slot_disabled',
  'cooldown',
  'admin',
  'manual',
  // A conversation rebinding to a different slot: same buckets, new credential.
  'session_rebound',
  // ...and crossing egresses, which also changes the conversation's IP.
  'session_egress_change',
])
export const FAILOVER_REASONS = Object.freeze(['egress_failover', 'direct_fallback', 'no_target'])

/** Quota gate reasons that mean "this account cannot serve" (not "wait a moment"). */
const QUOTA_EXHAUSTED_RE = /^quota_|account_quota_exhausted|rate_limited/i

export function isDirectEgress(egressId) {
  return String(egressId || '').startsWith(DIRECT_EGRESS_PREFIX)
}

export function directEgressId(hostIdentity) {
  const id = String(hostIdentity || '').trim()
  return id ? `${DIRECT_EGRESS_PREFIX}${id}` : ''
}

export function slotEgressId(vm = {}, { hostIdentity = resolveHostIdentity() } = {}) {
  const proxyId = String(vm?.proxy?.id || vm?.proxy_id || '').trim()
  if (proxyId) return proxyId
  return directEgressId(vm?.egress_identity || hostIdentity)
}

export function slotLabel(vm = {}) {
  return String(vm?.id || vm?.vmId || '').trim()
}

export function slotIsUsable(vm) {
  return evaluateSlotGate(vm).ok === true
}

export function slotUnusableReason(vm) {
  return evaluateSlotGate(vm).reason || 'unknown'
}

// ── gates ───────────────────────────────────────────────────────────────────

/**
 * Gates let the caller layer live state on top of the static slot gate without
 * this module importing the pool:
 *   quota(slotId)    → { ok:false, reason:'quota_5h_cli' } when the account is spent
 *   cooldown(slotId) → { cooling:true, until, reason } from the runtime state
 *   directUsable(vm) → whether a proxy-less slot may serve (host-IP fallback)
 */
export function defaultDirectUsable(vm) {
  if (!vm) return false
  if (vm.schedulable === false) return false
  const status = String(vm.status || '').toLowerCase()
  if (['stopped', 'dead', 'error', 'disabled'].includes(status)) return false
  return !!(vm.claude?.has_access || vm.claude?.has_refresh || vm.has_access || vm.has_refresh)
}

/**
 * @returns {{ok:boolean, reason:string, window?:string}}
 */
export function slotVerdict(vm, gates = {}, { allowDirect = false } = {}) {
  const id = slotLabel(vm)
  if (!id) return { ok: false, reason: 'slot_unknown' }

  const cooling = gates.cooldown ? gates.cooldown(id, vm) : null
  if (cooling?.cooling) return { ok: false, reason: 'cooldown', until: cooling.until, detail: cooling.reason }

  const staticGate = allowDirect ? { ok: defaultDirectUsable(vm), reason: 'direct_unschedulable' } : evaluateSlotGate(vm)
  if (!staticGate.ok) return { ok: false, reason: staticGate.reason }

  if (gates.quota) {
    const q = gates.quota(id, vm)
    if (q && q.ok === false) {
      const reason = String(q.reason || 'quota')
      // concurrency / session limits are transient — they must not move a user.
      if (QUOTA_EXHAUSTED_RE.test(reason)) return { ok: false, reason, window: q.window || q.detail?.window || null }
      return { ok: false, reason: `transient:${reason}` }
    }
  }
  return { ok: true, reason: 'ok' }
}

export function isQuotaExhaustedVerdict(verdict) {
  return !!verdict && !verdict.ok && QUOTA_EXHAUSTED_RE.test(String(verdict.reason || ''))
}

// ── user → egress ───────────────────────────────────────────────────────────

export function ensureUserEgress(
  { userId, egressId, reason = 'auto', boundBy = null, force = false } = {},
  { repo = new EgressBindingsRepo(getDb()) } = {},
) {
  const uid = String(userId || '').trim()
  const eid = String(egressId || '').trim()
  if (!uid) return { ok: false, reason: 'user_required' }
  if (!eid) return { ok: false, reason: 'egress_required' }
  const existing = repo.getEgressBinding(uid)
  if (existing && existing.egress_id !== eid && !force) {
    return { ok: false, reason: 'egress_locked', binding: existing }
  }
  const res = repo.upsertEgressBinding({ userId: uid, egressId: eid, reason, boundBy })
  if (res.changed && existing && existing.egress_id !== eid) {
    repo.recordMigration({
      userId: uid,
      egressId: eid,
      reason: reason === 'admin' ? 'admin' : 'egress_failover',
      detail: `egress ${existing.egress_id} -> ${eid}`,
    })
  }
  return { ok: true, created: res.created, changed: res.changed, binding: res.binding }
}

// ── picking ─────────────────────────────────────────────────────────────────

function loadByEgress(repo) {
  const users = repo.countUsersByEgress()
  const slots = {}
  for (const b of repo.listSlotBindings()) slots[b.egress_id] = (slots[b.egress_id] || 0) + 1
  return { users, slots }
}

export function pickSlotInEgress(
  { egressId, vms = [], exclude = [], hostIdentity = resolveHostIdentity(), gates = {}, allowDirect = false } = {},
  { repo = new EgressBindingsRepo(getDb()) } = {},
) {
  const skip = new Set((exclude || []).filter(Boolean).map(String))
  const load = {}
  for (const b of repo.listSlotBindingsByEgress(egressId)) load[b.slot_id] = (load[b.slot_id] || 0) + 1

  const candidates = []
  const rejected = []
  for (const vm of vms) {
    const id = slotLabel(vm)
    if (!id || skip.has(id)) continue
    if (slotEgressId(vm, { hostIdentity }) !== egressId) continue
    const verdict = slotVerdict(vm, gates, { allowDirect: allowDirect || isDirectEgress(egressId) })
    if (!verdict.ok) {
      rejected.push({ id, reason: verdict.reason })
      continue
    }
    candidates.push({ id, vm, users: load[id] || 0 })
  }
  candidates.sort((a, b) => a.users - b.users || a.id.localeCompare(b.id))
  if (!candidates.length) {
    return { ok: false, reason: rejected.length ? 'no_usable_slot' : 'no_slot_in_egress', considered: rejected }
  }
  return { ok: true, slot: candidates[0], considered: rejected }
}

/**
 * The egress that should absorb a user whose own egress is dead.
 * "Least used" = fewest bound users, then fewest slots — so load spreads and
 * recovery from the loss of one IP does not pile everyone onto a single other IP.
 */
export function pickLeastLoadedEgress(
  { vms = [], excludeEgress = [], hostIdentity = resolveHostIdentity(), gates = {}, directEgress = null } = {},
  { repo = new EgressBindingsRepo(getDb()) } = {},
) {
  const skip = new Set((excludeEgress || []).filter(Boolean).map(String))
  const host = directEgress || directEgressId(hostIdentity)
  if (host) skip.add(host)

  const { users, slots } = loadByEgress(repo)
  const seen = new Set()
  const ranked = []
  for (const vm of vms) {
    const egressId = slotEgressId(vm, { hostIdentity })
    if (!egressId || skip.has(egressId) || seen.has(egressId)) continue
    seen.add(egressId)
    const picked = pickSlotInEgress({ egressId, vms, hostIdentity, gates }, { repo })
    if (!picked.ok) continue
    ranked.push({
      egressId,
      slot: picked.slot,
      users: users[egressId] || 0,
      slots: slots[egressId] || 0,
    })
  }
  ranked.sort(
    (a, b) => a.users - b.users || a.slots - b.slots || a.egressId.localeCompare(b.egressId),
  )
  return ranked.length ? { ok: true, ...ranked[0], ranked } : { ok: false, reason: 'no_egress_with_capacity' }
}

/** Last resort: the host's own IP. Only valid when a proxy-less slot can serve. */
export function pickDirectEgress({ vms = [], hostIdentity = resolveHostIdentity(), gates = {} } = {}, { repo = new EgressBindingsRepo(getDb()) } = {}) {
  const egressId = directEgressId(hostIdentity)
  if (!egressId) return { ok: false, reason: 'no_direct_egress' }
  const picked = pickSlotInEgress({ egressId, vms, hostIdentity, gates, allowDirect: true }, { repo })
  return picked.ok ? { ok: true, egressId, slot: picked.slot } : { ok: false, reason: 'no_direct_slot' }
}

// ── migration ───────────────────────────────────────────────────────────────

/**
 * Move a user to another slot. Prefers their own egress; falls back outward
 * when that egress has nothing left to give.
 */
export function migrateUser(
  {
    userId,
    vms = [],
    egressId = null,
    hostIdentity = resolveHostIdentity(),
    reason = 'credential_dead',
    fromSlot = null,
    detail = null,
    boundBy = null,
    gates = {},
    allowFailover = true,
    allowDirect = true,
  } = {},
  { repo = new EgressBindingsRepo(getDb()) } = {},
) {
  const uid = String(userId || '').trim()
  if (!uid) return { ok: false, reason: 'user_required' }

  const binding = repo.getEgressBinding(uid)
  const current = fromSlot || repo.getSlotBinding(uid)?.slot_id || null
  const home = String(binding?.egress_id || egressId || '').trim()

  // 1. same egress
  if (home) {
    const picked = pickSlotInEgress(
      { egressId: home, vms, exclude: [current], hostIdentity, gates },
      { repo },
    )
    if (picked.ok) {
      const moved = repo.moveUserToSlot({ userId: uid, egressId: home, fromSlot: current, toSlot: picked.slot.id, reason, boundBy })
      return { ok: true, migrated: true, scope: 'same_egress', slotId: picked.slot.id, vm: picked.slot.vm, egressId: home, fromSlot: current, migrations: moved.binding?.migrations ?? 0 }
    }
  }

  if (!allowFailover) {
    repo.recordMigration({ userId: uid, egressId: home || 'unknown', fromSlot: current, toSlot: null, reason: 'no_target', detail: `${reason}: same-egress exhausted, failover disabled` })
    return { ok: false, reason: 'no_usable_slot', scope: 'same_egress', egressId: home, fromSlot: current }
  }

  // 2. least-loaded other egress
  const other = pickLeastLoadedEgress({ vms, excludeEgress: [home], hostIdentity, gates }, { repo })
  if (other.ok) {
    const rebind = repo.upsertEgressBinding({ userId: uid, egressId: other.egressId, reason: 'auto', boundBy })
    void rebind
    const moved = repo.moveUserToSlot({
      userId: uid,
      egressId: other.egressId,
      fromSlot: current,
      toSlot: other.slot.id,
      reason: 'egress_failover',
      boundBy,
    })
    repo.recordMigration({
      userId: uid,
      egressId: other.egressId,
      fromSlot: current,
      toSlot: other.slot.id,
      reason: 'egress_failover',
      detail: `${reason}: ${home || 'none'} -> ${other.egressId} (users=${other.users}, slots=${other.slots})`,
    })
    return {
      ok: true,
      migrated: true,
      scope: 'failover_egress',
      slotId: other.slot.id,
      vm: other.slot.vm,
      egressId: other.egressId,
      fromEgressId: home,
      fromSlot: current,
      migrations: moved.binding?.migrations ?? 0,
    }
  }

  // 3. host's own IP
  if (allowDirect) {
    const direct = pickDirectEgress({ vms, hostIdentity, gates }, { repo })
    if (direct.ok) {
      repo.upsertEgressBinding({ userId: uid, egressId: direct.egressId, reason: 'auto', boundBy })
      const moved = repo.moveUserToSlot({
        userId: uid,
        egressId: direct.egressId,
        fromSlot: current,
        toSlot: direct.slot.id,
        reason: 'direct_fallback',
        boundBy,
      })
      repo.recordMigration({
        userId: uid,
        egressId: direct.egressId,
        fromSlot: current,
        toSlot: direct.slot.id,
        reason: 'direct_fallback',
        detail: `${reason}: fell back to host IP`,
      })
      return {
        ok: true,
        migrated: true,
        scope: 'direct',
        slotId: direct.slot.id,
        vm: direct.slot.vm,
        egressId: direct.egressId,
        fromEgressId: home,
        fromSlot: current,
        migrations: moved.binding?.migrations ?? 0,
      }
    }
  }

  // 4. nothing anywhere
  repo.recordMigration({
    userId: uid,
    egressId: home || 'unknown',
    fromSlot: current,
    toSlot: null,
    reason: 'no_target',
    detail: `${reason}: no egress with capacity (other=${other.reason})`,
  })
  return { ok: false, reason: 'no_target', egressId: home, fromSlot: current }
}

/** Same-egress only. Kept for callers that must not change a user's IP. */
export function migrateUserWithinEgress(args = {}, deps = {}) {
  return migrateUser({ ...args, allowFailover: false, allowDirect: false }, deps)
}

// ── hot path ────────────────────────────────────────────────────────────────

export function resolveUserSlot(
  {
    userId,
    vms = [],
    egressId = null,
    reason = 'credential_dead',
    hostIdentity = resolveHostIdentity(),
    gates = {},
    autoMigrate = true,
    allowFailover = true,
    allowDirect = true,
  } = {},
  { repo = new EgressBindingsRepo(getDb()) } = {},
) {
  const uid = String(userId || '').trim()
  if (!uid) return { ok: false, reason: 'user_required' }

  let egressBinding = repo.getEgressBinding(uid)
  if (!egressBinding) {
    if (!egressId) return { ok: false, reason: 'no_egress_binding' }
    const pinned = ensureUserEgress({ userId: uid, egressId, reason: 'auto' }, { repo })
    if (!pinned.ok) return pinned
    egressBinding = pinned.binding
  }

  const bound = repo.getSlotBinding(uid)
  const byId = new Map(vms.map((vm) => [slotLabel(vm), vm]))

  if (bound) {
    const vm = byId.get(bound.slot_id)
    const sameEgress = vm && slotEgressId(vm, { hostIdentity }) === bound.egress_id
    const verdict = vm ? slotVerdict(vm, gates, { allowDirect: isDirectEgress(bound.egress_id) }) : null
    if (sameEgress && verdict?.ok) {
      return { ok: true, slotId: bound.slot_id, vm, egressId: bound.egress_id, migrated: false }
    }
    // Transient means "come back in a moment" (concurrency / session cap). The
    // slot and its IP are healthy, so the user must not be moved for it.
    if (verdict && !verdict.ok && String(verdict.reason).startsWith('transient:')) {
      return {
        ok: false,
        reason: verdict.reason,
        transient: true,
        retry: true,
        slotId: bound.slot_id,
        egressId: bound.egress_id,
      }
    }
    if (!autoMigrate) {
      return { ok: false, reason: verdict ? verdict.reason : 'bound_slot_missing', slotId: bound.slot_id, egressId: bound.egress_id }
    }
    return migrateUser(
      {
        userId: uid,
        vms,
        egressId: bound.egress_id,
        hostIdentity,
        reason: !vm ? 'slot_disabled' : isQuotaExhaustedVerdict(verdict) ? 'quota_exhausted' : reason,
        fromSlot: bound.slot_id,
        gates,
        allowFailover,
        allowDirect,
      },
      { repo },
    )
  }

  const picked = pickSlotInEgress({ egressId: egressBinding.egress_id, vms, hostIdentity, gates }, { repo })
  if (!picked.ok) {
    if (allowFailover) {
      return migrateUser({ userId: uid, vms, egressId: egressBinding.egress_id, hostIdentity, reason, gates, allowFailover, allowDirect }, { repo })
    }
    return { ok: false, reason: picked.reason, egressId: egressBinding.egress_id, considered: picked.considered }
  }
  repo.upsertSlotBinding({ userId: uid, slotId: picked.slot.id, egressId: egressBinding.egress_id, reason: 'auto' })
  return { ok: true, slotId: picked.slot.id, vm: picked.slot.vm, egressId: egressBinding.egress_id, migrated: false, created: true }
}

// ── automatic triggers ──────────────────────────────────────────────────────

/**
 * First assignment for a user who has no egress yet.
 * Least-loaded egress with capacity, else the shared host IP. Returns the
 * chosen egress so the caller can hand it straight to resolveUserSlot.
 */
export function assignUserEgress({ userId, vms = [], hostIdentity = resolveHostIdentity(), gates = {} } = {}, { repo = new EgressBindingsRepo(getDb()) } = {}) {
  const uid = String(userId || '').trim()
  if (!uid) return { ok: false, reason: 'user_required' }
  const existing = repo.getEgressBinding(uid)
  if (existing) return { ok: true, egressId: existing.egress_id, existing: true }

  const served = pickLeastLoadedEgress({ vms, hostIdentity, gates }, { repo })
  if (served.ok) {
    const pinned = ensureUserEgress({ userId: uid, egressId: served.egressId, reason: 'auto' }, { repo })
    if (pinned.ok) {
      return { ok: true, egressId: served.egressId, slotId: served.slot.id, vm: served.slot.vm, created: true }
    }
    return pinned
  }

  const direct = pickDirectEgress({ vms, hostIdentity, gates }, { repo })
  if (direct.ok) {
    const pinned = ensureUserEgress({ userId: uid, egressId: direct.egressId, reason: 'auto' }, { repo })
    if (pinned.ok) {
      return { ok: true, egressId: direct.egressId, slotId: direct.slot.id, vm: direct.slot.vm, created: true, direct: true }
    }
    return pinned
  }
  return { ok: false, reason: 'no_egress_available', served: served.reason }
}

/**
 * The egresses a user may use — their buckets, primary first.
 *
 * One DB read, so the dispatch path can hand the constraint to the scheduler
 * without scanning the fleet. An empty array means "no buckets yet", which the
 * scheduler treats as unconstrained for a platform-scoped caller.
 */
export function userBucketEgressIds(userId, { repo = new EgressBindingsRepo(getDb()) } = {}) {
  return repo.listBuckets(userId).map((bucket) => bucket.egress_id)
}

/** Slots reachable through a user's buckets. Used by the console, not the hot path. */
export function userBucketSlots({ userId, vms = [], hostIdentity = resolveHostIdentity() } = {}, { repo = new EgressBindingsRepo(getDb()) } = {}) {
  const allowed = new Set(userBucketEgressIds(userId, { repo }))
  if (!allowed.size) return []
  return vms
    .filter((vm) => allowed.has(slotEgressId(vm, { hostIdentity })))
    .map((vm) => slotLabel(vm))
    .filter(Boolean)
}

/**
 * Dispatch entry point: the slot a user's request should prefer.
 *
 * Priority is session binding > bucket preference > failover. The session pin is
 * enforced by the scheduler (it owns the sticky map); this function supplies the
 * preferred slot for a *new* conversation plus the bucket set that pin is
 * validated against.
 *
 * A user with no binding is assigned one here, which is what makes the binding
 * real rather than something an operator has to seed by hand.
 */
export function resolveUserDispatch(
  {
    userId,
    vms = [],
    loadVm = null,
    hostIdentity = resolveHostIdentity(),
    gates = {},
    reason = 'credential_dead',
    allowFailover = true,
    allowDirect = true,
  } = {},
  { repo = new EgressBindingsRepo(getDb()) } = {},
) {
  const uid = String(userId || '').trim()
  if (!uid) return { ok: false, reason: 'user_required' }

  const buckets = userBucketEgressIds(uid, { repo })

  // Steady state: the binding is set and only the bound slot matters. The
  // scheduler needs the binding layer on the request path, so avoid reading the
  // whole fleet (listVms returns summaries anyway; the gate needs full records).
  const binding = repo.getEgressBinding(uid)
  const bound = repo.getSlotBinding(uid)
  if (binding && bound && typeof loadVm === 'function') {
    const vm = loadVm(bound.slot_id)
    const sameEgress = !!vm && slotEgressId(vm, { hostIdentity }) === binding.egress_id
    const verdict = vm ? slotVerdict(vm, gates, { allowDirect: isDirectEgress(binding.egress_id) }) : null
    if (sameEgress && verdict?.ok) {
      return {
        ok: true,
        slotId: bound.slot_id,
        vm,
        egressId: binding.egress_id,
        allowedEgressIds: buckets,
        migrated: false,
        fast: true,
      }
    }
    if (verdict && !verdict.ok && String(verdict.reason).startsWith('transient:')) {
      return {
        ok: false,
        reason: verdict.reason,
        transient: true,
        retry: true,
        slotId: bound.slot_id,
        egressId: binding.egress_id,
        allowedEgressIds: buckets,
      }
    }
  }

  // Assignment or migration needs the whole fleet.
  const all = typeof vms === 'function' ? vms() : vms
  const assigned = binding
    ? { ok: true, egressId: binding.egress_id, existing: true }
    : assignUserEgress({ userId: uid, vms: all, hostIdentity, gates }, { repo })
  if (!assigned.ok) return assigned

  const resolved = resolveUserSlot(
    { userId: uid, vms: all, hostIdentity, gates, reason, allowFailover, allowDirect },
    { repo },
  )
  const allowed = repo.listBuckets(uid).map((bucket) => bucket.egress_id)
  if (resolved.ok) {
    return { ...resolved, egressId: resolved.egressId || assigned.egressId, allowedEgressIds: allowed, assigned: !!assigned.created }
  }
  // Even when nothing can serve right now, the binding is what keeps the user's
  // IP stable once something frees up.
  return { ...resolved, egressId: assigned.egressId, allowedEgressIds: allowed, assigned: !!assigned.created }
}

// ── automatic triggers ──────────────────────────────────────────────────────

/**
 * Sweep every bound user and move the ones whose account cannot serve any more.
 * Call it from the pool tick; it is idempotent and cheap (bindings only).
 *
 * `gates.quota` is what turns "5h/7d window full" into a migration — a slot that
 * only hit a concurrency or session limit is deliberately left alone.
 */
export function autoMigrateExhausted(
  { vms = [], hostIdentity = resolveHostIdentity(), gates = {}, allowFailover = true, allowDirect = true, onlyReason = null, dryRun = false } = {},
  { repo = new EgressBindingsRepo(getDb()) } = {},
) {
  const byId = new Map(vms.map((vm) => [slotLabel(vm), vm]))
  const results = []
  for (const binding of repo.listSlotBindings()) {
    const vm = byId.get(binding.slot_id)
    const verdict = vm ? slotVerdict(vm, gates, { allowDirect: isDirectEgress(binding.egress_id) }) : { ok: false, reason: 'slot_missing' }
    if (verdict.ok) continue
    if (String(verdict.reason || '').startsWith('transient:')) continue

    const reason = !vm
      ? 'slot_disabled'
      : isQuotaExhaustedVerdict(verdict)
        ? 'quota_exhausted'
        : verdict.reason === 'cooldown'
          ? 'cooldown'
          : 'credential_dead'
    if (onlyReason && onlyReason !== reason) continue
    if (dryRun) {
      results.push({ user_id: binding.user_id, from: binding.slot_id, reason, dry_run: true })
      continue
    }
    const moved = migrateUser(
      { userId: binding.user_id, vms, egressId: binding.egress_id, hostIdentity, reason, fromSlot: binding.slot_id, gates, allowFailover, allowDirect },
      { repo },
    )
    results.push({ user_id: binding.user_id, from: binding.slot_id, reason, ...moved })
  }
  return { moved: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results }
}

// ── invariants + audit ──────────────────────────────────────────────────────

export function checkUserSlotEgress({ userId, vms = [], hostIdentity = resolveHostIdentity() } = {}, { repo = new EgressBindingsRepo(getDb()) } = {}) {
  const uid = String(userId || '').trim()
  const egress = repo.getEgressBinding(uid)
  const slot = repo.getSlotBinding(uid)
  if (!egress) return { ok: false, reason: 'no_egress_binding' }
  if (!slot) return { ok: false, reason: 'no_slot_binding' }
  const vm = vms.find((v) => slotLabel(v) === slot.slot_id)
  if (!vm) return { ok: false, reason: 'slot_missing', slotId: slot.slot_id }
  const actual = slotEgressId(vm, { hostIdentity })
  if (actual !== egress.egress_id) {
    return { ok: false, reason: 'egress_drift', expected: egress.egress_id, actual }
  }
  return { ok: true, egressId: actual, slotId: slot.slot_id }
}

export function egressSharingReport({ vms = [], hostIdentity = resolveHostIdentity(), minSlots = 2 } = {}, { repo = new EgressBindingsRepo(getDb()) } = {}) {
  const usersByEgress = repo.countUsersByEgress()
  const groups = new Map()
  for (const vm of vms) {
    const id = slotEgressId(vm, { hostIdentity })
    if (!id) continue
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(slotLabel(vm))
  }
  const shared = []
  for (const [egressId, slotIds] of groups) {
    if (slotIds.length < minSlots) continue
    shared.push({
      egressId,
      kind: isDirectEgress(egressId) ? 'direct' : 'proxy',
      slots: slotIds.sort(),
      slots_count: slotIds.length,
      users: usersByEgress[egressId] || 0,
    })
  }
  shared.sort((a, b) => b.slots_count - a.slots_count || a.egressId.localeCompare(b.egressId))
  return { shared, total_egresses: groups.size, shared_egresses: shared.length }
}

export function releaseSlot({ slotId, keepEgress = true } = {}, { repo = new EgressBindingsRepo(getDb()) } = {}) {
  const bindings = repo.listSlotBindingsBySlot(slotId)
  repo.releaseSlot(slotId)
  if (!keepEgress) for (const b of bindings) repo.deleteEgressBinding(b.user_id)
  return { released: bindings.length, users: bindings.map((b) => b.user_id) }
}

/** Admin rebind: an explicit IP change, audited as such. */
export function rebindUserEgress(
  { userId, egressId, vms = [], hostIdentity = resolveHostIdentity(), gates = {}, boundBy = null } = {},
  { repo = new EgressBindingsRepo(getDb()) } = {},
) {
  const uid = String(userId || '').trim()
  const eid = String(egressId || '').trim()
  if (!uid || !eid) return { ok: false, reason: 'user_and_egress_required' }
  const before = repo.getEgressBinding(uid)
  const res = ensureUserEgress({ userId: uid, egressId: eid, reason: 'admin', boundBy, force: true }, { repo })
  if (!res.ok) return res
  repo.deleteSlotBinding(uid)
  const picked = pickSlotInEgress({ egressId: eid, vms, hostIdentity, gates }, { repo })
  if (!picked.ok) {
    return { ok: true, rebindOnly: true, reason: picked.reason, egressId: eid, from: before?.egress_id || null }
  }
  repo.upsertSlotBinding({ userId: uid, slotId: picked.slot.id, egressId: eid, reason: 'admin', boundBy })
  return { ok: true, rebindOnly: false, slotId: picked.slot.id, egressId: eid, from: before?.egress_id || null }
}
