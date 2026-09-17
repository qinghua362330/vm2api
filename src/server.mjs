/**
 * vm2api — Node control plane.
 * Inference data plane: one long-lived Go slot worker per VM
 * (slot SOCKS5 + OAuth owner + SSE terminal validation).
 * The gateway converts protocols, schedules the account pool with bounded
 * failover, and never talks to Anthropic on the inference path. After a live
 * OAuth import it may spawn official Claude Code once (slot SOCKS5) to seed
 * ~/.claude.json and complete a plan turn.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, reloadActiveVm } from './lib/core/config.mjs'
import {
  extractApiKey,
  timingSafeEqualStr,
  createRateLimiter,
  verifyPanelSession,
  extractPanelToken,
  attachPanelAuth,
  getPanelAdmin,
} from './lib/core/security.mjs'
import { loadModelPolicy } from './lib/protocol/model-policy.mjs'
import { gatewayModelCatalog } from './lib/protocol/models.mjs'
import {
  createCredentialRefreshMonitor,
  normalizeCredentialRefreshConfig,
} from './lib/oauth/credential-refresh-monitor.mjs'
import { createKernelWatchdog, normalizeKernelWatchdogConfig } from './lib/transport/kernel-watchdog.mjs'

import { createUsageProbeMonitor, normalizeUsageProbeConfig } from './lib/oauth/usage-probe-monitor.mjs'
import { createEgressMigrationMonitor } from './lib/pool/egress-migration-monitor.mjs'
import { readRawBody } from './lib/http/respond.mjs'
import { OrderService } from './lib/payment/orders.mjs'
import { PaymentConfigStore } from './lib/payment/config.mjs'
import { EASYPAY_ACK, easypayTradeSuccess, verifyEasypay, verifyStripeSignature } from './lib/payment/sign.mjs'
import { EgressBindingsRepo } from './lib/db/repos/egress-bindings-repo.mjs'
import { ChannelsRepo } from './lib/db/repos/channels-repo.mjs'
import { ChannelMonitor } from './lib/admin/channel-monitor.mjs'
import { normalizeOfficialCcConfig } from './lib/oauth/official-cc-bootstrap.mjs'
import { invalidateLiveCredentialCache } from './lib/admin/panel-live-credentials.mjs'
import { normalizeHealthProbeConfig, createHealthProbeMonitor, HEALTH_REAL_HEADER } from './lib/admin/health-probe.mjs'
import { normalizeNotifyConfig, createNotifyMonitor } from './lib/admin/notify.mjs'
import { runVmTestChat } from './lib/admin/vm-test-chat.mjs'
import { StickyRouter } from './lib/pool/sticky-router.mjs'
import { setManualScheduleWins } from './lib/pool/schedule-policy.mjs'
import { AccountQuota } from './lib/pool/account-quota.mjs'
import { normalizeTiers } from './lib/pool/quota-tiers.mjs'
import { ApiKeyStore } from './lib/admin/api-keys.mjs'
import { GroupsRepo } from './lib/db/repos/groups-repo.mjs'
import { ApiEndpointStore } from './lib/admin/api-endpoints.mjs'
import { ApiScheduler } from './lib/pool/api-scheduler.mjs'
import { resolveInferenceBackend } from './lib/pool/api-protocol.mjs'
import {
  startApiKernelProcess,
  apiKernelPaths,
  ensureApiKernelToken,
  apiKernelSnapshot,
} from './lib/transport/api-kernel-client.mjs'
import { PanelUserStore } from './lib/admin/panel-users.mjs'
import { RequestLogStore } from './lib/admin/request-log.mjs'
import { listVms, getVm, getActiveVmId, setVmSchedulable } from './lib/vm/vm-registry.mjs'
import { makeError, ErrorType, ErrorCode } from './lib/core/errors.mjs'
import * as panel from './lib/admin/panel-api.mjs'
import { ProxyPool } from './lib/vm/proxy-pool.mjs'
import { egressListening, ensureProxyEgress } from './lib/vm/egress.mjs'
import { GATEWAY_CAPABILITIES } from './lib/vm/execution-context.mjs'
import { isTelemetryPath, telemetryInterceptResponse } from './lib/identity/telemetry-rewrite.mjs'
import { openDatabase, closeDatabase } from './lib/db/database.mjs'
import { runLegacyImport } from './lib/db/legacy-import.mjs'
import { initVmDbSync, stopVmWatch } from './lib/vm/vm-db-sync.mjs'
import { BackupService } from './lib/admin/backup-service.mjs'

import {
  classifyCredentialRefresh,
  markVmRefreshError,
  mirrorWorkerCredentialsToVm,
} from './lib/oauth/oauth-credentials.mjs'
import { normalizeCredentialMode } from './lib/oauth/credential-mode.mjs'
import { workerHealth, ensureWorkerCredential } from './lib/transport/go-worker-client.mjs'
import { stopAllRustKernels } from './lib/transport/rust-kernel-supervisor.mjs'
import { createRespond } from './lib/http/respond.mjs'
import { tryServeWebDist } from './lib/http/web-dist.mjs'
import { normalizeBasePath, stripBasePath } from './lib/http/base-path.mjs'
import { createRoutingRuntime } from './lib/admin/routing-runtime.mjs'
import { createImportCommit } from './lib/oauth/import-commit.mjs'
import { createHandleProtocol } from './lib/protocol/handle-protocol.mjs'
import { handleUserCountTokens, handleUserUsage } from './lib/protocol/user-count-tokens.mjs'
import { createPanelHandler } from './lib/admin/panel-routes.mjs'

/** 部署前缀（PUBLIC_BASE_PATH，例如 /vm2api）。空 = 挂在域名根上。 */
const BASE_PATH = normalizeBasePath(process.env.PUBLIC_BASE_PATH)

