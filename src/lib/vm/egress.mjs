/**
 * One transparent forwarder per SOCKS5. VMs bound to that proxy join its
 * docker net; kin-egress on the host REDIRECTs the bridge into SOCKS5.
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const EGRESS_BIN = process.env.KIN_EGRESS_BIN || '/opt/kin-gateway/bin/kin-egress'

export function egressEnabled(_env = process.env) {
  return true
}

export function proxyKey(proxyId) {
  return String(proxyId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
}

export function networkName(proxyId) {
  const id = proxyKey(proxyId)
  return id ? `kin-eg-${id}` : ''
}

/** Linux iface max 15 chars. */
export function bridgeName(proxyId) {
  const hex = proxyKey(proxyId)
    .replace(/^px-/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 12)
  return (`keg${hex}` || 'kegbridge').slice(0, 15)
}

export function chainName(proxyId) {
  const hex = proxyKey(proxyId)
    .replace(/^px-/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 12)
  return (`KEG${hex}` || 'KEG').slice(0, 28)
}

export function portsForProxy(proxyId) {
  const s = proxyKey(proxyId)
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  const n = (h >>> 0) % 8000
  return { tcp: 20000 + n * 2, dns: 20000 + n * 2 + 1 }
}

export function gatewayFromSubnet(subnet) {
  const m = String(subnet || '').match(/^(\d+\.\d+\.\d+)\.(\d+)\/\d+$/)
  return m ? `${m[1]}.1` : ''
}

export function iptablesPlan({ chain, bridge, subnet, tcpPort, dnsPort }) {
  const tcp = String(tcpPort)
  const dns = String(dnsPort)
  return {
    add: [
      ['-t', 'nat', '-N', chain],
      ['-t', 'nat', '-C', 'PREROUTING', '-i', bridge, '-j', chain],
      ['-t', 'nat', '-A', 'PREROUTING', '-i', bridge, '-j', chain],
      ['-t', 'nat', '-F', chain],
      ['-t', 'nat', '-A', chain, '-d', subnet, '-j', 'RETURN'],
      ['-t', 'nat', '-A', chain, '-p', 'tcp', '--dport', '53', '-j', 'REDIRECT', '--to-ports', dns],
      ['-t', 'nat', '-A', chain, '-p', 'udp', '--dport', '53', '-j', 'REDIRECT', '--to-ports', dns],
      ['-t', 'nat', '-A', chain, '-p', 'tcp', '-j', 'REDIRECT', '--to-ports', tcp],
      ['-t', 'filter', '-C', 'FORWARD', '-i', bridge, '!', '-d', subnet, '-j', 'DROP'],
      ['-t', 'filter', '-I', 'FORWARD', '1', '-i', bridge, '!', '-d', subnet, '-j', 'DROP'],
    ],
    del: [
      ['-t', 'nat', '-D', 'PREROUTING', '-i', bridge, '-j', chain],
      ['-t', 'nat', '-F', chain],
      ['-t', 'nat', '-X', chain],
      ['-t', 'filter', '-D', 'FORWARD', '-i', bridge, '!', '-d', subnet, '-j', 'DROP'],
    ],
  }
}

function sh(argv, { timeout = 15_000 } = {}) {
  try {
    const out = execFileSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, stdout: String(out || '').trim(), stderr: '' }
  } catch (e) {
    return {
      ok: false,
      stdout: String(e.stdout || '').trim(),
      stderr: String(e.stderr || e.message || '').trim(),
      code: e.status,
    }
  }
}

function iptables(args) {
  return sh(['iptables', ...args], { timeout: 8_000 })
}

function docker(args, timeout = 30_000) {
  return sh(['docker', ...args], { timeout })
}

export function egressRunDir(projectRoot, proxyId) {
  return path.join(projectRoot, 'data', 'run', 'egress', proxyKey(proxyId))
}

function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch {
    return false
  }
}

function readPid(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim())
  } catch {
    return 0
  }
}
export function inspectEgressNetwork(proxyId, run = docker) {
  const name = networkName(proxyId)
  if (!name) return null
  const r = run(['network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Subnet}}|{{.Gateway}}{{end}}', name])
  if (!r.ok) return null
  const [subnet, gateway] = String(r.stdout || '').split('|')
  return {
    name,
    subnet: String(subnet || '').trim(),
    gateway: String(gateway || '').trim() || gatewayFromSubnet(String(subnet || '').trim()),
    bridge: bridgeName(proxyId),
  }
}

export function ensureEgressNetwork(proxyId, run = docker) {
  const name = networkName(proxyId)
  const br = bridgeName(proxyId)
  if (!name) return { ok: false, error: 'proxy_id_required' }
  const existing = inspectEgressNetwork(proxyId, run)
  if (existing?.subnet) return { ok: true, ...existing, reused: true }
  const created = run([
    'network',
    'create',
    '--ipv6=false',
    '--opt',
    `com.docker.network.bridge.name=${br}`,
    '--opt',
    'com.docker.network.bridge.enable_ip_masquerade=false',
    '--opt',
    'com.docker.network.bridge.enable_icc=false',
    name,
  ])
  if (!created.ok && !/already exists/i.test(created.stderr || '')) {
    return { ok: false, error: created.stderr || 'docker network create failed' }
  }
  const info = inspectEgressNetwork(proxyId, run)
  if (!info?.subnet) return { ok: false, error: 'egress network missing subnet' }
  return { ok: true, ...info, reused: false }
}

