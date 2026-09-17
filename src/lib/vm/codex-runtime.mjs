/**
 * Codex 槽的容器运行时 —— 与 Claude 槽同一套处理逻辑，只是槽里装的是 codex CLI。
 *
 * 为什么要有这个文件：Claude 槽是一台容器化的「机器」（kin-os 镜像、只读根、
 * machine-id、槽自己的 SOCKS 网络、内存/pids 限制），而 codex 槽过去只是一条 VM
 * 记录 + 一份凭证文件，真正干活的进程跑在宿主机上 —— 于是 hostname、device、
 * 文件系统、OS 全是宿主的，只有出口 IP 是每槽独立的。启动时还会白起一个 Claude
 * 形状的容器（kin-kernel 当 PID 1、挂 claude home），codex 流量根本不进它。
 *
 * 这里把 codex 槽做成和 Claude 槽同形的容器：
 *   - 同一个 kin-os 镜像（看起来就是一台机器）；
 *   - 同样的机器身份挂载（machine-id）、只读根、tmpfs、内存与 pids 限制；
 *   - 同一个「槽自己的网络」（bound SOCKS5 的透明网络，缺代理拒绝启动）；
 *   - 挂 `vms/<id>/codex-home` → `/home/kincli/.codex`（= CODEX_HOME，一槽一份凭证）；
 *   - 只读挂 `bin/codex` → `/usr/local/bin/codex`（宿主二进制度量一份，不塞进每个槽）；
 *   - 容器不常驻网关进程：codex CLI 由驱动按请求 `docker exec` 进容器执行（Claude
 *     侧常驻的是 kin-kernel，codex 侧不需要，保持一台干净的机器即可）。
 */

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { runtimeKind } from './runtime-kind.mjs'
import { ensureGuestMachineIdFile } from '../identity/workstation-fingerprint.mjs'
import { slotNetworkForVm } from './egress.mjs'
import { chownCodexHome, codexHomeDir, codexStateDir, materializeCodexHome } from './codex-home.mjs'
import { codexKernelBinPath } from '../transport/codex-kernel-supervisor.mjs'
import { readCodexAccounts } from './codex-slot.mjs'
import { SLOT_GID, slotUidFor } from './slot-uid.mjs'

export const CODEX_RUNTIME = 'docker'
export const CODEX_HOME_IN_CONTAINER = '/home/kincli/.codex'
/** 整份槽 home 挂到容器的 HOME 下（与 Claude 挂 cli-home 完全同构）。 */
export const CODEX_SLOT_HOME_IN_CONTAINER = '/home/kincli'
export const CODEX_BIN_IN_CONTAINER = '/usr/local/bin/codex'
export const CODEX_KERNEL_BIN_IN_CONTAINER = '/usr/local/bin/kin-codex-kernel'
const GID = String(process.env.KIN_VM_GID || 987)
const UID_BASE = Number(process.env.KIN_VM_UID_BASE || 10000)
const SLOT_MEMORY = process.env.KIN_VM_MEMORY || '500m'
const NET = process.env.KIN_VM_NETWORK || 'bridge'
const PUBLIC_IP = process.env.PUBLIC_HOST || '166.88.96.199'

function sh(args, { timeout = 90_000, input = null } = {}) {
  try {
    const stdout = execFileSync(args[0], args.slice(1), {
      encoding: 'utf8',
      timeout,
      input: input == null ? undefined : input,
      stdio: input == null ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    })
    return { ok: true, stdout: String(stdout || '').trim(), stderr: '' }
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout || '').trim(),
      stderr: String(error?.stderr || error?.message || error).trim(),
    }
  }
}

export function codexContainerName(vmId) {
  return `kin-${String(vmId || '').replace(/^vm-/, '')}`
}

export function codexRuntimeUser(vm) {
  return `${slotUidFor(vm)}:${SLOT_GID}`
}

export function inspectCodexContainer(name, { shImpl = sh } = {}) {
  const r = shImpl([
    'docker',
    'inspect',
    '--format',
    '{{.State.Running}}|{{.State.Pid}}|{{.HostConfig.NetworkMode}}|{{.State.StartedAt}}|{{.Config.Image}}|{{.Config.Hostname}}',
    name,
  ])
  if (!r.ok) return null
  const [running, pid, networkMode, startedAt, image, hostname] = r.stdout.split('|')
  return {
    name,
    running: running === 'true',
    pid: Number(pid) || null,
    networkMode: networkMode || null,
    startedAt: startedAt || null,
    image: image || null,
    hostname: hostname || null,
  }
}

