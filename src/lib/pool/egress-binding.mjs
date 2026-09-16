/**
 * User ↔ egress(IP) binding + within-egress slot migration.
 *
 * The unit of stability is the EGRESS, not the slot:
 *
 *   user ──(stable)──► egress(IP) ──1:N──► slot ──1:1──► credential
 *                          ▲
 *                          └── migration moves the user between slots that
 *                              share this IP. The IP never changes on its own.
 *
 * Why: a credential dying (or an account's 5h/7d window filling up) must not
 * strand a user. But moving a user to a different IP would hand them a second
 * egress identity, so migration is confined to one egress. Same IP + a
 * different device is normal NAT behaviour (laptop + desktop behind one
 * router); same user jumping IPs is not.
 *
 * Egress identity
 *   proxy  → the bound SOCKS5's id (one docker net `kin-eg-<id>` = one IP)
 *   direct → `direct:<host-identity>`; every slot without a proxy on that host
 *            shares it, which is why sharing is explicit and audited.
 */

import { evaluateSlotGate } from './schedule-eligibility.mjs'
import { getDb } from '../db/database.mjs'
import { EgressBindingsRepo } from '../db/repos/egress-bindings-repo.mjs'

export const DIRECT_EGRESS_PREFIX = 'direct:'
export const MIGRATION_REASONS = Object.freeze([
  'credential_dead',
  'quota_exhausted',
  'slot_disabled',
  'admin',
  'manual',
])

export function isDirectEgress(egressId) {
  return String(egressId || '').startsWith(DIRECT_EGRESS_PREFIX)
}

export function directEgressId(hostIdentity) {
  const id = String(hostIdentity || '').trim()
  return id ? `${DIRECT_EGRESS_PREFIX}${id}` : ''
}

/** Egress a slot currently egresses from. Proxy id wins; else the host identity. */
export function slotEgressId(vm = {}, { hostIdentity = 'host' } = {}) {
  const proxyId = String(vm?.proxy?.id || vm?.proxy_id || '').trim()
  if (proxyId) return proxyId
  return directEgressId(vm?.egress_identity || hostIdentity)
}

export function slotLabel(vm = {}) {
  return String(vm?.id || vm?.vmId || '').trim()
}

/**
 * A slot is a migration target only when the scheduler would really pick it.
 * Reuses the single shared gate so the console cannot disagree with the pool.
 */
export function slotIsUsable(vm) {
  return evaluateSlotGate(vm).ok === true
}

export function slotUnusableReason(vm) {
  return evaluateSlotGate(vm).reason || 'unknown'
}

// ── user → egress ───────────────────────────────────────────────────────────

/**
 * Pin a user to an egress. Existing binding is kept unless `force` (admin
 * rebind) — auto-resolution must never silently move a user's IP.
 */
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
      fromSlot: null,
      toSlot: null,
      reason: reason === 'admin' ? 'admin' : 'manual',
      detail: `egress ${existing.egress_id} -> ${eid}`,
    })
  }
  return { ok: true, created: res.created, changed: res.changed, binding: res.binding }
}

// ── slot picking inside one egress ──────────────────────────────────────────

/**
 * Candidate slots for a user inside `egressId`.
 * Ordered by: fewest pinned users, then a stable id order — spreading users
 * avoids piling everyone on slot #1 while keeping the choice deterministic.
 */
export function pickSlotInEgress(
  { egressId, vms = [], exclude = [], hostIdentity = 'host' } = {},
  { repo = new EgressBindingsRepo(getDb()) } = {},
) {
  const skip = new Set((exclude || []).filter(Boolean).map(String))
  const load = {}
  for (const b of repo.listSlotBindingsByEgress(egressId)) {
    load[b.slot_id] = (load[b.slot_id] || 0) + 1
  }
  const candidates = []
  for (const vm of vms) {
    const id = slotLabel(vm)
    if (!id || skip.has(id)) continue
    if (slotEgressId(vm, { hostIdentity }) !== egressId) continue
    if (!slotIsUsable(vm)) continue
    candidates.push({ id, vm, users: load[id] || 0 })
  }
  candidates.sort((a, b) => a.users - b.users || a.id.localeCompare(b.id))
  if (!candidates.length) {
    const sameEgress = vms.filter((vm) => slotEgressId(vm, { hostIdentity }) === egressId)
    return {
      ok: false,
      reason: sameEgress.length ? 'no_usable_slot' : 'no_slot_in_egress',
      considered: sameEgress.map((vm) => ({ id: slotLabel(vm), reason: slotUnusableReason(vm) })),
    }
  }
  return { ok: true, slot: candidates[0] }
}

// ── hot path ────────────────────────────────────────────────────────────────

/**
 * The slot a user's request must land on.
 *
 * - no binding            → pin to `egressId` + first usable slot
 * - bound slot still good → keep it (no churn, cache stays warm)
 * - bound slot dead       → migrate to another slot in the SAME egress
 * - nothing in egress     → fail closed; never fall through to another IP
 */