const FEATURES = [
  'passthrough',
  'stream',
  'verified-stream',
  'protocol-convert',
  'go-slot-worker',
  'account-pool-failover',
  'weighted-round-robin',
  'tools',
  'client-workspace',
  'api-direct-kernel',
  'count_tokens',
  'account_usage',
]
const LIMITATIONS = {
  client_tools: 'kept in native Messages and executed by the caller',
  images: 'all native Messages image blocks are forwarded by the Go slot worker',
  multi_turn_native: 'full Messages history is preserved for every account attempt',
  claude_session: 'sticky commits only after a terminally verified response',
  kernel: 'one Docker container and one long-lived Go worker per slot; not a KVM guest',
  workspace: 'client only; VM/Claude-CLI inference has been removed',
  forward: 'Go worker uses the slot-bound SOCKS5 with no direct or CLI fallback',
  oauth: 'the Go slot worker Refresher.Ensure is the sole refresh manager and uses the same slot SOCKS5',
  realtime_stream:
    'account failover stops after the first downstream business event; verified mode buffers to message_stop',
}

const cfg = loadConfig()
if (!getPanelAdmin().password) {
  throw new Error('VM2API_ADMIN_PASSWORD must be set; insecure default panel credentials are disabled')
}
fs.mkdirSync(cfg.paths.captures, { recursive: true })

const allowRate = createRateLimiter({
  capacity: cfg.limits.rate_capacity,
  refillPerSec: cfg.limits.rate_refill,
})

// --- Persistent store (SQLite, sub2api-inspired) ---
const dataDir = cfg.paths.data || path.join(cfg.paths.root, 'data')
openDatabase({ dataDir })
try {
  loadModelPolicy()
} catch (e) {
  console.warn('[model-policy] boot load failed', e?.message || e)
}
// one-time migration of legacy JSON files (data/*.json + request-logs) into the DB
const legacyImport = runLegacyImport({ dataDir, projectRoot: cfg.paths.project })
if (legacyImport?.imported) {
  console.log('[db] legacy JSON import done:', JSON.stringify(legacyImport.counts || {}))
}
// VM/credential mirror: write-through hook + startup reconcile + fs.watch
const vmSync = initVmDbSync(cfg.paths.project)
if (vmSync.upserted || vmSync.rebuilt) {
  console.log(`[db] vm mirror reconciled: upserted=${vmSync.upserted} rebuilt=${vmSync.rebuilt}`)
}

// --- P3 sticky + quota ---

const routingConfigPath = process.env.KIN_ROUTING_FILE || path.join(cfg.paths.root, 'config', 'routing.json')
let healthMonitor = null
let credentialRefreshMonitor = null
let kernelWatchdog = null
let usageProbeMonitor = null
let notifyMonitor = null
let egressMigrationMonitor = null

let routingConfig = {}

let stickyRouter
let accountQuota
let requestLog
let proxyPool
let runtimeRepo
let attemptsRepo
let poolScheduler
let failoverRunner
let groupsRepo

const routingRt = createRoutingRuntime({
  get routingConfig() {
    return routingConfig
  },
  set routingConfig(v) {
    routingConfig = v
  },
  getRoutingConfig: () => routingConfig,
  setRoutingConfig: (v) => {
    routingConfig = v
  },
  cfg,
  routingConfigPath,
  get requestLog() {
    return requestLog
  },
  get stickyRouter() {
    return stickyRouter
  },
  get accountQuota() {
    return accountQuota
  },
  get poolScheduler() {
    return poolScheduler
  },
  setPoolScheduler: (v) => {
    poolScheduler = v
  },
  get healthMonitor() {
    return healthMonitor
  },
  setHealthMonitor: (v) => {
    healthMonitor = v
  },
  get credentialRefreshMonitor() {
    return credentialRefreshMonitor
  },
  get kernelWatchdog() {
    return kernelWatchdog
  },
  get usageProbeMonitor() {
    return usageProbeMonitor
  },

  get notifyMonitor() {
    return notifyMonitor
  },
  get failoverRunner() {
    return failoverRunner
  },
  setFailoverRunner: (v) => {
    failoverRunner = v
  },
  get runtimeRepo() {
    return runtimeRepo
  },
  setRuntimeRepo: (v) => {
    runtimeRepo = v
  },
  get attemptsRepo() {
    return attemptsRepo
  },
  setAttemptsRepo: (v) => {
    attemptsRepo = v
  },
  get proxyPool() {
    return proxyPool
  },
})

const {
  persistRoutingPatch,
  loadRoutingConfig,
  syncTierDefaultsIntoRouting,
  initPoolRuntime,
  poolSchedulerConfig,
  applyRoutingTierConcurrency,
  applyVmConcurrency,
  applyVmRpm,
} = routingRt