/**
 * 容器里跑 codex CLI 需要的东西是否齐了。
 *
 * `--read-only` 根 + 只读挂载意味着缺一样就是启动后才炸，所以在 run 之前先问清楚：
 * 镜像、CLI 二进制、槽的 CODEX_HOME、槽网络、machine-id。缺哪样报哪样。
 */
/**
 * 槽启动前把凭证/出口写进 `vms/<id>/codex-home`（宿主写、槽只读，Claude 侧同理）。
 * 返回是否具备"能跑"的条件，缺什么说什么。
 */
export function ensureCodexSlotHome({ projectRoot, vm } = {}) {
  const vmId = String(vm?.id || '').trim()
  if (!projectRoot || !vmId) return { ok: false, reason: 'project_and_vm_required' }
  const authPath = path.join(codexStateDir(projectRoot, vmId), 'auth.json')
  if (fs.existsSync(authPath)) {
    chownCodexHome(projectRoot, vmId, vm)
    return { ok: true, reused: true, authPath }
  }
  const accounts = readCodexAccounts(projectRoot, vmId)
  const account = accounts.find((item) => String(item?.access_token || '').trim()) || accounts[0] || null
  if (!account) return { ok: false, reason: 'codex_credential_missing' }
  const written = materializeCodexHome({ projectRoot, vm, account, proxyUrl: proxyEnv(vm) })
  return written.ok ? { ok: true, reused: false, authPath: written.authPath } : { ok: false, reason: written.reason }
}

export function preflightCodexSlot({ projectRoot, vm, codexBin = null, image = null, shImpl = sh } = {}) {
  const missing = []
  const vmId = String(vm?.id || '').trim()
  if (!vmId) return { ok: false, missing: ['vm'], error: 'vm id is required' }
  if (runtimeKind(vm) === 'kvm')
    return { ok: false, missing: ['kvm'], error: 'kvm runtime is not configured for codex slots' }

  const bin = String(codexBin || process.env.KIN_CODEX_BIN || '').trim()
  if (!bin) missing.push('codex_bin')
  else {
    try {
      fs.accessSync(bin, fs.constants.R_OK)
    } catch {
      missing.push('codex_bin_unreadable')
    }
  }

  const homeState = ensureCodexSlotHome({ projectRoot, vm })
  if (!homeState.ok) missing.push(homeState.reason || 'codex_home')
  const home = codexHomeDir(projectRoot, vmId)
  const state = codexStateDir(projectRoot, vmId)

  const network = slotNetworkForVm(vm)
  if (!network || network === 'host' || network === 'bridge') missing.push('slot_network')

  const imageRef = String(image || '').trim()
  if (!imageRef) missing.push('image')
  else {
    const found = shImpl(['docker', 'image', 'inspect', '--format', '{{.Id}}', imageRef])
    if (!found.ok) missing.push('image_missing')
  }

  return missing.length
    ? { ok: false, missing, error: `codex slot preflight failed: ${missing.join(', ')}` }
    : { ok: true, home, network, bin, image: imageRef }
}

/**
 * 起一个 codex 形状的容器。参数与 Claude 侧逐条对齐（网络、身份、限制、只读根），
 * 差别只有三处：挂的是 codex-home、挂的是 codex 二进制、没有常驻网关进程。
 */