export function resolveUserSlot(
  { userId, vms = [], egressId = null, reason = 'credential_dead', hostIdentity = 'host', autoMigrate = true } = {},
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
  const boundEgress = egressBinding.egress_id
  const byId = new Map(vms.map((vm) => [slotLabel(vm), vm]))

  if (bound) {
    const vm = byId.get(bound.slot_id)
    const stillSameEgress = vm && slotEgressId(vm, { hostIdentity }) === boundEgress
    if (vm && stillSameEgress && slotIsUsable(vm)) {
      return { ok: true, slotId: bound.slot_id, vm, egressId: boundEgress, migrated: false }
    }
    if (!autoMigrate) {
      return {
        ok: false,
        reason: vm ? 'bound_slot_unusable' : 'bound_slot_missing',
        slotId: bound.slot_id,
        egressId: boundEgress,
      }
    }
    return migrateUserWithinEgress(
      {
        userId: uid,
        vms,
        egressId: boundEgress,
        hostIdentity,
        reason: vm ? reason : 'slot_disabled',
        fromSlot: bound.slot_id,
      },
      { repo },
    )
  }

  const picked = pickSlotInEgress({ egressId: boundEgress, vms, hostIdentity }, { repo })
  if (!picked.ok) return { ok: false, reason: picked.reason, egressId: boundEgress, considered: picked.considered }
  repo.upsertSlotBinding({
    userId: uid,
    slotId: picked.slot.id,
    egressId: boundEgress,
    reason: 'auto',
  })
  return { ok: true, slotId: picked.slot.id, vm: picked.slot.vm, egressId: boundEgress, migrated: false, created: true }
}

/**
 * Move a user to another slot inside their own egress.
 * Fails closed when the egress has no usable slot: the user waits rather than
 * silently acquiring a second IP.
 */
export function migrateUserWithinEgress(
  { userId, vms = [], egressId = null, hostIdentity = 'host', reason = 'credential_dead', fromSlot = null, detail = null, boundBy = null } = {},
  { repo = new EgressBindingsRepo(getDb()) } = {},
) {
  const uid = String(userId || '').trim()
  if (!uid) return { ok: false, reason: 'user_required' }
  const binding = repo.getEgressBinding(uid)
  const egress = String(egressId || binding?.egress_id || '').trim()
  if (!egress) return { ok: false, reason: 'no_egress_binding' }
  if (binding && binding.egress_id !== egress) {
    // Crossing egresses is an admin action, never automatic.
    return { ok: false, reason: 'egress_mismatch', egressId: egress, bound: binding.egress_id }
  }

  const current = fromSlot || repo.getSlotBinding(uid)?.slot_id || null
  const picked = pickSlotInEgress({ egressId: egress, vms, exclude: [current], hostIdentity }, { repo })
  if (!picked.ok) {
    repo.recordMigration({
      userId: uid,
      egressId: egress,
      fromSlot: current,
      toSlot: null,
      reason: 'no_target',
      detail: `${reason}: ${picked.reason}`,
    })
    return { ok: false, reason: picked.reason, egressId: egress, fromSlot: current, considered: picked.considered }
  }

  const moved = repo.moveUserToSlot({
    userId: uid,
    egressId: egress,
    fromSlot: current,
    toSlot: picked.slot.id,
    reason,
    boundBy,
  })
  return {
    ok: true,
    migrated: true,
    slotId: picked.slot.id,
    vm: picked.slot.vm,
    egressId: egress,
    fromSlot: current,
    migrations: moved.binding?.migrations ?? 0,
    detail,
  }
}

/** Admin rebind: the only path that changes a user's egress. Audited. */
export function rebindUserEgress(
  { userId, egressId, vms = [], hostIdentity = 'host', boundBy = null } = {},
  { repo = new EgressBindingsRepo(getDb()) } = {},
) {
  const uid = String(userId || '').trim()
  const eid = String(egressId || '').trim()
  if (!uid || !eid) return { ok: false, reason: 'user_and_egress_required' }
  const before = repo.getEgressBinding(uid)
  const res = ensureUserEgress(
    { userId: uid, egressId: eid, reason: 'admin', boundBy, force: true },
    { repo },
  )
  if (!res.ok) return res
  repo.deleteSlotBinding(uid)
  const picked = pickSlotInEgress({ egressId: eid, vms, hostIdentity }, { repo })
  if (!picked.ok) {
    return { ok: true, rebindOnly: true, reason: picked.reason, egressId: eid, from: before?.egress_id || null }
  }
  repo.upsertSlotBinding({ userId: uid, slotId: picked.slot.id, egressId: eid, reason: 'admin', boundBy })
  return {
    ok: true,
    rebindOnly: false,
    slotId: picked.slot.id,
    egressId: eid,
    from: before?.egress_id || null,
  }
}

// ── invariants + audit ──────────────────────────────────────────────────────

/** Invariant 1: a user's slot must live in the user's egress. */
export function checkUserSlotEgress({ userId, vms = [], hostIdentity = 'host' } = {}, { repo = new EgressBindingsRepo(getDb()) } = {}) {
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

/**
 * Ops view: which egress IPs carry more than one slot.
 * Sharing is allowed by policy — but it must be visible, never accidental.
 */
export function egressSharingReport({ vms = [], hostIdentity = 'host', minSlots = 2 } = {}, { repo = new EgressBindingsRepo(getDb()) } = {}) {
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

/** A slot that died takes its pinning with it; users are re-resolved lazily. */
export function releaseSlot({ slotId, keepEgress = true } = {}, { repo = new EgressBindingsRepo(getDb()) } = {}) {
  const bindings = repo.listSlotBindingsBySlot(slotId)
  repo.releaseSlot(slotId)
  if (!keepEgress) for (const b of bindings) repo.deleteEgressBinding(b.user_id)
  return { released: bindings.length, users: bindings.map((b) => b.user_id) }
}
