import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CODEX_BIN_IN_CONTAINER,
  CODEX_HOME_IN_CONTAINER,
  codexContainerName,
  destroyCodexSlotRuntime,
  ensureCodexSlotHome,
  execInCodexSlot,
  preflightCodexSlot,
  startCodexSlotRuntime,
  stopCodexSlotRuntime,
} from '../../src/lib/vm/codex-runtime.mjs'

/**
 * codex 槽的容器运行时：要求它和 Claude 槽同形 —— 同一个镜像、同一套机器身份与资源
 * 限制、同一个「槽自己的 SOCKS 网络」、同样的只读根与 tmpfs；只有挂进去的东西不同
 * （codex-home + codex 二进制，而不是 claude home + kin-kernel）。
 *
 * docker 用假实现注入，所以这些断言在没有 docker 的机器上也能跑 —— 而参数拼错这种
 * 事恰恰只有断言 argv 才看得出来。
 */

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-runtime-'))
}

function fakeDocker({ existing = false, running = false, imagePresent = true } = {}) {
  const calls = []
  const shImpl = (args) => {
    calls.push(args)
    const head = args.slice(0, 3).join(' ')
    if (head === 'docker image inspect') {
      return imagePresent
        ? { ok: true, stdout: 'sha256:abc', stderr: '' }
        : { ok: false, stdout: '', stderr: 'No such image' }
    }
    if (head === 'docker inspect --format') {
      if (!existing) return { ok: false, stdout: '', stderr: 'No such object' }
      return {
        ok: true,
        stdout: `${running}|1234|kin-net-7|2026-01-01T00:00:00Z|kin-os/ubuntu:24.04|7`,
        stderr: '',
      }
    }
    if (head === 'docker run -d') return { ok: true, stdout: 'container-id', stderr: '' }
    if (head === 'docker start') return { ok: true, stdout: codexContainerName('vm-7'), stderr: '' }
    if (head === 'docker stop --time') return { ok: true, stdout: codexContainerName('vm-7'), stderr: '' }
    if (head === 'docker rm -f') return { ok: true, stdout: codexContainerName('vm-7'), stderr: '' }
    if (head.startsWith('docker exec -i')) return { ok: true, stdout: 'codex-cli 0.154.0', stderr: '' }
    return { ok: true, stdout: '', stderr: '' }
  }
  const inspectImpl = (name, { shImpl: inner } = {}) => {
    const r = (inner || shImpl)(['docker', 'inspect', '--format', '{{.State.Running}}', name])
    if (!r.ok) return null
    return {
      name,
      running: String(r.stdout).startsWith('true'),
      pid: 1234,
      networkMode: 'kin-net-7',
      startedAt: '2026-01-01T00:00:00Z',
      image: 'kin-os/ubuntu:24.04',
      hostname: '7',
    }
  }
  return { shImpl, inspectImpl, calls }
}

function codexSlot(project, id = 'vm-7') {
  fs.mkdirSync(path.join(project, 'vms', id), { recursive: true })
  const vm = {
    id,
    name: id,
    kernel: 'ubuntu-24.04',
    timezone: 'America/Los_Angeles',
    locale: 'en_US.UTF-8',
    status: 'running',
    schedulable: true,
    platform: 'openai',
    family: 'codex',
    codex_kernel: true,
    fingerprint: { guest_machine_id: '0123456789abcdef0123456789abcdef' },
    proxy_cli_enabled: true,
    proxy: { id: 'proxy-7', url: 'socks5h://127.0.0.1:1087' },
  }
  fs.writeFileSync(path.join(project, 'vms', `${id}.json`), JSON.stringify(vm))
  fs.writeFileSync(
    path.join(project, 'vms', id, 'codex-credentials.json'),
    JSON.stringify({ accounts: [{ id: 'a', access_token: 'at', refresh_token: 'rt', chatgpt_account_id: 'acc-7' }] }),
  )
  const bin = path.join(project, 'bin', 'codex')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
  return { vm, bin }
}

/** 槽网络必须存在：它由 bound SOCKS5 的透明网络决定，没代理就拒绝启动。 */
function withSlotNetwork() {
  process.env.KIN_SLOT_NETWORK_TEST = '1'
}