export function startCodexSlotRuntime(
  vm,
  projectRoot,
  { image = null, codexBin = null, shImpl = sh, inspectImpl = inspectCodexContainer, limits = null } = {},
) {
  const name = codexContainerName(vm.id)
  const homeInSlot = codexHomeDir(projectRoot, vm.id)
  // 声明在最前面：下面的"已在跑/已停止"早返回分支也要用它
  const kernelBin = String(process.env.KIN_CODEX_KERNEL_BIN || '').trim() || codexKernelBinPath() || ''
  const pre = preflightCodexSlot({ projectRoot, vm, codexBin, image, shImpl })
  if (!pre.ok) return { ok: false, error: pre.error, missing: pre.missing }

  const existing = inspectImpl(name, { shImpl })
  if (existing?.running) {
    return {
      ok: true,
      action: 'running',
      runtime: runtimePatchOf(vm, existing, { kernelMounted: !!kernelBin }),
      preflight: pre,
    }
  }
  if (existing) {
    const started = shImpl(['docker', 'start', name])
    if (!started.ok) return { ok: false, error: started.stderr || 'docker start failed' }
    const info = inspectImpl(name, { shImpl })
    return {
      ok: true,
      action: 'started',
      runtime: runtimePatchOf(vm, info, { kernelMounted: !!kernelBin }),
      preflight: pre,
    }
  }

  // 运行目录：kernel 的 config 与 socket 都住这儿，宿主与容器通过 /run/kin 共享。
  // 不挂它，容器里的 kernel 连自己的配置都读不到（实测报 "config: No such file or
  // directory"），Node 侧也就永远等不到那个 socket。所有权给槽的 uid，否则容器内
  // 进程建不了 socket。
  const runDir = path.join(projectRoot, 'vms', vm.id, 'run')
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
  try {
    fs.chownSync(runDir, slotUidFor(vm), Number(SLOT_GID))
    fs.chmodSync(runDir, 0o700)
  } catch {}
  const machineIdFile = ensureGuestMachineIdFile(projectRoot, vm)
  const machineMounts = machineIdFile
    ? ['-v', `${machineIdFile}:/etc/machine-id:ro`, '-v', `${machineIdFile}:/var/lib/dbus/machine-id:ro`]
    : []
  const mem = String(limits?.memory || SLOT_MEMORY)
  const pids = String(limits?.pids || 256)
  const host = displayHostname(vm.id)

  const args = [
    'docker',
    'run',
    '-d',
    '--name',
    name,
    '--hostname',
    host,
    '--network',
    pre.network,
    '--restart',
    'unless-stopped',
    '--memory',
    mem,
    '--memory-swap',
    mem,
    '--pids-limit',
    pids,
    '--user',
    codexRuntimeUser(vm),
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=32m',
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    '--label',
    'kin.vm=1',
    '--label',
    `kin.vm.id=${vm.id}`,
    '--label',
    'kin.vm.kind=codex',
    // 一槽一份 HOME（= CODEX_HOME 的父目录）：凭证、会话、app-server 控制 socket 都在
    // 这里。挂整份 home 而不是只挂 .codex，是因为容器里的 $HOME 也得可写 —— CLI 要在
    // ~/.local/bin 建 PATH alias，写不进去它会告警并可能拒绝启动。
    '-v',
    `${homeInSlot}:${CODEX_SLOT_HOME_IN_CONTAINER}`,
    // CLI 二进制只读挂载：和 kin-worker / kin-kernel 一个套路，不往每个槽里复制 200MB
    '-v',
    `${pre.bin}:${CODEX_BIN_IN_CONTAINER}:ro`,
    // kernel 二进制同理：存在才挂（与 Claude 的 kin-kernel 挂载条件一致），
    // 挂上之后 kernel 就在槽里跑，配置/socket 经 /run/kin 共享
    ...(kernelBin ? ['-v', `${kernelBin}:${CODEX_KERNEL_BIN_IN_CONTAINER}:ro`] : []),
    // 配置与 socket 的共享目录：kernel 读 /run/kin/codex-kernel.json、建
    // /run/kin/codex-kernel.sock，宿主侧看到的就是 vms/<id>/run 下的同名文件
    '-v',
    `${runDir}:/run/kin`,
    ...machineMounts,
    '-e',
    `CODEX_HOME=${CODEX_HOME_IN_CONTAINER}`,
    '-e',
    'HOME=/home/kincli',
    '-e',
    `TZ=${vm.timezone || 'UTC'}`,
    '-e',
    `LANG=${vm.locale || 'en_US.UTF-8'}`,
    '-e',
    `KIN_VM_ID=${vm.id}`,
    '-e',
    `KIN_VM_NAME=${host}`,
    // 出口走槽绑定的代理（和 Claude 槽同一条规则：没绑代理不启动）
    ...(proxyEnv(vm) ? ['-e', `ALL_PROXY=${proxyEnv(vm)}`, '-e', `HTTPS_PROXY=${proxyEnv(vm)}`] : []),
    '--dns',
    '8.8.8.8',
    '--dns-opt',
    'use-vc',
    '-w',
    '/home/kincli',
    pre.image,
    // 没有任何常驻进程：这是一台"待命的机器"，codex CLI 由驱动按请求 exec 进来
    'sleep',
    'infinity',
  ]

  const r = shImpl(args)
  if (!r.ok) return { ok: false, error: r.stderr || r.stdout || 'docker run failed' }
  const info = inspectImpl(name, { shImpl })
  return {
    ok: true,
    action: 'created',
    runtime: runtimePatchOf(vm, info, { kernelMounted: !!kernelBin }),
    preflight: pre,
  }
}