routingConfig = loadRoutingConfig()
setManualScheduleWins(routingConfig.pool?.manual_schedule_wins)
if (routingConfig.official_cc) {
  routingConfig.official_cc = normalizeOfficialCcConfig(routingConfig.official_cc)
}
routingConfig.health_probe = normalizeHealthProbeConfig(routingConfig.health_probe)
routingConfig.usage_probe = normalizeUsageProbeConfig(routingConfig.usage_probe)
routingConfig.notify = normalizeNotifyConfig(routingConfig.notify)
routingConfig.tiers = normalizeTiers(routingConfig.tiers, routingConfig.quota, routingConfig.concurrency)
syncTierDefaultsIntoRouting()
stickyRouter = new StickyRouter({
  dataDir,
  config: routingConfig,
  // A conversation that has to leave its slot is worth recording: it changed
  // credential mid-thread, and if it crossed egresses it changed IP too.
  onSessionMove: ({ key, userId, fromVmId, toVmId, fromEgressId, toEgressId }) => {
    if (!userId) return
    try {
      new EgressBindingsRepo().recordMigration({
        userId: String(userId),
        egressId: toEgressId || fromEgressId || 'unknown',
        fromSlot: fromVmId,
        toSlot: toVmId,
        reason: fromEgressId && toEgressId && fromEgressId !== toEgressId ? 'session_egress_change' : 'session_rebound',
        detail: `session ${key}`,
      })
    } catch {}
  },
})
accountQuota = new AccountQuota({
  dataDir,
  config: routingConfig,
  accounts: listVms(cfg.paths.project).map((v) => ({
    account_id: v.account_uuid || v.id,
    vm_id: v.id,
    email: v.email,
    type: normalizeCredentialMode(v.credential_mode),
    max_concurrency: v.policy?.maxConcurrency ?? routingConfig?.concurrency?.default_max_per_account ?? 2,
    max_rpm: v.policy?.maxRpm ?? routingConfig?.concurrency?.default_max_rpm ?? 0,
  })),
})

const apiKeyStore = new ApiKeyStore({ dataDir: cfg.paths.data })
groupsRepo = new GroupsRepo()
const apiEndpointStore = new ApiEndpointStore({ dataDir: cfg.paths.data })
const apiScheduler = new ApiScheduler()
apiScheduler.reload(apiEndpointStore.listRaw())
ensureApiKernelToken(apiKernelPaths(cfg).tokenPath)
startApiKernelProcess(cfg)
const panelUsers = new PanelUserStore({ dataDir: cfg.paths.data })
try {
  panelUsers.bootstrapFromEnv(getPanelAdmin())
} catch (e) {
  console.warn('[panel-users] bootstrap failed', e?.message || e)
}
attachPanelAuth({
  authenticate: (username, password) => panelUsers.authenticate(username, password),
  lookupRole: (username) => panelUsers.getByUsername(username)?.role || null,
})
requestLog = new RequestLogStore({
  dataDir: cfg.paths.data,
  mode: process.env.KIN_REQUEST_LOG_MODE || routingConfig?.logging?.mode || 'normal',
})
if (routingConfig?.logging) {
  requestLog.setConfig({
    // Env wins at boot so e2e / ops can force off|debug. Panel PUT still hot-updates.
    mode: process.env.KIN_REQUEST_LOG_MODE || routingConfig.logging.mode,
    retainDays: routingConfig.logging.retain_days,
    debugRetainDays: routingConfig.logging.debug_retain_days,
    maxMb: routingConfig.logging.max_mb,
    mutedErrorClasses: routingConfig.logging.muted_error_classes,
  })
}
try {
  requestLog.cleanup()
} catch {}
requestLog.startCleanupScheduler()

proxyPool = new ProxyPool({
  dataDir,
  onDisableVm: (vmId, reason, proxyId) => {
    setVmSchedulable(cfg.paths.project, vmId, false, `${reason}|proxy=${proxyId}`)
  },
  onDisconnectVm: (vmId, reason, proxyId) => {
    setVmSchedulable(cfg.paths.project, vmId, false, `${reason}|proxy=${proxyId}`)
  },
  // Keep probe history for 渠道监控. The proxy row is a snapshot; this is the series.
  onProbe: (proxy, result) => {
    try {
      const channelId = new ChannelsRepo().channelOfBucket(proxy.id)
      new ChannelMonitor().recordProbe({
        channelId,
        egressId: proxy.id,
        ok: result?.ok === true,
        latencyMs: result?.latency_ms ?? null,
        scope: result?.scope || null,
        error: result?.error || null,
      })
    } catch {}
  },
  onEnableVm: (vmId, _reason, proxyId) => {
    const vm = getVm(cfg.paths.project, vmId)
    const why = String(vm?.schedule_disabled_reason || '')
    if (!why.includes(`proxy=${proxyId}`) && !/egress_down|proxy_probe_failed/.test(why)) return
    setVmSchedulable(cfg.paths.project, vmId, true)
  },
  egressCheck: (proxy) => egressListening(cfg.paths.project, proxy?.id),
  repairEgress: (proxy) => ensureProxyEgress(cfg.paths.project, proxy),
})
proxyPool.startScheduler()

initPoolRuntime()
try {
  applyRoutingTierConcurrency(routingConfig.tiers)
} catch (e) {
  console.warn('[quota] apply tier concurrency failed', e?.message || e)
}

function accountForUsageProbe(vm) {
  const keys = [vm?.claude?.account_uuid, vm?.account_uuid, vm?.id].filter(Boolean)
  for (const key of keys) {
    try {
      const acc = accountQuota.repo.get(key)
      if (acc) return acc
    } catch {}
  }
  try {
    return accountQuota.repo.list().find((a) => a.vm_id === vm.id) || null
  } catch {
    return null
  }
}

