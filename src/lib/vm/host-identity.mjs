/**
 * The host's own egress identity — the VPS IP that proxy-less slots use.
 *
 * When no proxy in the pool can serve (list empty, every proxy dead, or every
 * egress is cooling), the platform falls back to the host's own IP. That IP is
 * SHARED by every slot that has no proxy bound, and that is intentional: it is
 * the operator's last resort, not a per-user identity.
 *
 * The identity is a stable string, never a live lookup:
 *   VM2API_DIRECT_IDENTITY / KIN_DIRECT_IDENTITY   explicit (recommended)
 *   hostname                                       stable fallback
 *
 * Detection is opt-in and off the hot path: `detectPublicIp()` is for the panel
 * ("detect and store"), so a request never waits on an external echo service.
 */

import os from 'node:os'

export const DIRECT_IDENTITY_ENV = Object.freeze(['VM2API_DIRECT_IDENTITY', 'KIN_DIRECT_IDENTITY'])

/** Stable host identity. Explicit env wins; hostname is the deterministic fallback. */
let _memo = null
export function resolveHostIdentity({ env = process.env, hostname = null } = {}) {
  const cacheable = env === process.env && hostname === null
  if (cacheable && _memo) return _memo
  let out = ''
  for (const key of DIRECT_IDENTITY_ENV) {
    const v = String(env?.[key] || '').trim()
    if (v) {
      out = v
      break
    }
  }
  if (!out) {
    // null means "not supplied" → ask the OS. '' means "supplied empty".
    const h = String(hostname === null ? os.hostname() || '' : hostname).trim()
    out = h || 'host'
  }
  if (cacheable) _memo = out
  return out
}

/** Drop the memo (tests / after an operator changes the identity). */
export function resetHostIdentityCache() {
  _memo = null
}

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/

export function looksLikeIp(value) {
  return IPV4_RE.test(String(value || '').trim())
}

/**
 * Ask an echo service for the host's public IP. Call it from a panel action and
 * persist the result — never from the request path.
 */
export async function detectPublicIp({
  endpoints = ['https://api.ipify.org', 'https://ifconfig.me/ip'],
  timeoutMs = 5000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'fetch_unavailable' }
  for (const url of endpoints) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, { signal: controller.signal })
      clearTimeout(timer)
      if (!res?.ok) continue
      const text = String(await res.text()).trim()
      if (looksLikeIp(text)) return { ok: true, ip: text, source: url }
    } catch {
      clearTimeout(timer)
    }
  }
  return { ok: false, reason: 'detect_failed' }
}

/**
 * Status of the shared host egress, for the panel.
 * `available` is what matters operationally: without at least one proxy-less
 * slot the fallback cannot serve anyone, and users wait instead.
 */
export function hostEgressStatus({ vms = [], hostIdentity = null } = {}) {
  const identity = hostIdentity || resolveHostIdentity()
  const id = `direct:${identity}`
  const slots = []
  const users = []
  for (const vm of vms || []) {
    const proxyId = String(vm?.proxy?.id || vm?.proxy_id || '').trim()
    if (proxyId) continue
    const slotId = String(vm?.id || vm?.vmId || '').trim()
    if (!slotId) continue
    slots.push(slotId)
    const owner = String(vm?.owner_user_id || '').trim()
    if (owner) users.push(owner)
  }
  return {
    egress_id: id,
    identity,
    kind: 'direct',
    shared: true,
    slots,
    slots_count: slots.length,
    available: slots.length > 0,
    note: 'Shared host IP. Every proxy-less slot egresses from here.',
  }
}