function applyIptables(plan, runIptables = iptables) {
  const checkIdx = plan.add.findIndex((a) => a.includes('-C'))
  // apply -N (ignore exists), skip -C pairs if already present, then -A/-I
  const add = plan.add
  for (let i = 0; i < add.length; i++) {
    const args = add[i]
    if (args.includes('-N')) {
      const r = runIptables(args)
      if (!r.ok && !/File exists|Chain already/i.test(r.stderr || '')) {
        /* continue; -N may fail if exists */
      }
      continue
    }
    if (args.includes('-C')) {
      const exists = runIptables(args)
      if (exists.ok) {
        i += 1
      }
      continue
    }
    const r = runIptables(args)
    if (!r.ok && !/already|exist/i.test(r.stderr || '')) {
      return { ok: false, error: r.stderr || `iptables ${args.join(' ')} failed` }
    }
  }
  void checkIdx
  return { ok: true }
}

function removeIptables(plan, runIptables = iptables) {
  for (const args of plan.del) {
    runIptables(args)
  }
  return { ok: true }
}

/** 这个 pid 到底是不是 kin-egress（防容器重启后的 pid 复用）。 */
function pidLooksLikeEgress(pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try {
    const cmdline = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8')
    return /kin-egress/.test(cmdline)
  } catch {
    // 读不到 /proc（非 Linux 或权限不足）时退回"活着就算"，保持老行为
    return true
  }
}