function displayHostname(vmId) {
  return String(vmId || '').replace(/^vm-/, '')
}

function proxyEnv(vm) {
  const url = String(vm?.proxy?.url || '').trim()
  if (url) return url.replace(/^socks5:\/\//i, 'socks5h://')
  if (vm?.proxy?.host && vm?.proxy?.port) return `socks5h://${vm.proxy.host}:${vm.proxy.port}`
  return ''
}

function runtimePatchOf(vm, info, { kernelMounted = false } = {}) {
  const kernel = vm.kernel || 'ubuntu-24.04'
  const meta = {
    'ubuntu-24.04': 'kin-os/ubuntu:24.04',
    'debian-12': 'kin-os/debian:12',
    archlinux: 'kin-os/arch:latest',
    'fedora-41': 'kin-os/fedora:41',
  }
  return {
    type: CODEX_RUNTIME,
    kind: 'codex',
    container: info?.name || codexContainerName(vm.id),
    pid: info?.pid || null,
    ip: info?.ip || PUBLIC_IP,
    network: NET,
    network_mode: info?.networkMode || NET,
    started_at: info?.startedAt || null,
    image: info?.image || meta[kernel] || meta['ubuntu-24.04'],
    hostname: info?.hostname || displayHostname(vm.id),
    codex_home: CODEX_HOME_IN_CONTAINER,
    codex_bin: CODEX_BIN_IN_CONTAINER,
    codex_kernel_bin: kernelMounted ? CODEX_KERNEL_BIN_IN_CONTAINER : null,
  }
}

export function stopCodexSlotRuntime(vm, { shImpl = sh } = {}) {
  const name = codexContainerName(vm?.id)
  if (!vm?.id) return { ok: false, error: 'vm id is required' }
  const r = shImpl(['docker', 'stop', '--time', '5', name])
  if (!r.ok && !/No such container/i.test(`${r.stderr} ${r.stdout}`)) {
    return { ok: false, error: r.stderr || r.stdout || 'docker stop failed' }
  }
  return { ok: true, action: 'stopped' }
}

export function destroyCodexSlotRuntime(vm, { shImpl = sh } = {}) {
  const name = codexContainerName(vm?.id)
  if (!vm?.id) return { ok: false, error: 'vm id is required' }
  const r = shImpl(['docker', 'rm', '-f', name])
  if (!r.ok && !/No such container/i.test(`${r.stderr} ${r.stdout}`)) {
    return { ok: false, error: r.stderr || r.stdout || 'docker rm failed' }
  }
  return { ok: true, action: 'destroyed' }
}

/** 容器里跑一条命令（codex CLI 的入口）。stdin 走管道，否则 CLI 会等输入。 */
export function execInCodexSlot(vm, argv, { input = null, shImpl = sh, timeoutMs = 600_000 } = {}) {
  const name = codexContainerName(vm?.id)
  if (!name) return { ok: false, stderr: 'vm id is required' }
  const args = ['docker', 'exec', '-i', name, ...argv.map(String)]
  return shImpl(args, { timeout: timeoutMs, input: input == null ? '' : input })
}

/** 容器里 CLI 的版本，用作槽健康的一部分。 */
export function codexSlotVersion(vm, { shImpl = sh } = {}) {
  const r = execInCodexSlot(vm, [CODEX_BIN_IN_CONTAINER, '--version'], { shImpl, timeoutMs: 20_000 })
  if (!r.ok) return { ok: false, error: r.stderr || 'codex --version failed' }
  return { ok: true, version: r.stdout }
}

/** 供测试注入：默认实现 + 一个稳定 id。 */
export function codexSlotToken() {
  return crypto.randomBytes(12).toString('hex')
}
