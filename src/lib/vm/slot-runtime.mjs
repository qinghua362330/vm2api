/**
 * Host-side slot lifecycle. Docker is implemented; KVM is a same-shaped
 * adapter that refuses until a hypervisor is wired. Guest identity / SOCKS
 * / TLS stay inside kin-worker and must not branch here.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ensureRustKernel,
  kernelBinPath,
  restartRustKernel,
  writeKernelConfig,
} from '../transport/rust-kernel-supervisor.mjs'
import { ensureCodexKernel, stopCodexKernel, writeCodexKernelConfig } from '../transport/codex-kernel-supervisor.mjs'
import { workerHealth } from '../transport/go-worker-client.mjs'
import { runtimeKind, RUNTIME_KVM } from './runtime-kind.mjs'
import { getVm, listVms, isCodexVm } from './vm-registry.mjs'
import { resolveInferenceEngine } from './slot-engine.mjs'
import {
  containerHasKernelMount,
  containerName,
  inspectContainer,
  startVmRuntime,
  stopVmRuntime,
  reloadSlotWorker,
  destroyVmRuntime,
} from './vm-runtime.mjs'
import { inspectWrapCliDir, materializeWrapCli, wrapCliHomeDir } from './wrap-cli-runtime.mjs'
import { boundProxyUrl } from './egress.mjs'
import { imageForKernel } from './vm-runtime.mjs'
import {
  destroyCodexSlotRuntime,
  inspectCodexContainer,
  preflightCodexSlot,
  startCodexSlotRuntime,
  stopCodexSlotRuntime,
  codexContainerName,
} from './codex-runtime.mjs'
import { codexBinPath } from '../transport/codex-cli-client.mjs'

export { runtimeKind }

const KVM_NOT_CONFIGURED = {
  ok: false,
  code: 'kvm_not_configured',
  error: 'kvm runtime adapter is not configured',
}

function kvmRefuse(action) {
  return { ...KVM_NOT_CONFIGURED, action, runtime: RUNTIME_KVM }
}

/**
 * 起槽。codex 槽和 Claude 槽现在是同形的一条链：都是 kin-os 容器、同样的机器身份与
 * 资源限制、都走槽自己的 SOCKS 网络，只是容器里装的东西不同（Claude 挂 cli-home 并
 * 常驻 kin-kernel；codex 挂 codex-home 与 codex 二进制，待命等驱动 exec 进来）。
 */
export function startSlot(vm, projectRoot, opts = {}) {
  if (runtimeKind(vm) === RUNTIME_KVM) return kvmRefuse('start')
  if (isCodexVm(vm)) {
    const image = opts.image || imageForKernel(vm.kernel || 'ubuntu-24.04')
    return startCodexSlotRuntime(vm, projectRoot, {
      image,
      codexBin: codexBinPath({ projectRoot }),
      shImpl: opts.ops?.sh,
      inspectImpl: opts.ops?.inspectCodexContainer,
      limits: opts.limits,
    })
  }
  return startVmRuntime(vm, projectRoot, opts)
}

export async function startSlotReady(vm, projectRoot, opts = {}) {
  if (isCodexVm(vm)) {
    const boot = startSlot(vm, projectRoot, opts)
    const kernel = await ensureSlotInferenceRuntime(vm, projectRoot, opts)
    if (!kernel.ok) return kernel
    return { ok: true, engine: 'codex', docker: boot, kernel }
  }
  const boot = startSlot(vm, projectRoot, opts)
  if (!boot?.ok) return boot
  return attachInferenceRuntime(boot, vm, projectRoot, opts)
}

export function stopSlot(vm, opts = {}) {
  if (isCodexVm(vm)) {
    stopCodexKernel(vm.id)
    if (runtimeKind(vm) === RUNTIME_KVM) return kvmRefuse('stop')
    return stopCodexSlotRuntime(vm, { shImpl: opts.ops?.sh })
  }
  if (runtimeKind(vm) === RUNTIME_KVM) return kvmRefuse('stop')
  return stopVmRuntime(vm)
}

/** Destroy the slot container. Used only by explicit reset / delete. */
export function destroySlot(vm, opts = {}) {
  if (runtimeKind(vm) === RUNTIME_KVM) return kvmRefuse('destroy')
  if (isCodexVm(vm)) return destroyCodexSlotRuntime(vm, { shImpl: opts.ops?.sh })
  return destroyVmRuntime(vm)
}

/** Reload guest worker so a new bind-mounted / virtiofs binary is picked up. Never docker rm. */
export function reloadSlot(vm, projectRoot) {
  if (runtimeKind(vm) === RUNTIME_KVM) return kvmRefuse('reload')
  return reloadSlotWorker(vm, projectRoot)
}