function attachSlotRuntime(vm) {
  const acc = accountForUsageProbe(vm)
  const keys = [acc?.account_id, vm?.claude?.account_uuid, vm?.account_uuid, vm?.id].filter(Boolean)
  for (const key of keys) {
    try {
      const rt = accountQuota.runtimeRepo?.get?.(key)
      if (rt) {
        return {
          ...vm,
          cooldown_until: rt.cooldown_until || 0,
          cooldown_reason: rt.cooldown_reason || null,
        }
      }
    } catch {}
  }
  return vm
}

healthMonitor = createHealthProbeMonitor({
  config: routingConfig.health_probe,
  listTargets: () => listVms(cfg.paths.project).map(attachSlotRuntime),
  runChat: (vm, real) =>
    runVmTestChat({
      projectRoot: cfg.paths.project,
      vmId: vm.id,
      model: real.model,
      prompt: real.prompt,
      max_tokens: real.max_tokens,
      timeoutMs: real.timeout_ms,
      personaMode: 'overwrite',
      baseUrl: `http://127.0.0.1:${cfg.port}`,
      apiKey: cfg.api_key,
      unofficial: false,
      extraHeaders: { [HEALTH_REAL_HEADER]: '1' },
    }),
})
credentialRefreshMonitor = createCredentialRefreshMonitor({
  config: normalizeCredentialRefreshConfig(routingConfig.credential_refresh),
  listTargets: () =>
    listVms(cfg.paths.project).map((vm) => {
      let lastProbe = vm.last_probe || null
      try {
        const acc = accountQuota?.repo?.get?.(vm.account_uuid || vm.id)
        lastProbe = acc?.unified?.last_probe || acc?.last_probe || lastProbe
      } catch {}
      return { ...vm, last_probe: lastProbe }
    }),
  refreshOne: (vm) =>
    refreshWorkerCredentialForVm({
      vmId: vm.id,
      vmPath: path.join(cfg.paths.project, 'vms', `${vm.id}.json`),
      homeDir: path.join(cfg.paths.project, 'vms', vm.id, 'cli-home'),
      vm: getVm(cfg.paths.project, vm.id) || vm,
      force: false,
    }),
})
kernelWatchdog = createKernelWatchdog({
  config: routingConfig.kernel_watchdog,
  listTargets: () => listVms(cfg.paths.project),
  homeDirFor: (vm) => path.join(cfg.paths.project, 'vms', vm.id, 'cli-home'),
})

usageProbeMonitor = createUsageProbeMonitor({
  config: routingConfig.usage_probe,
  listTargets: () => listVms(cfg.paths.project),
  accountForVm: accountForUsageProbe,
  reconcile: (vm, account) => {
    const id = account?.account_id || vm?.claude?.account_uuid || vm?.account_uuid || vm?.id
    try {
      accountQuota.persistEffectiveWindows(id)
    } catch {}
    try {
      poolScheduler.syncQuotaSchedule(vm, account)
    } catch {}
  },
  probeOne: (vm) => panel.buildProbeOne({ cfg, accountQuota, id: vm.id }),
})
notifyMonitor = createNotifyMonitor({
  config: routingConfig.notify,
  snapshot: () =>
    panel.snapshotAccountPool({
      cfg,
      accountQuota,
      routingConfig,
      poolScheduler,
      proxyPool,
      requestLog,
    }),
})
egressMigrationMonitor = createEgressMigrationMonitor({
  projectRoot: cfg.paths.project,
  accountQuota,
  runtimeRepo,
  getConfig: () => routingConfig.egress_migration,
})

// --- Local backup service (auto schedule default ON; no S3 by design) ---
const backupService = new BackupService({
  dataDir,
  projectRoot: cfg.paths.project,
  configDir: path.dirname(routingConfigPath),
})
backupService.onRestored((db) => {
  // A restore swaps the DatabaseSync instance and routing files. Rebuild every
  // holder before reporting success; otherwise requests keep stale snapshots
  // or silently write through statements owned by the closed connection.
  for (const store of [apiKeyStore, apiEndpointStore, panelUsers, accountQuota, stickyRouter, proxyPool, requestLog]) {
    store.rebind(db)
  }
  groupsRepo = new GroupsRepo(db)
  apiScheduler.reload(apiEndpointStore.listRaw())

  routingConfig = loadRoutingConfig()
  setManualScheduleWins(routingConfig.pool?.manual_schedule_wins)
  if (routingConfig.official_cc) {
    routingConfig.official_cc = normalizeOfficialCcConfig(routingConfig.official_cc)
  }
  routingConfig.health_probe = normalizeHealthProbeConfig(routingConfig.health_probe)
  routingConfig.usage_probe = normalizeUsageProbeConfig(routingConfig.usage_probe)
  routingConfig.notify = normalizeNotifyConfig(routingConfig.notify)
  routingConfig.tiers = normalizeTiers(routingConfig.tiers, routingConfig.quota, routingConfig.concurrency)
  syncTierDefaultsIntoRouting()

  stickyRouter.reloadConfig(routingConfig)
  accountQuota.reloadConfig(routingConfig)
  requestLog.setConfig({
    mode: process.env.KIN_REQUEST_LOG_MODE || routingConfig.logging?.mode,
    retainDays: routingConfig.logging?.retain_days,
    debugRetainDays: routingConfig.logging?.debug_retain_days,
    maxMb: routingConfig.logging?.max_mb,
    mutedErrorClasses: routingConfig.logging?.muted_error_classes,
  })
  healthMonitor?.setConfig(routingConfig.health_probe)
  credentialRefreshMonitor?.setConfig(normalizeCredentialRefreshConfig(routingConfig.credential_refresh))
  kernelWatchdog?.setConfig(normalizeKernelWatchdogConfig(routingConfig.kernel_watchdog))
  usageProbeMonitor?.setConfig(routingConfig.usage_probe)
  notifyMonitor?.setConfig(routingConfig.notify)
  egressMigrationMonitor?.setConfig(routingConfig.egress_migration)

  initPoolRuntime()
  reloadActiveVm(cfg)
})
backupService.startScheduler()