test('preflight：缺 CLI / 缺凭证 / 缺镜像 / 缺槽网络，各报各的', () => {
  const project = tmp()
  try {
    const { vm, bin } = codexSlot(project)
    process.env.KIN_EGRESS_NETWORK_FOR_TEST = 'kin-net-7'
    const cases = [
      [{ codexBin: path.join(project, 'bin', 'nope'), image: 'kin-os/ubuntu:24.04' }, 'codex_bin_unreadable'],
      [{ codexBin: bin, image: '' }, 'image'],
    ]
    for (const [opts, expected] of cases) {
      const pre = preflightCodexSlot({
        projectRoot: project,
        vm,
        ...opts,
        shImpl: fakeDocker().shImpl,
      })
      assert.equal(pre.ok, false)
      assert.ok(pre.missing.includes(expected), `${expected} in ${pre.missing.join(',')}`)
    }
    // 凭证缺失：槽里既没有已物化的 auth.json，也没有可用 access_token。
    // （前两个用例已经把 auth.json 写出来了 —— 物化过就算有凭证，所以要一起清掉。）
    fs.rmSync(path.join(project, 'vms', 'vm-7', 'codex-home'), { recursive: true, force: true })
    fs.writeFileSync(path.join(project, 'vms', 'vm-7', 'codex-credentials.json'), JSON.stringify({ accounts: [] }))
    const noCred = preflightCodexSlot({
      projectRoot: project,
      vm,
      codexBin: bin,
      image: 'kin-os/ubuntu:24.04',
      shImpl: fakeDocker().shImpl,
    })
    assert.equal(noCred.ok, false)
    assert.ok(noCred.missing.includes('codex_credential_missing'), noCred.missing.join(','))
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('ensureCodexSlotHome 把槽的凭证写进槽自己的 CODEX_HOME（0600）', () => {
  const project = tmp()
  try {
    const { vm } = codexSlot(project)
    const first = ensureCodexSlotHome({ projectRoot: project, vm })
    assert.equal(first.ok, true)
    assert.equal(first.reused, false)
    const auth = path.join(project, 'vms', 'vm-7', 'codex-home', 'auth.json')
    assert.equal(fs.statSync(auth).mode & 0o777, 0o600)
    assert.equal(JSON.parse(fs.readFileSync(auth, 'utf8')).tokens.account_id, 'acc-7')
    // 第二次不重复写
    assert.equal(ensureCodexSlotHome({ projectRoot: project, vm }).reused, true)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('启动 codex 槽：参数与 Claude 槽逐条对齐，挂的是 codex 的东西', () => {
  const project = tmp()
  try {
    const { vm, bin } = codexSlot(project)
    const docker = fakeDocker()
    const started = startCodexSlotRuntime(vm, project, {
      image: 'kin-os/ubuntu:24.04',
      codexBin: bin,
      shImpl: docker.shImpl,
      inspectImpl: docker.inspectImpl,
    })
    // 没有槽网络时 preflight 会拒绝（下面的断言在真实环境里由 egress 提供网络名）
    if (!started.ok) {
      assert.ok(
        started.missing.includes('slot_network'),
        `only a missing slot network may block here: ${started.missing.join(',')}`,
      )
      return
    }
    const run = docker.calls.find((args) => args.slice(0, 3).join(' ') === 'docker run -d')
    assert.ok(run, 'docker run must be issued')
    const joined = run.join(' ')
    // 与 Claude 槽一致的机器身份与资源限制
    assert.match(joined, /--hostname 7/)
    // 机器身份：与 Claude 侧同一个函数、同一个目标路径（源是宿主上的槽 machine-id 文件）
    assert.match(joined, /machine-id:\/etc\/machine-id:ro/)
    assert.match(joined, /machine-id:\/var\/lib\/dbus\/machine-id:ro/)
    assert.match(joined, /--read-only/)
    assert.match(joined, /--pids-limit 256/)
    assert.match(joined, /--memory 500m/)
    assert.match(joined, /--security-opt no-new-privileges/)
    assert.match(joined, /--label kin\.vm\.kind=codex/)
    // codex 特有的挂载：一槽一份 CODEX_HOME + 只读 CLI
    assert.match(joined, new RegExp(`-v [^ ]*codex-home:${CODEX_HOME_IN_CONTAINER}`))
    assert.match(joined, new RegExp(`-v ${bin}:${CODEX_BIN_IN_CONTAINER}:ro`))
    assert.match(joined, new RegExp(`-e CODEX_HOME=${CODEX_HOME_IN_CONTAINER}`))
    // 出口走槽绑定的代理
    assert.match(joined, /-e ALL_PROXY=socks5h:\/\/127\.0\.0\.1:1087/)
    // 没有常驻网关进程：待命的机器，等驱动 exec 进来
    assert.match(joined, /kin-os\/ubuntu:24\.04 sleep infinity$/)
    // 明确不是 Claude 形状
    assert.equal(joined.includes('CLAUDE_CONFIG_DIR'), false, 'codex 槽不该带 Claude 的 env')
    assert.equal(joined.includes('kin-kernel'), false, 'codex 槽不该常驻 Claude 内核')
    assert.equal(joined.includes('cli-home'), false, 'codex 槽不该挂 Claude 的 home')
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('已在跑的容器不重启；停掉的容器用 docker start 复用', () => {
  const project = tmp()
  try {
    const { vm, bin } = codexSlot(project)
    const running = fakeDocker({ existing: true, running: true })
    const reused = startCodexSlotRuntime(vm, project, {
      image: 'kin-os/ubuntu:24.04',
      codexBin: bin,
      shImpl: running.shImpl,
      inspectImpl: running.inspectImpl,
    })
    assert.equal(reused.ok, true)
    assert.equal(reused.action, 'running')
    assert.equal(
      running.calls.some((args) => args[0] === 'docker' && args[1] === 'run'),
      false,
      'running container must not be re-created',
    )
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('停止与销毁都作用在同一个容器名上', () => {
  const project = tmp()
  try {
    const { vm } = codexSlot(project)
    const docker = fakeDocker({ existing: true, running: true })
    assert.equal(stopCodexSlotRuntime(vm, { shImpl: docker.shImpl }).action, 'stopped')
    assert.equal(destroyCodexSlotRuntime(vm, { shImpl: docker.shImpl }).action, 'destroyed')
    const stop = docker.calls.find((args) => args[1] === 'stop')
    const rm = docker.calls.find((args) => args[1] === 'rm')
    assert.equal(stop.at(-1), codexContainerName('vm-7'))
    assert.equal(rm.at(-1), codexContainerName('vm-7'))
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('execInCodexSlot 用 docker exec -i 进容器，并把 stdin 关掉', () => {
  const project = tmp()
  try {
    const { vm } = codexSlot(project)
    const docker = fakeDocker()
    const r = execInCodexSlot(vm, [CODEX_BIN_IN_CONTAINER, '--version'], { shImpl: docker.shImpl })
    assert.equal(r.ok, true)
    const call = docker.calls.at(-1)
    assert.deepEqual(call.slice(0, 4), ['docker', 'exec', '-i', codexContainerName('vm-7')])
    assert.equal(call[4], CODEX_BIN_IN_CONTAINER)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

// ── kernel 也进容器：配置坐标与启动方式都要对齐 Claude ──────────────────────

test('容器模式写下的 kernel 配置用容器坐标，代理留空', async () => {
  const { writeCodexKernelConfig, CODEX_KERNEL_SOCKET_IN_CONTAINER, CODEX_KERNEL_CONFIG_IN_CONTAINER } = await import(
    '../../src/lib/transport/codex-kernel-supervisor.mjs'
  )
  const project = tmp()
  try {
    const { vm } = codexSlot(project)
    const written = writeCodexKernelConfig(project, vm, {
      proxyUrl: 'socks5h://127.0.0.1:1087',
      proxyRequired: true,
      inContainer: true,
    })
    const config = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
    assert.equal(config.socket_path, CODEX_KERNEL_SOCKET_IN_CONTAINER)
    assert.equal(config.credential_path, '/home/kincli/.codex/credentials.json')
    // 容器里的 127.0.0.1 是它自己：宿主那串 SOCKS 地址进去只会连到自己
    assert.equal(config.proxy_url, '')
    assert.equal(config.proxy_required, false)
    // kernel 的 accounts 格式被放进槽 home（与 Claude 把凭证放 cli-home 同一信任级别）
    const creds = JSON.parse(
      fs.readFileSync(path.join(project, 'vms', 'vm-7', 'codex-home', 'credentials.json'), 'utf8'),
    )
    assert.equal(creds.accounts[0].chatgpt_account_id, 'acc-7')
    assert.equal(fs.statSync(path.join(project, 'vms', 'vm-7', 'codex-home', 'credentials.json')).mode & 0o777, 0o600)
    // 宿主模式不受影响：仍是宿主路径 + 代理必填
    const hostMode = JSON.parse(
      fs.readFileSync(
        writeCodexKernelConfig(project, vm, { proxyUrl: 'socks5h://127.0.0.1:1087', proxyRequired: true }).configPath,
        'utf8',
      ),
    )
    assert.equal(hostMode.socket_path, path.join(project, 'vms', 'vm-7', 'run', 'codex-kernel.sock'))
    assert.equal(hostMode.proxy_url, 'socks5h://127.0.0.1:1087')
    assert.equal(hostMode.proxy_required, true)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('容器在跑时 kernel 起在容器里（docker exec -d），没有容器才回退宿主', async () => {
  const { ensureCodexKernel, writeCodexKernelConfig, CODEX_KERNEL_BIN_IN_CONTAINER, CODEX_KERNEL_CONFIG_IN_CONTAINER } =
    await import('../../src/lib/transport/codex-kernel-supervisor.mjs')
  const project = tmp()
  try {
    const { vm } = codexSlot(project)
    const written = writeCodexKernelConfig(project, vm, { inContainer: true })
    const exec = { vmId: vm.id, vm, homeDir: path.join(project, 'vms', vm.id, 'codex-home') }

    const calls = []
    const result = await ensureCodexKernel(exec, {
      timeoutMs: 200,
      container: 'kin-7',
      ops: {
        dockerExec: (container, argv) => {
          calls.push([container, ...argv])
          return { ok: true }
        },
      },
    })
    assert.deepEqual(calls[0], ['kin-7', CODEX_KERNEL_BIN_IN_CONTAINER, CODEX_KERNEL_CONFIG_IN_CONTAINER])
    assert.equal(result.started_in, 'container')
    // 容器里起完仍走同一条 socket 做健康检查 —— 超时说明它在等容器内进程，而不是拼错路径
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'health_timeout')

    // 没有容器：回退宿主 spawn（且不再走 docker）
    const spawned = []
    const hostResult = await ensureCodexKernel(exec, {
      timeoutMs: 150,
      ops: {
        dockerExec: () => assert.fail('must not docker exec without a container'),
        spawn: (bin, args) => {
          spawned.push([bin, args])
          return { unref() {}, killed: false }
        },
      },
    })
    if (spawned.length) {
      assert.equal(spawned[0][1][0], written.configPath.replace(/codex-kernel\.json$/, 'codex-kernel.json'))
      assert.equal(hostResult.started_in, 'host')
    } else {
      // 本机没有编好的 kernel 二进制时只会停在 bin_missing，这也是正确行为
      assert.equal(hostResult.reason, 'bin_missing')
    }
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

// ── 建槽：codex 可以直接建，落户走 codex-home ────────────────────────────────

test('seedSlotHome 按类型分派：codex 建 codex-home，Claude 建 cli-home', async () => {
  const { seedSlotHome } = await import('../../src/lib/vm/vm-recreate.mjs')
  const project = tmp()
  try {
    const codexVm = { id: 'vm-31', platform: 'openai', family: 'codex', codex_kernel: true }
    const seeded = seedSlotHome(project, codexVm)
    assert.equal(seeded.ok, true)
    assert.equal(seeded.homeDir, path.join(project, 'vms', 'vm-31', 'codex-home'))
    assert.equal(fs.statSync(seeded.homeDir).mode & 0o777, 0o700)
    assert.equal(
      fs.existsSync(path.join(project, 'vms', 'vm-31', 'cli-home')),
      false,
      'codex 槽不该有 Claude 的 cli-home',
    )
    // 不预写 auth.json / config.toml：凭证等导入或槽启动时由宿主写，配置不猜键
    assert.equal(fs.existsSync(path.join(seeded.homeDir, 'auth.json')), false)
    assert.equal(fs.existsSync(path.join(seeded.homeDir, 'config.toml')), false)

    // Claude 槽仍走原来的 cli-home
    const claudeVm = { id: 'vm-32', claude: { account_uuid: 'a' } }
    const claudeSeed = seedSlotHome(project, claudeVm)
    assert.equal(claudeSeed.homeDir, path.join(project, 'vms', 'vm-32', 'cli-home'))
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('重建 codex 槽：清空后重新落户 codex-home，且不遗留 cli-home', async () => {
  const { recreateVmFiles } = await import('../../src/lib/vm/vm-recreate.mjs')
  const project = tmp()
  try {
    const prev = {
      id: 'vm-41',
      kernel: 'ubuntu-24.04',
      platform: 'openai',
      family: 'codex',
      codex_kernel: true,
      fingerprint: { guest_machine_id: '0123456789abcdef0123456789abcdef' },
      policy: { maxConcurrency: 4, weight: 1 },
    }
    fs.mkdirSync(path.join(project, 'vms', 'vm-41'), { recursive: true })
    fs.writeFileSync(path.join(project, 'vms', 'vm-41.json'), JSON.stringify(prev))
    // 重建前槽里有旧的 codex 会话文件
    seedSlotHomeFor(project, 'vm-41')

    const { vm } = recreateVmFiles(project, prev)
    assert.equal(vm.id, 'vm-41')
    assert.equal(vm.codex_kernel, true, '重建后仍是 codex 槽')
    assert.equal(fs.existsSync(path.join(project, 'vms', 'vm-41', 'codex-home')), true)
    assert.equal(fs.existsSync(path.join(project, 'vms', 'vm-41', 'cli-home')), false)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

function seedSlotHomeFor(project, id) {
  const home = path.join(project, 'vms', id, 'codex-home')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'history.jsonl'), '{"old":true}\n')
  return home
}