export async function reloadSlotReady(vm, projectRoot, opts = {}) {
  const boot = reloadSlot(vm, projectRoot)
  if (!boot?.ok) return boot
  return attachInferenceRuntime(boot, vm, projectRoot, opts)
}

/**
 * After Docker start/reload: if this slot resolves to rust and eager_start
 * is on, launch kin-kernel inside the container. Go-only slots skip.
 * Empty unused slots inherit rust from routing but must not bind a CONNECT
 * bridge or kernel.sock — that fights live wrap slots on host network.
 */
function slotHasCredential(vm, projectRoot) {
  if (vm?.has_token || vm?.claude?.has_access) return true
  if (!projectRoot || !vm?.id) return false
  const cred = path.join(projectRoot, 'vms', vm.id, 'cli-home', '.claude', 'credentials.json')
  try {
    return fs.statSync(cred).size > 8
  } catch {
    return false
  }
}

function wrapUsesSlotKernel(wrap) {
  return wrap?.ok === true && (wrap.glibc_shim === true || wrap.wrapper === true || wrap.kernel_bin === true)
}

export async function ensureSlotInferenceRuntime(vm, projectRoot, opts = {}) {
  const routing = opts.routing || {}
  const eager = routing?.inference?.eager_start !== false
  if (isCodexVm(vm)) {
    if (!eager) return { ok: true, skipped: true, reason: 'eager_start_off', engine: 'codex' }
    const write = opts.ops?.writeCodexKernelConfig || writeCodexKernelConfig
    const start = opts.ops?.ensureCodexKernel || ensureCodexKernel
    // 容器在跑就按容器坐标写配置、把 kernel 起在容器里（与 Claude 的 kernel 同构）；
    // 没有容器才回退宿主进程。
    const container = codexContainerInUse(vm, opts.ops)
    write(projectRoot, vm, {
      proxyUrl: boundProxyUrl(vm?.proxy),
      proxyRequired: true,
      inContainer: !!container,
    })
    const kernel = await start(slotExec(projectRoot, vm), {
      timeoutMs: opts.timeoutMs,
      container,
      ops: opts.ops,
    })
    if (!kernel?.ok) {
      return {
        ok: false,
        code: kernel?.reason || 'codex_kernel_start_failed',
        error: kernel?.error || kernel?.reason || 'Codex kernel failed to start',
        engine: 'codex',
        kernel,
      }
    }
    return { ok: true, engine: 'codex', kernel }
  }
  if (!eager) return { ok: true, skipped: true, reason: 'eager_start_off' }
  const engine = resolveInferenceEngine(vm, routing)
  if (engine !== 'rust') return { ok: true, skipped: true, reason: 'engine_go', engine: 'go' }
  if (!slotHasCredential(vm, projectRoot)) {
    return { ok: true, skipped: true, reason: 'no_credential', engine: 'rust' }
  }
  if (runtimeKind(vm) === RUNTIME_KVM) return kvmRefuse('ensure-rust')
  const dest = wrapCliHomeDir(projectRoot, vm.id)
  let wrap = inspectWrapCliDir(dest)
  if (!wrap?.ok) {
    wrap = (opts.ops?.materializeWrapCli || materializeWrapCli)(projectRoot, vm)
  }
  if (!wrap?.ok) {
    return {
      ok: false,
      code: wrap?.code || 'wrap_cli_missing',
      error: wrap?.error || 'wrap CLI is not installed in the slot home',
    }
  }

  const slotKernel = wrapUsesSlotKernel(wrap)
  if (!slotKernel) {
    const kernelBin = (opts.ops?.kernelBinPath || kernelBinPath)()
    const binaryError = kernelBinaryError(kernelBin)
    if (binaryError) return binaryError
    const name = containerName(vm.id)
    const hasMount = (opts.ops?.containerHasKernelMount || containerHasKernelMount)(name)
    if (!hasMount) {
      return {
        ok: false,
        code: 'kernel_mount_missing',
        error: 'Rust kernel binary is not mounted in the slot container',
      }
    }
  }

  const exec = slotExec(projectRoot, vm)
  const start = opts.ops?.ensureRustKernel || ensureRustKernel
  const rust = await start(exec, { timeoutMs: opts.timeoutMs })
  if (!rust?.ok) {
    return {
      ok: false,
      code: rust?.reason === 'health_timeout' ? 'kernel_health_timeout' : 'kernel_start_failed',
      error: rust?.error || rust?.reason || 'Rust kernel failed to start',
      rust,
    }
  }
  return { ok: true, engine: 'rust', rust }
}