const stats = {
  requests: 0,
  passthrough: 0,
  convert: 0,
  rewrite: 0,
  stream: 0,
  errors: 0,
  by_route: {},
}

function credentialRefreshClass(result) {
  return classifyCredentialRefresh(result)
}

function publicCredentialRefreshResult(vmId, result, { force = false } = {}) {
  const refreshClass = credentialRefreshClass(result)
  const credential = result?.credential || {}
  const out = {
    ok: !!result?.ok,
    vm_id: vmId,
    refresh_owner: 'go-slot-worker',
    proxy_required: true,
    force: !!force,
    refreshed: !!result?.refreshed,
    shared: !!result?.shared,
    refresh_class: refreshClass,
    credential: {
      has_access: !!credential.has_access,
      has_refresh: !!credential.has_refresh,
      needs_refresh: !!credential.needs_refresh,
      expires_at: credential.expires_at ?? null,
      ttl_seconds: credential.ttl_seconds ?? null,
      generation: credential.generation ?? null,
    },
  }
  if (!result?.ok) {
    out.error = {
      code: result?.error?.code || 'credential_refresh_failed',
      message:
        refreshClass === 'fatal'
          ? 'OAuth credential was rejected'
          : refreshClass === 'retryable'
            ? 'OAuth credential refresh is temporarily unavailable'
            : 'OAuth credential refresh failed',
    }
  }
  return out
}

async function refreshWorkerCredentialForVm({ vmId, vmPath, homeDir, vm, force = false }) {
  // Host RefreshIfNeeded is the credential writer. Slot workers only read AT.
  const result = await ensureWorkerCredential({ vmId, vm, homeDir }, { force: !!force })

  const published = publicCredentialRefreshResult(vmId, result, { force })
  if (result.ok) {
    try {
      mirrorWorkerCredentialsToVm(vmPath, homeDir, { acceptLiveGrant: true })
    } catch {}
    try {
      invalidateLiveCredentialCache()
    } catch {}
    try {
      const accountId = vm?.claude?.account_uuid || vmId
      accountQuota.clearGrantRevokeLeftover(accountId)
      poolScheduler?.clearAuthCooldownFor?.(vmId, accountId)
      poolScheduler?.clearGrantRevokeCooldownFor?.(vmId, accountId)
    } catch {}
  } else if (published.refresh_class !== 'retryable') {
    try {
      markVmRefreshError(vmPath, result)
    } catch {}
    try {
      invalidateLiveCredentialCache()
    } catch {}
  }
  return published
}

const { json, writeSSEHeaders, readBody } = createRespond(cfg, {
  tcpNodelay: () => routingConfig?.inference?.tcp_nodelay !== false,
})

function rejectAuth(req, res, error) {
  req.authError = {
    code: error?.body?.error?.code || ErrorCode.INVALID_API_KEY,
    message: error?.body?.error?.message || 'Invalid credentials',
    status: error?.status || 401,
  }
  json(res, error.status, error.body)
  return false
}

function requireAuth(req, res) {
  req.presentedApiKey = extractApiKey(req)
  const token = extractPanelToken(req) || req.presentedApiKey
  if (!token) {
    return rejectAuth(
      req,
      res,
      makeError({
        type: ErrorType.AUTH,
        code: ErrorCode.MISSING_API_KEY,
        message: 'Missing credentials. Login at /api/panel/login or provide Authorization Bearer token.',
        status: 401,
      }),
    )
  }
  // Panel session
  const session = verifyPanelSession(token)
  if (session) {
    if (!allowRate('panel:' + session.user)) {
      return rejectAuth(
        req,
        res,
        makeError({
          type: ErrorType.RATE_LIMIT,
          code: ErrorCode.GATEWAY_RATE_LIMIT,
          message: 'Gateway rate limit exceeded. Retry later.',
          status: 429,
        }),
      )
    }
    req.panelUser = session.user
    req.panelRole = session.role || panelUsers.getByUsername(session.user)?.role || 'user'
    const rec = panelUsers.getByUsername(session.user)
    req.panelUserId = rec?.id || null
    req.panelVmCreateQuota = rec?.vm_create_quota ?? 0
    return true
  }
  // Master env API key — unlimited admin
  if (timingSafeEqualStr(token, cfg.api_key)) {
    if (!allowRate(token)) {
      return rejectAuth(
        req,
        res,
        makeError({
          type: ErrorType.RATE_LIMIT,
          code: ErrorCode.GATEWAY_RATE_LIMIT,
          message: 'Gateway rate limit exceeded. Retry later.',
          status: 429,
        }),
      )
    }
    req.apiKeyKind = 'master'
    req.panelRole = 'admin'
    req.panelUser = 'master'
    return true
  }

  // Managed multi-keys (sub2api-style)
  const managed = apiKeyStore.authenticate(token)
  if (!managed.ok) {
    return rejectAuth(
      req,
      res,
      makeError({
        type: ErrorType.AUTH,
        code: ErrorCode.INVALID_API_KEY,
        message: 'Invalid credentials',
        status: 401,
      }),
    )
  }
  const gate = apiKeyStore.canAccept(managed.record)
  if (!gate.ok) {
    const type =
      gate.status === 429
        ? gate.code.includes('quota')
          ? ErrorType.QUOTA
          : ErrorType.RATE_LIMIT
        : ErrorType.PERMISSION
    return rejectAuth(
      req,
      res,
      makeError({
        type,
        code: gate.code,
        message: gate.message,
        status: gate.status,
        details: gate.detail || undefined,
      }),
    )
  }
  if (!allowRate(token)) {
    return rejectAuth(
      req,
      res,
      makeError({
        type: ErrorType.RATE_LIMIT,
        code: ErrorCode.GATEWAY_RATE_LIMIT,
        message: 'Gateway rate limit exceeded. Retry later.',
        status: 429,
      }),
    )
  }
  req.apiKeyKind = 'managed'
  req.apiKeyRecord = managed.record
  return true
}

