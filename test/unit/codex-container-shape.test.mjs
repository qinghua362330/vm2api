import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startCodexSlotRuntime, inspectCodexContainer } from '../../src/lib/vm/codex-runtime.mjs'
import { codexContainerShapeMismatch, codexSlotContainer } from '../../src/lib/protocol/handle-codex.mjs'

/**
 * 槽从 Claude 转成 codex 之后，旧容器还占着同一个名字（`kin-<n>`）。
 *
 * 线上就是这样：`kin-03` 挂的是 cli-home + kin-worker，里面没有 codex 二进制，
 * 于是每个请求都失败在
 *   OCI runtime exec failed: exec: "/usr/local/bin/codex": no such file or directory
 * 而错误码是 codex_cli_failed —— 看起来像上游/凭证问题，实际是容器形状不对。
 *
 * 判据只有 label 能提供：codex 容器带 `kin.vm.kind=codex`，Claude 容器只有 `kin.vm.id`。
 */

/** preflight 要求槽里有凭证文件（codex-credentials.json），测试里补一份最小的。 */
function seedCodexHome(projectRoot) {
  const dir = path.join(projectRoot, 'vms', 'vm-03')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'codex-credentials.json'),
    JSON.stringify({ accounts: [{ id: 'a@t.local', access_token: 'at-1', refresh_token: 'rt-1' }] }),
  )
}

const CODEX_VM = {
  id: 'vm-03',
  platform: 'openai',
  family: 'codex',
  kernel: 'ubuntu-24.04',
  proxy: { id: 'px-1', host: '127.0.0.1', port: 1080, username: 'u', password: 'p' },
}

const claudeInfo = { name: 'kin-03', running: true, kind: null, vmId: 'vm-03', codexShaped: false }
const codexInfo = { name: 'kin-03', running: true, kind: 'codex', vmId: 'vm-03', codexShaped: true }

test('在跑但不是 codex 形状的容器，不算这个槽的 codex 容器', () => {
  const opts = { inspect: () => claudeInfo }
  assert.equal(codexSlotContainer(CODEX_VM, opts), null)
  assert.deepEqual(codexContainerShapeMismatch(CODEX_VM, opts), { container: 'kin-03', kind: 'claude' })
})

test('codex 形状的容器照旧认', () => {
  const opts = { inspect: () => codexInfo }
  assert.equal(codexSlotContainer(CODEX_VM, opts), 'kin-03')
  assert.equal(codexContainerShapeMismatch(CODEX_VM, opts), null)
})

test('拿不到标签时（老测试替身）保持老行为，不乱删容器', () => {
  const opts = { inspect: () => ({ name: 'kin-03', running: true }) }
  assert.equal(codexSlotContainer(CODEX_VM, opts), 'kin-03')
  assert.equal(codexContainerShapeMismatch(CODEX_VM, opts), null)
})

test('启动槽时遇到错形状的旧容器：先删再按 codex 形状重建', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-shape-'))
  const bin = path.join(projectRoot, 'bin-codex')
  fs.writeFileSync(bin, '#!/bin/sh\n')
  fs.chmodSync(bin, 0o755)
  seedCodexHome(projectRoot)
  const cmds = []
  const shImpl = (args) => {
    cmds.push(args.join(' '))
    return {
      ok: true,
      status: 0,
      stdout: 'true|1|kin-eg-1|2026-09-17T09:00:00Z|kin-os/ubuntu:24.04|03|codex|vm-03\n',
      stderr: '',
    }
  }
  let inspected = 0
  try {
    const result = startCodexSlotRuntime(CODEX_VM, projectRoot, {
      image: 'kin-os/ubuntu:24.04',
      codexBin: bin,
      shImpl,
      inspectImpl: () => {
        inspected += 1
        // 第一次问：Claude 形状的旧容器；删掉之后 docker run 成功，再问就是新容器
        return inspected === 1 ? claudeInfo : codexInfo
      },
      ensureEgress: () => ({ ok: true, network: 'kin-eg-1' }),
    })
    assert.ok(
      cmds.some((c) => c === 'docker rm -f kin-03'),
      cmds.join('\n'),
    )
    assert.ok(
      cmds.some((c) => c.startsWith('docker run -d --name kin-03')),
      cmds.join('\n'),
    )
    assert.equal(result.ok, true, JSON.stringify({ result, cmds }))
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('形状正常时不会去删容器', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-shape-ok-'))
  const bin = path.join(projectRoot, 'bin-codex')
  fs.writeFileSync(bin, '#!/bin/sh\n')
  fs.chmodSync(bin, 0o755)
  seedCodexHome(projectRoot)
  const cmds = []
  const shImpl = (args) => {
    cmds.push(args.join(' '))
    return {
      ok: true,
      status: 0,
      stdout: 'true|1|kin-eg-1|2026-09-17T09:00:00Z|kin-os/ubuntu:24.04|03|codex|vm-03\n',
      stderr: '',
    }
  }
  try {
    const result = startCodexSlotRuntime(CODEX_VM, projectRoot, {
      image: 'kin-os/ubuntu:24.04',
      codexBin: bin,
      shImpl,
      inspectImpl: () => codexInfo,
      ensureEgress: () => ({ ok: true, network: 'kin-eg-1' }),
    })
    assert.equal(result.action, 'running')
    assert.ok(!cmds.some((c) => c.startsWith('docker rm')), cmds.join('\n'))
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('inspect 把 label 读出来（kind / vmId）', () => {
  const calls = []
  const info = inspectCodexContainer('kin-03', {
    shImpl: (args) => {
      calls.push(args.join(' '))
      return {
        ok: true,
        stdout: 'true|123|kin-eg-1|2026-09-17T09:00:00Z|kin-os/ubuntu:24.04|03|claude|vm-03\n',
        stderr: '',
      }
    },
  })
  assert.equal(info.kind, 'claude')
  assert.equal(info.vmId, 'vm-03')
  assert.equal(info.codexShaped, false)
  assert.match(calls[0], /kin\.vm\.kind/)
})