async function attachInferenceRuntime(boot, vm, projectRoot, opts = {}) {
  const rust = await ensureSlotInferenceRuntime(vm, projectRoot, opts)
  const engine = resolveInferenceEngine(vm, opts.routing || {})
  if (vm.runtime && typeof vm.runtime === 'object') vm.runtime.worker = engine
  return {
    ...boot,
    rust,
    rust_ok: rust?.ok !== false || rust?.skipped === true,
  }
}

/**
 * 这个 codex 槽此刻该按容器模式处理吗：容器存在且在跑才算。
 * `opts.ops.inspectCodexContainer` 供测试注入。
 */
export function codexContainerInUse(vm, ops = {}) {
  const name = String(vm?.runtime?.container || codexContainerName(vm?.id) || '').trim()
  if (!name) return null
  const inspect = ops?.inspectCodexContainer || inspectCodexContainer
  try {
    return inspect(name)?.running ? name : null
  } catch {
    return null
  }
}

/**
 * 槽的宿主侧坐标。
 *
 * `homeDir` 必须按凭证类型给：codex 槽没有 `cli-home`，它的 home 是 `codex-home`
 * （容器里 `CODEX_HOME=/home/kincli/.codex`）。以前这里一律拼 `cli-home`，于是
 * codex 槽的 runDir 落成 `vms/<id>/run`，所有 Claude 形状的探针（worker health、
 * 身份采集、额度探测）都去连一个按设计不存在的 `worker.sock`，报出来是一句裸的
 * `connect ENOENT /opt/vm2api/vms/<id>/run/worker.sock` —— 看着像文件丢了，
 * 其实是"拿错协议问错了槽"。`kind` 让调用方能一眼判断该不该走这条路。
 */
export function slotExec(projectRoot, vm) {
  if (!projectRoot || !vm?.id) return null
  const codex = isCodexVm(vm)
  return {
    vmId: vm.id,
    accountId: vm.claude?.account_uuid || vm.id,
    vm,
    vmPath: path.join(projectRoot, 'vms', `${vm.id}.json`),
    kind: codex ? 'codex' : 'claude',
    homeDir: path.join(projectRoot, 'vms', vm.id, codex ? 'codex-home' : 'cli-home'),
    timezone: vm.timezone || 'UTC',
    locale: vm.locale || 'en_US.UTF-8',
    kernel: vm.kernel || null,
  }
}

function workerReachable(health) {
  return (
    health?.ok === true || Number(health?.status) === 200 || health?.worker_version != null || health?.version != null
  )
}

async function waitForGoWorker(exec, check, timeoutMs) {
  const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 8000)
  let health = null
  while (Date.now() < deadline) {
    health = await check(exec, { timeoutMs: 400 })
    if (workerReachable(health)) return { ok: true, health }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  return { ok: false, health }
}

function kernelBinaryError(bin) {
  if (!bin || !fs.existsSync(bin)) {
    return { ok: false, code: 'kernel_binary_missing', error: 'Rust kernel binary is not configured' }
  }
  try {
    fs.accessSync(bin, fs.constants.X_OK)
    return null
  } catch {
    return { ok: false, code: 'kernel_binary_not_executable', error: `Rust kernel binary is not executable: ${bin}` }
  }
}

/**
 * Reconcile one slot's actual in-container inference runtime. Persistence is
 * deliberately left to the caller so configuration is committed only after
 * the target runtime is healthy.
 */