function fetchWorkerModels() {
  return gatewayModelCatalog()
}

const importCommit = createImportCommit({
  cfg,
  routingConfigPath,
  getRoutingConfig: () => routingConfig,
  get routingConfig() {
    return routingConfig
  },
  get accountQuota() {
    return accountQuota
  },
  get poolScheduler() {
    return poolScheduler
  },
  get proxyPool() {
    return proxyPool
  },
  applyVmConcurrency,
})

const { commitImportedOauth, requireSlotProxy, officialCcStatsHandler } = importCommit

const { handleProtocol } = createHandleProtocol({
  json,
  writeSSEHeaders,
  readBody,
  requireAuth,
  cfg,
  requestLog,
  stickyRouter,
  accountQuota,
  apiKeyStore,
  apiScheduler,
  apiEndpointStore,
  stats,
  routingConfigPath,
  getRoutingConfig: () => routingConfig,
  get routingConfig() {
    return routingConfig
  },
  getHealthMonitor: () => healthMonitor,
  get healthMonitor() {
    return healthMonitor
  },
  getFailoverRunner: () => failoverRunner,
  get failoverRunner() {
    return failoverRunner
  },
  getPoolScheduler: () => poolScheduler,
  get poolScheduler() {
    return poolScheduler
  },
  get groupsRepo() {
    return groupsRepo
  },
})

