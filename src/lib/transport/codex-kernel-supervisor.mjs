/**
 * Host-side Codex kernel lifecycle. Dedicated Codex VMs listen on
 * vms/<id>/run/codex-kernel.sock; Claude workers are never reused.
 */
import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { boundProxyUrl } from '../vm/egress.mjs'
import { SLOT_GID, chownForSlot, slotUidFor } from '../vm/slot-uid.mjs'
import { codexKernelHealth, codexKernelPaths } from './codex-kernel-client.mjs'

const starts = new Map()

function existingBin(candidate) {
  const bin = String(candidate || '').trim()
  if (!bin) return ''
  try {
    fs.accessSync(bin, fs.constants.X_OK)
    return bin
  } catch {
    return ''
  }
}

/** 容器内的固定路径：与 Claude 的 kernel 同构（config/socket 走 /run/kin 共享挂载）。 */
export const CODEX_KERNEL_BIN_IN_CONTAINER = '/usr/local/bin/kin-codex-kernel'
export const CODEX_KERNEL_CONFIG_IN_CONTAINER = '/run/kin/codex-kernel.json'
export const CODEX_KERNEL_SOCKET_IN_CONTAINER = '/run/kin/codex-kernel.sock'
export const CODEX_HOME_IN_CONTAINER = '/home/kincli/.codex'

export function codexKernelBinPath() {
  const env = existingBin(process.env.KIN_CODEX_KERNEL_BIN)
  if (env) return env
  const kernel = String(process.env.KIN_KERNEL_BIN || process.env.KIN_API_KERNEL_BIN || '').trim()
  if (kernel) {
    const sibling = existingBin(path.join(path.dirname(kernel), 'kin-codex-kernel'))
    if (sibling) return sibling
  }
  return existingBin(path.resolve('bin/kin-codex-kernel'))
}

/**
 * 写 codex kernel 的配置。
 *
 * `inContainer` 决定坐标：容器内的 kernel 看得到 `/run/kin`（= 宿主的 `vms/<id>/run`）
 * 与 `/home/kincli/.codex`（= 宿主的 `vms/<id>/codex-home`），所以路径要按容器视角写，
 * 代理也要留空 —— 槽的出口由容器所在的透明网络承担，容器里的 `127.0.0.1` 是它自己，
 * 拿宿主那串 `socks5h://127.0.0.1:port` 进去只会连到自己。Claude 的 kernel 配置也是
 * 这么写的（`proxy_url: ''`、`proxy_required: false`）。
 */
