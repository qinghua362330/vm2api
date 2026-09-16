/**
 * Request-level inference hop router.
 * 公开仓只走 rust cli-hop（kernel → Claude Code）。Go HTTP 转发不再启用。
 * Credential import/ensure 仍可走 Go 客户端，但不参与推理 hop。
 */
import { ensureWorkerCredential, callGoWorker, streamGoWorker } from './go-worker-client.mjs'
import { isCrsMock } from './crs-mock.mjs'
import {
  streamRustKernel,
  callRustKernel,
  rustKernelHealth,
  rustKernelReachable,
  isNeedsRefreshResult,
} from './rust-kernel-client.mjs'
import {
  ensureRustKernel,
  kernelBinPath,
  scheduleWrapRecycle,
  awaitWrapRecycle,
  noteWrapHop,
} from './rust-kernel-supervisor.mjs'

const rustHealthCache = new Map()

export function rustHealthTtlMs(routing = {}) {
  const raw = routing?.inference?.health_ttl_ms
  if (raw == null || raw === '') return 2000
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 2000
  return n
}

export function clearRustHealthCache(vmId = null) {
  if (vmId) rustHealthCache.delete(String(vmId))
  else rustHealthCache.clear()
}

function cacheKey(exec) {
  return String(exec?.vmId || exec?.vm?.id || '')
}

export function rememberRustHealth(exec, ready) {
  const key = cacheKey(exec)
  if (!key || !ready?.ok) return
  rustHealthCache.set(key, { at: Date.now(), health: ready.health || null })
}

export function peekRustHealth(exec, ttlMs, now = Date.now()) {
  if (ttlMs <= 0) return null
  const key = cacheKey(exec)
  if (!key) return null
  const hit = rustHealthCache.get(key)
  if (!hit) return null
  if (now - hit.at > ttlMs) return null
  return hit
}

export function resolveHopEngine(_vm, _routing = {}, { rustReady = null, binPath = null } = {}) {
  // The e2e harness runs entirely on the in-process Anthropic mock
  // (`KIN_CRS_MOCK=1`, test/harness.mjs). That mock is implemented on the Go
  // client path, so forcing rust here made every inference e2e test 503 with
  // "rust kernel is not available" — the public build ships no patched CLI.
  // Mock mode is test-only and never set in production.
  if (isCrsMock()) {
    return { engine: 'go', wanted: 'go', reason: 'crs_mock', fallback: false, blocked: false, mock: true }
  }
  const wanted = 'rust'
  const bin = binPath != null ? String(binPath).trim() : kernelBinPath()
  if (rustReady === true) {
    return { engine: 'rust', wanted, reason: 'configured_rust', fallback: false }
  }
  if (rustReady === false || !bin) {
    return {
      engine: 'rust',
      wanted,
      reason: rustReady === false ? 'rust_unhealthy' : 'bin_missing',
      fallback: false,
      blocked: true,
    }
  }
  return { engine: 'rust', wanted, reason: 'configured_rust', fallback: false }
}

function rustUnavailableResult(ready) {
  return {
    ok: false,
    status: 0,
    via: 'rust-kernel',
    engine: 'rust',
    body: {
      type: 'error',
      error: {
        type: 'worker_error',
        code: ready?.reason || 'rust_unavailable',
        message: ready?.error || 'rust kernel is not available',
      },
    },
    headers: {},
    terminalState: 'transport_error',
    transportError: true,
  }
}