const handlePanel = createPanelHandler({
  json,
  readBody,
  requireAuth,
  cfg,
  routingConfigPath,
  get routingConfig() {
    return routingConfig
  },
  set routingConfig(v) {
    routingConfig = v
  },
  stickyRouter,
  accountQuota,
  get poolScheduler() {
    return poolScheduler
  },
  get healthMonitor() {
    return healthMonitor
  },
  get usageProbeMonitor() {
    return usageProbeMonitor
  },
  get notifyMonitor() {
    return notifyMonitor
  },
  get runtimeRepo() {
    return runtimeRepo
  },
  get groupsRepo() {
    return groupsRepo
  },
  getAttemptsRepo: () => attemptsRepo,
  get attemptsRepo() {
    return attemptsRepo
  },
  get proxyPool() {
    return proxyPool
  },
  apiKeyStore,
  apiEndpointStore,
  apiScheduler,
  panelUsers,
  requestLog,
  backupService,
  stats,
  persistRoutingPatch,
  applyVmConcurrency,
  applyVmRpm,
  initPoolRuntime,
  poolSchedulerConfig,
  commitImportedOauth,
  requireSlotProxy,
  officialCcStatsHandler,
  refreshWorkerCredentialForVm,
  fetchWorkerModels,
})

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers':
          'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-session-id, x-kin-rewrite, x-panel-token, x-kin-vm, x-kin-backend',
        'access-control-allow-methods': 'GET,POST,OPTIONS,PUT,DELETE',
      })
      return res.end()
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    // 反代挂在前缀下（例如 nginx 的 /vm2api/ → 本机 8787）时，控制台与它的静态资源
    // 都带前缀进来。在这里剥掉一次，后面的路由就能照旧按 /console、/assets、/api 匹配 ——
    // 不用给每个 handler 都加一遍前缀。
    const p = stripBasePath(url.pathname, BASE_PATH)

    if (isTelemetryPath(p)) {
      return json(res, 200, telemetryInterceptResponse(p))
    }

    if (
      backupService.isRestoring &&
      (p.startsWith('/v1/') || p === '/messages' || p === '/chat/completions' || p === '/responses')
    ) {
      return json(
        res,
        503,
        makeError({
          type: ErrorType.OVERLOADED,
          code: 'restore_in_progress',
          message: 'Gateway is restoring from backup; retry shortly',
          status: 503,
        }).body,
      )
    }

    if (p.startsWith('/admin') || p.startsWith('/api/panel')) {
      const handled = await handlePanel(req, res, url)
      if (handled !== false) return
    }

    // ---- 支付回调（公开，靠签名而不是靠鉴权）----
    // 网关会重投，用户也会刷新 return URL，所以这里必须幂等：入账只发生一次。
    if (req.method === 'POST' && p === '/api/payment/notify/easypay') {
      const config = new PaymentConfigStore().get()
      const key = config.channels.easypay.key
      let params = {}
      try {
        const raw = await readRawBody(req, 64 * 1024)
        params = Object.fromEntries(new URLSearchParams(raw))
      } catch {
        return json(res, 400, { error: { message: 'bad body', code: 'bad_body' } })
      }
      if (!config.enabled || !config.channels.easypay.enabled || !key) {
        return json(res, 503, { error: { message: 'easypay not configured', code: 'channel_unavailable' } })
      }
      const verified = verifyEasypay(params, key)
      if (!verified.ok) {
        console.warn('[payment] easypay callback rejected:', verified.reason)
        // 不要回 success：回执决定网关是否重投，签名不对就不该被确认。
        return json(res, 400, { error: { message: verified.reason, code: verified.reason } })
      }
      if (!easypayTradeSuccess(params)) {
        // 未支付状态的回调要明确确认，否则会被无限重投。
        res.writeHead(200, { 'content-type': 'text/plain' })
        return res.end(EASYPAY_ACK)
      }
      const settled = new OrderService().markPaid({
        orderNo: params.out_trade_no,
        providerTradeNo: params.trade_no || null,
        paidAmount: params.money,
        raw: JSON.stringify({ ...params, sign: '[redacted]' }),
      })
      if (!settled.ok && !settled.alreadyPaid) {
        console.warn('[payment] easypay settle failed:', settled.reason)
        return json(res, 400, { error: { message: settled.reason, code: settled.reason } })
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end(EASYPAY_ACK)
    }

    if (req.method === 'POST' && p === '/api/payment/webhook/stripe') {
      const config = new PaymentConfigStore().get()
      const secret = config.channels.stripe.webhook_secret
      let raw = ''
      try {
        raw = await readRawBody(req, 256 * 1024)
      } catch {
        return json(res, 400, { error: { message: 'bad body', code: 'bad_body' } })
      }
      if (!config.enabled || !config.channels.stripe.enabled || !secret) {
        return json(res, 503, { error: { message: 'stripe not configured', code: 'channel_unavailable' } })
      }
      const verified = verifyStripeSignature(raw, req.headers['stripe-signature'], secret)
      if (!verified.ok) {
        console.warn('[payment] stripe webhook rejected:', verified.reason)
        return json(res, 400, { error: { message: verified.reason, code: verified.reason } })
      }
      let event = null
      try {
        event = JSON.parse(raw)
      } catch {
        return json(res, 400, { error: { message: 'bad json', code: 'bad_json' } })
      }
      if (event?.type === 'checkout.session.completed') {
        const session = event.data?.object || {}
        const settled = new OrderService().markPaid({
          orderNo: session.client_reference_id || session.metadata?.order_no,
          providerTradeNo: session.payment_intent || session.id || null,
          paidAmount: session.amount_total == null ? null : Number(session.amount_total) / 100,
          raw: JSON.stringify({ id: event.id, type: event.type }),
        })
        if (!settled.ok && !settled.alreadyPaid) {
          console.warn('[payment] stripe settle failed:', settled.reason)
          return json(res, 400, { error: { message: settled.reason, code: settled.reason } })
        }
      }
      return json(res, 200, { received: true })
    }

    if (req.method === 'GET' && tryServeWebDist(res, cfg.paths.project, p)) return
    if (req.method === 'GET' && (p === '/console' || p === '/console/')) {
      return json(res, 404, { error: { message: 'console not found; run pnpm -C web build' } })
    }

    if (req.method === 'GET' && (p === '/' || p === '/health')) {
      return json(res, 200, {
        status: 'ok',
        service: 'vm2api',
        base_url: cfg.base_url,
        rewrite: cfg.rewrite.enabled ? 'on' : 'off',
        intercept_rules: cfg.intercept.rules.length,
        active_vm: getActiveVmId(cfg.paths.project),
        features: FEATURES,
        capabilities: GATEWAY_CAPABILITIES,
        limitations: LIMITATIONS,
        stats,
        health_probe: healthMonitor?.getSnapshot?.() || null,
        api_kernel: {
          ...apiKernelSnapshot(cfg),
          endpoints: apiEndpointStore.listRaw().filter((ep) => !ep.disabled).length,
        },
      })
    }

    if (req.method === 'GET' && p === '/v1/meta') {
      return json(res, 200, {
        base_url: cfg.base_url,
        rewrite_default: cfg.rewrite.enabled,
        features: FEATURES,
        capabilities: GATEWAY_CAPABILITIES,
        limitations: LIMITATIONS,
        endpoints: {
          chat_completions: '/v1/chat/completions',
          responses: '/v1/responses',
          messages: '/v1/messages',
          count_tokens: '/v1/messages/count_tokens',
          usage: '/v1/usage',
          models: '/v1/models',
          intercept_rules: '/admin/intercept/rules',
        },
        vm: { id: cfg.vm.id, email: cfg.vm.email },
      })
    }

    if (req.method === 'GET' && p === '/v1/models') {
      if (!requireAuth(req, res)) return
      if (resolveInferenceBackend(req) === 'api') {
        return json(res, 200, apiScheduler.catalog())
      }
      const result = await fetchWorkerModels()
      return json(res, 200, result)
    }
    if (req.method === 'POST' && p === '/admin/models/refresh') {
      if (!requireAuth(req, res)) return
      const result = await fetchWorkerModels()
      return json(res, 200, result)
    }
    if (req.method === 'GET' && p === '/v1/usage') {
      return await handleUserUsage(req, res, {
        json,
        requireAuth,
        stickyRouter,
        accountQuota,
        getPoolScheduler: () => poolScheduler,
      })
    }
    if (req.method === 'POST' && (p === '/v1/messages/count_tokens' || p === '/messages/count_tokens')) {
      return await handleUserCountTokens(req, res, {
        json,
        readBody,
        requireAuth,
        cfg,
        stickyRouter,
        accountQuota,
        getPoolScheduler: () => poolScheduler,
      })
    }

    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions')) {
      return await handleProtocol(req, res, 'openai.chat', p)
    }
    if (req.method === 'POST' && (p === '/v1/completions' || p === '/completions')) {
      return await handleProtocol(req, res, 'openai.completions', p)
    }
    if (req.method === 'POST' && (p === '/v1/responses' || p === '/responses')) {
      return await handleProtocol(req, res, 'openai.responses', p)
    }
    if (req.method === 'POST' && (p === '/v1/messages' || p === '/messages')) {
      return await handleProtocol(req, res, 'anthropic.messages', p)
    }

    json(res, 404, { error: { message: `not found: ${p}` } })
  } catch (e) {
    stats.errors++
    const status = e.status || 500
    if (!res.headersSent) {
      json(res, status, { error: { message: e.message || String(e), type: 'server_error' } })
    } else {
      try {
        res.end()
      } catch {}
    }
  }
})