export function startEgressProcess({ projectRoot, proxyId, proxyUrl, tcpPort, dnsPort, listenHost, bin = EGRESS_BIN }) {
  if (!listenHost) return { ok: false, error: 'egress listen host required' }
  const dir = egressRunDir(projectRoot, proxyId)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const pidFile = path.join(dir, 'egress.pid')
  const cfgPath = path.join(dir, 'egress.json')
  const listenTcp = `${listenHost}:${tcpPort}`
  const listenDns = `${listenHost}:${dnsPort}`
  const existing = readPid(pidFile)
  // 光看"pid 活着"不够：控制面容器重启后 pid 命名空间重来一遍，旧 pid 很容易被别的
  // 进程顶上，那时复用等于把一个不会监听的进程当成网关（随后 waitListen 超时）。
  if (existing && pidAlive(existing) && pidLooksLikeEgress(existing)) {
    try {
      const old = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      if (old.listen_tcp === listenTcp && old.listen_dns === listenDns && old.proxy_url === proxyUrl) {
        return { ok: true, pid: existing, reused: true, configPath: cfgPath }
      }
    } catch {}
    try {
      process.kill(existing, 'SIGTERM')
    } catch {}
  }
  if (!fs.existsSync(bin)) {
    return { ok: false, error: `kin-egress binary not found: ${bin}` }
  }
  const cfg = {
    proxy_id: proxyId,
    proxy_url: proxyUrl,
    listen_tcp: listenTcp,
    listen_dns: listenDns,
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  const child = spawn(bin, ['-config', cfgPath], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  fs.writeFileSync(pidFile, String(child.pid) + '\n', { mode: 0o600 })
  return { ok: true, pid: child.pid, reused: false, configPath: cfgPath, listen_tcp: listenTcp }
}

export function stopEgressProcess(projectRoot, proxyId) {
  const dir = egressRunDir(projectRoot, proxyId)
  const pidFile = path.join(dir, 'egress.pid')
  const pid = readPid(pidFile)
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  try {
    fs.rmSync(pidFile, { force: true })
  } catch {}
  return { ok: true }
}

export function inspectEgressProcess(projectRoot, proxyId) {
  const dir = egressRunDir(projectRoot, proxyId)
  const pid = readPid(path.join(dir, 'egress.pid'))
  if (!pid || !pidAlive(pid)) return { ok: false, pid: pid || null, reason: 'not_running' }
  let listenTcp = ''
  try {
    listenTcp = String(JSON.parse(fs.readFileSync(path.join(dir, 'egress.json'), 'utf8')).listen_tcp || '')
  } catch {
    listenTcp = ''
  }
  return { ok: true, pid, listen_tcp: listenTcp }
}

export function egressListening(projectRoot, proxyId, timeoutMs = 400) {
  const st = inspectEgressProcess(projectRoot, proxyId)
  if (!st.ok) return st
  const spec = String(st.listen_tcp || '')
  const colon = spec.lastIndexOf(':')
  const host = colon > 0 ? spec.slice(0, colon) : ''
  const port = colon > 0 ? Number(spec.slice(colon + 1)) : 0
  if (!host || !Number.isFinite(port) || port <= 0) return { ok: false, pid: st.pid, reason: 'bad_listen' }
  if (!waitListen(host, port, timeoutMs)) return { ok: false, pid: st.pid, reason: 'not_listening' }
  return st
}

/**
 * 开机对账：把"还该在听"的透明出口网关重新拉起来。
 *
 * 为什么必须有：`kin-egress` 是控制面容器里的一个 detached 子进程（见
 * `startEgressProcess`），控制面一重启它就随命名空间一起没了 —— 而槽容器是
 * `--restart unless-stopped` 的，它照旧在跑。于是出现最难受的状态：槽在跑、
 * 面板显示健康，但槽里所有出站都被 iptables 重定向到一个没人监听的端口，
 * 表现为 DNS/连接超时（codex CLI 会一直重连到超时）。重启控制面本来是运维动作，
 * 不该把线上所有槽的出口悄悄打断。
 *
 * 只对"槽在跑 + 绑了代理"的槽做，且 ensureProxyEgress 本身幂等（配置一致就复用）。
 */
export function reconcileSlotEgress(projectRoot, vms = [], { ensure = ensureProxyEgress } = {}) {
  const results = []
  for (const vm of Array.isArray(vms) ? vms : []) {
    if (!vm?.id) continue
    if (String(vm.status || '').toLowerCase() !== 'running') continue
    if (!vm.proxy?.id) continue
    try {
      const r = ensure(projectRoot, vm.proxy)
      results.push({
        vm_id: vm.id,
        ok: !!r?.ok,
        reused: !!r?.reused,
        network: r?.network || null,
        error: r?.error || null,
      })
    } catch (error) {
      results.push({ vm_id: vm.id, ok: false, error: String(error?.message || error) })
    }
  }
  return results
}

export function boundProxyUrl(proxy) {
  if (proxy?.url) return String(proxy.url).replace(/^socks5:\/\//i, 'socks5h://')
  if (!proxy?.host || !proxy?.port) return ''
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : ''
  return `socks5h://${auth}${proxy.host}:${proxy.port}`
}

function waitListen(host, port, timeoutMs = 8000) {
  const start = Date.now()
  const h = host || '127.0.0.1'
  while (Date.now() - start < timeoutMs) {
    const r = sh(
      [
        'python3',
        '-c',
        `import socket,sys; s=socket.socket(); s.settimeout(0.2); sys.exit(0 if s.connect_ex(('${h}',${Number(port)}))==0 else 1)`,
      ],
      { timeout: 2000 },
    )
    if (r.ok) return true
    sh(['python3', '-c', 'import time; time.sleep(0.1)'], { timeout: 1000 })
  }
  return false
}

export function ensureProxyEgress(projectRoot, proxy, { runDocker = docker, runIptables = iptables } = {}) {
  const proxyId = proxy?.id
  const proxyUrl = boundProxyUrl(proxy)
  if (!proxyId || !proxyUrl) return { ok: false, error: 'bound SOCKS5 id and url required; refusing fallback' }
  const net = ensureEgressNetwork(proxyId, runDocker)
  if (!net.ok) return net
  const listenHost = net.gateway || gatewayFromSubnet(net.subnet)
  if (!listenHost) return { ok: false, error: 'egress network gateway missing' }
  const ports = portsForProxy(proxyId)
  const chain = chainName(proxyId)
  const plan = iptablesPlan({
    chain,
    bridge: net.bridge,
    subnet: net.subnet,
    tcpPort: ports.tcp,
    dnsPort: ports.dns,
  })
  const started = startEgressProcess({
    projectRoot,
    proxyId,
    proxyUrl,
    tcpPort: ports.tcp,
    dnsPort: ports.dns,
    listenHost,
  })
  if (!started.ok) return started
  if (!waitListen(listenHost, ports.tcp))
    return { ok: false, error: `kin-egress ${listenHost}:${ports.tcp} did not listen` }
  const rules = applyIptables(plan, runIptables)
  if (!rules.ok) {
    stopEgressProcess(projectRoot, proxyId)
    return rules
  }
  return {
    ok: true,
    network: net.name,
    bridge: net.bridge,
    subnet: net.subnet,
    gateway: listenHost,
    ports,
    pid: started.pid,
    proxy_id: proxyId,
  }
}

export function stopProxyEgress(projectRoot, proxyId, { subnet, runDocker = docker, runIptables = iptables } = {}) {
  const net = inspectEgressNetwork(proxyId, runDocker)
  const plan = iptablesPlan({
    chain: chainName(proxyId),
    bridge: bridgeName(proxyId),
    subnet: subnet || net?.subnet || '0.0.0.0/0',
    tcpPort: portsForProxy(proxyId).tcp,
    dnsPort: portsForProxy(proxyId).dns,
  })
  removeIptables(plan, runIptables)
  stopEgressProcess(projectRoot, proxyId)
  if (net?.name) runDocker(['network', 'rm', net.name])
  return { ok: true }
}

export function slotNetworkForVm(vm, _env = process.env) {
  const id = vm?.proxy?.id
  if (!id) return ''
  return networkName(id)
}