function credentialEnsureFailure(result, ensured) {
  const rawError = ensured?.error
  const error = rawError && typeof rawError === 'object' ? rawError : {}
  const blob = `${error.code || ''} ${error.message || ''} ${typeof rawError === 'string' ? rawError : ''}`
  const fatal = /invalid_grant|oauth_revoked|token has been revoked|refresh_token_missing/i.test(blob)
  const revoked = /token has been revoked|oauth_revoked/i.test(blob)
  return {
    ...result,
    ok: false,
    status: fatal ? 401 : Number(ensured?.status) || result.status,
    committed: fatal ? false : result.committed,
    terminalState: fatal ? 'rejected' : result.terminalState,
    body: {
      type: 'error',
      error: {
        type: fatal ? 'authentication_error' : error.type || 'worker_error',
        code: fatal
          ? revoked
            ? 'oauth_revoked'
            : error.code || 'invalid_grant'
          : error.code || 'credential_refresh_failed',
        message: fatal
          ? revoked
            ? 'OAuth access token has been revoked'
            : 'OAuth credential was rejected'
          : String(error.message || rawError || 'credential ensure failed').slice(0, 300),
      },
    },
    credential_ensure_failed: true,
  }
}

async function prepareRust(exec, { ensure, routing } = {}) {
  await awaitWrapRecycle(exec)
  if (typeof ensure === 'function') return ensure(exec)
  const ttl = rustHealthTtlMs(routing)
  const cached = peekRustHealth(exec, ttl)
  if (cached) {
    return { ok: true, reason: 'health_cache', health: cached.health }
  }
  const health = await rustKernelHealth(exec, { timeoutMs: 800 })
  if (rustKernelReachable(health)) {
    const ready = { ok: true, reason: 'already_up', health }
    rememberRustHealth(exec, ready)
    return ready
  }
  const started = await ensureRustKernel(exec)
  if (started?.ok) rememberRustHealth(exec, started)
  else clearRustHealthCache(cacheKey(exec))
  return started
}

async function runHop({ mode, opts }) {
  const routing = opts.routing || {}
  const decision = resolveHopEngine(opts.exec?.vm, routing)

  // Mock harness: serve from the in-process Anthropic stub. No kernel, no
  // network, no credential files (see src/lib/transport/crs-mock.mjs).
  if (decision.engine === 'go') {
    const sendMock = mode === 'stream' ? streamGoWorker : callGoWorker
    const mocked = await sendMock(opts)
    return {
      ...mocked,
      engine: 'go',
      wanted_engine: decision.wanted,
      engine_reason: decision.reason,
    }
  }

  let engine = 'rust'
  let reason = decision.reason
  if (!decision.blocked) {
    const ready = await prepareRust(opts.exec, { ensure: opts.ensureRust, routing })
    if (ready?.ok) {
      reason = ready.reason || 'configured_rust'
    } else {
      return {
        ...rustUnavailableResult(ready),
        wanted_engine: 'rust',
        engine_reason: ready?.reason || 'rust_unavailable',
      }
    }
  } else {
    return {
      ...rustUnavailableResult({ reason: decision.reason }),
      wanted_engine: 'rust',
      engine_reason: decision.reason,
    }
  }
  const send = mode === 'stream' ? streamRustKernel : callRustKernel
  let result = await send(opts)
  noteWrapHop(opts.exec)
  if (result.transportError === true && result.committed !== true) {
    result = await send(opts)
    result = { ...result, rust_transport_retried: true }
    noteWrapHop(opts.exec)
  }
  if (isNeedsRefreshResult(result)) {
    const ensure = opts.ensureCredential || ensureWorkerCredential
    const ensured = await ensure(opts.exec, { force: true })
    if (ensured?.ok !== true) result = credentialEnsureFailure(result, ensured)
    else {
      const recycle = opts.recycleWrap || scheduleWrapRecycle
      recycle(opts.exec)
      await awaitWrapRecycle(opts.exec)
      result = await send(opts)
      result = { ...result, credential_retried: true }
      noteWrapHop(opts.exec)
    }
  }
  if (result.terminalState === 'incomplete' || (result.committed && result.transportError)) {
    clearRustHealthCache(cacheKey(opts.exec))
  }
  return {
    ...result,
    engine,
    wanted_engine: decision.wanted,
    engine_reason: reason,
  }
}

export function dispatchStreamInference(opts = {}) {
  return runHop({ mode: 'stream', opts })
}

export function dispatchCallInference(opts = {}) {
  return runHop({ mode: 'call', opts })
}