server.on('clientError', (err, socket) => {
  try {
    console.error(
      JSON.stringify({
        event: 'http_client_error',
        code: err?.code || null,
        message: String(err?.message || err).slice(0, 200),
      }),
    )
  } catch {}
  if (!socket || !socket.writable) {
    try {
      socket?.destroy()
    } catch {}
    return
  }
  socket.end(
    'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"error":{"type":"invalid_request_error","message":"malformed request"}}\n',
  )
})

const pub = {
  base_url: cfg.base_url,
  api_key_set: !!cfg.api_key,
  rewrite_default: false,
  vm_id: cfg.vm.id,
  version: '2.1',
  features: FEATURES,
  capabilities: GATEWAY_CAPABILITIES,
  limitations: LIMITATIONS,
  endpoints: {
    health: `${cfg.base_url}/health`,
    chat: `${cfg.base_url}/v1/chat/completions`,
    responses: `${cfg.base_url}/v1/responses`,
    messages: `${cfg.base_url}/v1/messages`,
    count_tokens: `${cfg.base_url}/v1/messages/count_tokens`,
    usage: `${cfg.base_url}/v1/usage`,
    intercept_rules: `${cfg.base_url}/admin/intercept/rules`,
  },
}
// Never persist the raw API key. Public snapshot only.
fs.writeFileSync(path.join(cfg.paths.root, 'config', 'gateway-v2.public.json'), JSON.stringify(pub, null, 2))

process.on('uncaughtException', (e) => console.error('[uncaught]', e))
process.on('unhandledRejection', (e) => console.error('[unhandled]', e))

// Graceful shutdown: stop schedulers/watchers, close the DB (WAL checkpoint).
let _shuttingDown = false
function shutdown(signal) {
  if (_shuttingDown) return
  _shuttingDown = true
  console.log(`[shutdown] ${signal} — closing`)
  try {
    backupService.stopScheduler()
  } catch {}
  try {
    proxyPool.stopScheduler()
  } catch {}
  try {
    healthMonitor?.stop?.()
  } catch {}
  try {
    credentialRefreshMonitor?.stop?.()
  } catch {}
  try {
    kernelWatchdog?.stop?.()
  } catch {}
  try {
    usageProbeMonitor?.stop?.()
  } catch {}

  try {
    notifyMonitor?.stop?.()
  } catch {}
  try {
    stopVmWatch()
  } catch {}
  try {
    stopAllRustKernels()
  } catch {}
  try {
    server.close(() => {})
  } catch {}
  try {
    closeDatabase()
  } catch {}
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

server.listen(cfg.port, cfg.host, () => {
  try {
    healthMonitor?.start?.({ immediate: true })
  } catch (e) {
    console.warn('[health-probe] start failed', e?.message || e)
  }
  try {
    credentialRefreshMonitor?.start?.({ immediate: true })
  } catch (e) {
    console.warn('[credential-refresh] start failed', e?.message || e)
  }
  try {
    kernelWatchdog?.start?.({ immediate: true })
  } catch (e) {
    console.warn('[kernel-watchdog] start failed', e?.message || e)
  }

  try {
    usageProbeMonitor?.start?.({ immediate: true })
  } catch (e) {
    console.warn('[usage-probe] start failed', e?.message || e)
  }
  try {
    notifyMonitor?.start?.({ immediate: true })
  } catch (e) {
    console.warn('[notify] start failed', e?.message || e)
  }
  try {
    egressMigrationMonitor?.start?.({ immediate: true })
  } catch (e) {
    console.warn('[egress-migration] start failed', e?.message || e)
  }
  const addr = server.address()
  const boundPort = typeof addr === 'object' && addr ? addr.port : cfg.port
  try {
    const catalog = fetchWorkerModels()
    console.log(
      JSON.stringify({
        event: 'go-worker-model-catalog',
        source: catalog.source,
        total: Array.isArray(catalog.data) ? catalog.data.length : 0,
        vm_id: catalog.vm_id || null,
      }),
    )
  } catch (error) {
    console.warn('[worker-models] fetch failed', error.message)
  }
  console.log(
    JSON.stringify({
      event: 'vm2api-started',
      port: boundPort,
      base_url: cfg.base_url,
      active_vm: getActiveVmId(cfg.paths.project),
      features: pub.features,
      capabilities: GATEWAY_CAPABILITIES,
      rewrite: cfg.rewrite.enabled,
    }),
  )
})