export function writeCodexKernelConfig(
  projectRoot,
  vm,
  { token, proxyUrl, proxyRequired, inContainer = false, ops = {} } = {},
) {
  if (!projectRoot || !vm?.id) return null
  const runDir = path.join(projectRoot, 'vms', vm.id, 'run')
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const socketPath = inContainer ? CODEX_KERNEL_SOCKET_IN_CONTAINER : path.join(runDir, 'codex-kernel.sock')
  const configPath = path.join(runDir, 'codex-kernel.json')
  const tokenPath = path.join(runDir, 'internal.token')
  const credentialPath = inContainer
    ? `${CODEX_HOME_IN_CONTAINER}/credentials.json`
    : path.join(projectRoot, 'vms', vm.id, 'codex-credentials.json')
  if (inContainer) {
    // kernel 要读的是它自己的 accounts 格式（不是 CLI 的 auth.json）；放进槽 home 里，
    // 与 Claude 侧把凭证放 cli-home/.claude 是同一个信任级别。
    try {
      const raw = fs.readFileSync(path.join(projectRoot, 'vms', vm.id, 'codex-credentials.json'), 'utf8')
      const home = path.join(projectRoot, 'vms', vm.id, 'codex-home')
      fs.mkdirSync(home, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(home, 'credentials.json'), raw, { mode: 0o600 })
    } catch {}
  }
  let secret = String(token || '').trim()
  if (!secret) {
    try {
      secret = fs.readFileSync(tokenPath, 'utf8').trim()
    } catch {}
  }
  if (!secret) secret = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(tokenPath, secret + '\n', { mode: 0o600 })
  const proxy = inContainer ? '' : String(proxyUrl || boundProxyUrl(vm?.proxy) || '').trim()
  const required = inContainer ? false : proxyRequired == null ? !!proxy : !!proxyRequired
  const deviceId = String(vm.device_id || vm.fingerprint?.device_id || vm.id).trim() || vm.id
  const config = {
    vm_id: vm.id,
    device_id: deviceId,
    socket_path: socketPath,
    credential_path: credentialPath,
    proxy_url: proxy,
    proxy_required: required,
    internal_token: secret,
    test_endpoints: process.env.KIN_CODEX_TEST_ENDPOINTS === '1',
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  if (inContainer) {
    // 容器里的 kernel 以槽的 uid 运行：宿主写的 config / token / 凭证必须交给它，
    // 否则它读到的是 Permission denied，而宿主侧只看到"内核起不来"。
    const chown = ops.chown || chownForSlot
    for (const file of [configPath, tokenPath, credentialPath]) {
      if (file) chown(file, vm)
    }
    chown(runDir, vm)
  }
  return { runDir, socketPath, configPath, credentialPath, tokenPath }
}

/**
 * 确保 codex kernel 在跑。
 *
 * 与 Claude 的 kernel 生命周期对齐：槽容器在跑就把 kernel 起在**容器里**
 * （`docker exec -d`，和 telemetry worker 一样的起法），配置与 socket 都走 `/run/kin`
 * 这个共享挂载 —— 于是 Node 侧的健康检查与请求完全不用改（同一条 socket 路径）。
 * 没有容器时才回退到宿主进程，老环境不至于因此不可用。
 */
export async function ensureCodexKernel(exec, { timeoutMs = 8000, container = null, ops = {} } = {}) {
  const paths = codexKernelPaths(exec)
  if (!paths.configPath) return { ok: false, reason: 'config_missing' }
  const spawnImpl = ops.spawn || spawn
  const live = await waitForHealth(exec, Math.min(800, Math.max(200, Number(timeoutMs) || 800)))
  if (live.ok) return { ok: true, reused: true, health: live.health }

  const target = String(container || '').trim()
  if (target) {
    const execImpl = ops.dockerExec || dockerExecDetached
    const started = execImpl(target, [CODEX_KERNEL_BIN_IN_CONTAINER, CODEX_KERNEL_CONFIG_IN_CONTAINER])
    if (!started.ok) {
      return {
        ok: false,
        reason: 'container_exec_failed',
        error: started.error || started.stderr || 'docker exec failed',
      }
    }
    const ready = await waitForHealth(exec, timeoutMs)
    if (!ready.ok) {
      // `docker exec -d` 把进程的输出丢掉了，只回一个 health_timeout 没法查。
      // 超时就前台再跑一次，把它真正报的错（缺配置 / 读不到凭证 / 端口占用）带回去。
      const probe = (ops.dockerProbe || dockerProbe)(target, [
        CODEX_KERNEL_BIN_IN_CONTAINER,
        CODEX_KERNEL_CONFIG_IN_CONTAINER,
      ])
      if (probe?.output) ready.error = probe.output
    }
    return { ...ready, started_in: 'container', container: target }
  }

  const bin = codexKernelBinPath()
  if (!bin) return { ok: false, reason: 'bin_missing' }
  const current = starts.get(exec.vmId)
  if (current && !current.killed) return waitForHealth(exec, timeoutMs)
  try {
    if (paths.socketPath) fs.unlinkSync(paths.socketPath)
  } catch {}
  const child = spawnImpl(bin, [paths.configPath], {
    stdio: 'ignore',
    detached: true,
  })
  child.unref?.()
  starts.set(exec.vmId, child)
  const ready = await waitForHealth(exec, timeoutMs)
  return { ...ready, started_in: 'host' }
}

/** 前台跑一次 kernel，只为拿到它的报错文本（2s 足够它报出配置/凭证问题）。 */
function dockerProbe(container, argv) {
  try {
    execFileSync('docker', ['exec', String(container), ...argv.map(String)], {
      encoding: 'utf8',
      timeout: 2500,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, output: '' }
  } catch (error) {
    const out = `${error?.stderr || ''}${error?.stdout || ''}${error?.message || ''}`.trim()
    return { ok: false, output: out.slice(0, 500) }
  }
}

/** `docker exec -d`：容器内的常驻进程（与 kin-worker telemetry 同一种起法）。 */
function dockerExecDetached(container, argv) {
  try {
    execFileSync('docker', ['exec', '-d', String(container), ...argv.map(String)], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.stderr || error?.message || error).trim() }
  }
}

async function waitForHealth(exec, timeoutMs) {
  const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 8000)
  let last = { ok: false, reason: 'not_ready' }
  while (Date.now() < deadline) {
    last = await codexKernelHealth(exec, { timeoutMs: 500 }).catch((error) => ({
      ok: false,
      reason: 'health_error',
      error: String(error.message || error),
    }))
    if (last?.ok || Number(last?.status) === 200) return { ok: true, health: last }
    await new Promise((r) => setTimeout(r, 100))
  }
  return { ok: false, reason: 'health_timeout', health: last }
}

export function stopCodexKernel(vmId) {
  const child = starts.get(vmId)
  if (child) {
    try {
      child.kill('SIGTERM')
    } catch {}
    starts.delete(vmId)
  }
}

export function stopAllCodexKernels() {
  for (const vmId of [...starts.keys()]) stopCodexKernel(vmId)
}