export async function switchSlotInferenceEngine(vm, projectRoot, engine, { timeoutMs = 8000, ops = {} } = {}) {
  if (!vm?.id || !projectRoot) return { ok: false, code: 'vm_required', error: 'vm required' }
  if (isCodexVm(vm)) {
    return { ok: false, code: 'gpt_engine_forbidden', error: 'GPT slots do not use rust inference engines' }
  }
  if (engine === 'go') {
    return { ok: false, code: 'go_engine_disabled', error: 'Go HTTP forwarding is disabled' }
  }
  if (engine !== 'rust') {
    return { ok: false, code: 'invalid_inference_engine', error: 'inference engine must be rust' }
  }

  const inspect = ops.inspectContainer || inspectContainer
  const hasKernelMount = ops.containerHasKernelMount || containerHasKernelMount
  const start = ops.startVmRuntime || startVmRuntime
  const reload = ops.reloadSlotWorker || reloadSlotWorker
  const checkGo = ops.workerHealth || workerHealth
  const ensureRust = ops.ensureRustKernel || ensureRustKernel
  const kernelBin = (ops.kernelBinPath || kernelBinPath)()
  let wrap = null
  if (engine === 'rust') {
    wrap = (ops.materializeWrapCli || materializeWrapCli)(projectRoot, vm)
    if (!wrap?.ok) {
      return {
        ok: false,
        code: wrap?.code || 'wrap_cli_missing',
        error: wrap?.error || 'wrap CLI is not installed in the slot home',
      }
    }
    if (!wrapUsesSlotKernel(wrap)) {
      const binaryError = kernelBinaryError(kernelBin)
      if (binaryError) return binaryError
    }
    const writeConfig = ops.writeKernelConfig || writeKernelConfig
    writeConfig(projectRoot, vm, { routing: ops.routing })
  }

  const name = containerName(vm.id)
  const existing = inspect(name)
  const needsKernelMount = engine === 'rust' && !!existing && !hasKernelMount(name) && !wrapUsesSlotKernel(wrap)
  const boot = needsKernelMount ? start(vm, projectRoot, { recreate: true }) : reload(vm, projectRoot)
  if (!boot?.ok) {
    return {
      ok: false,
      code: needsKernelMount ? 'kernel_mount_failed' : 'vm_runtime_failed',
      error: boot?.error || 'slot runtime failed',
    }
  }
  if (engine === 'rust' && !hasKernelMount(name) && !wrapUsesSlotKernel(wrap)) {
    return { ok: false, code: 'kernel_mount_missing', error: 'Rust kernel binary is not mounted in the slot container' }
  }

  const exec = slotExec(projectRoot, vm)
  const go = await waitForGoWorker(exec, checkGo, timeoutMs)
  if (!go.ok) {
    return {
      ok: false,
      code: 'go_worker_health_timeout',
      error: go.health?.error || 'Go credential worker health timeout',
      runtime: { go: { reachable: false, health: go.health || null } },
    }
  }
  const startRust = wrapUsesSlotKernel(wrap) ? ops.restartRustKernel || restartRustKernel : ensureRust
  const rust = await startRust(exec, { timeoutMs })
  if (!rust?.ok) {
    const code = rust?.reason === 'health_timeout' ? 'kernel_health_timeout' : 'kernel_start_failed'
    const rollback = reload(vm, projectRoot)
    return {
      ok: false,
      code,
      error: rust?.error || rust?.reason || 'Rust kernel failed to start',
      rollback,
      runtime: {
        go: { reachable: true, health: go.health },
        rust: { reachable: false, health: rust?.health || null },
      },
    }
  }
  return {
    ok: true,
    active_engine: 'rust',
    action: boot.action,
    runtime: {
      go: { reachable: true, health: go.health },
      rust: { reachable: true, health: rust.health || null },
    },
  }
}

async function rollbackInferenceEngines(switched, projectRoot, engine, switchEngine) {
  const rollbacks = []
  for (let i = switched.length - 1; i >= 0; i -= 1) {
    const item = switched[i]
    rollbacks.push({ id: item.vm.id, result: await switchEngine(item.vm, projectRoot, engine) })
  }
  return rollbacks
}

/** Switch only VMs that inherit the global inference engine. */
export async function switchInheritedInferenceEngines({
  projectRoot,
  previousEngine,
  targetEngine,
  switchEngine = switchSlotInferenceEngine,
  commit = null,
}) {
  const inherited = listVms(projectRoot)
    .map(({ id }) => getVm(projectRoot, id))
    .filter((vm) => vm && !isCodexVm(vm) && !Object.prototype.hasOwnProperty.call(vm, 'inference_engine'))
  const switched = []
  for (const vm of inherited) {
    const result = await switchEngine(vm, projectRoot, targetEngine)
    if (result.ok) {
      switched.push({ vm, result })
      continue
    }
    return {
      ok: false,
      changed: true,
      code: result.code || 'default_engine_switch_failed',
      error: result.error || `failed to switch ${vm.id} to ${targetEngine}`,
      failed_vm: vm.id,
      rollbacks: await rollbackInferenceEngines(switched, projectRoot, previousEngine, switchEngine),
    }
  }
  const runtime = {
    ok: true,
    changed: true,
    previous_engine: previousEngine,
    target_engine: targetEngine,
    items: switched.map(({ vm, result }) => ({ id: vm.id, active_engine: result.active_engine })),
  }
  if (!commit) return runtime
  try {
    return { ...runtime, applied: await commit() }
  } catch (error) {
    return {
      ok: false,
      changed: true,
      code: 'routing_persist_failed',
      error: String(error?.message || error),
      rollbacks: await rollbackInferenceEngines(switched, projectRoot, previousEngine, switchEngine),
    }
  }
}
