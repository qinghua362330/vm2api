import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { servableSlotKinds } from '../../src/lib/vm/slot-kinds.mjs'

/**
 * "有槽"和"能服务"是两件事。
 *
 * 线上有一台只有 codex 槽的机器，但盘上还留着 `vm-01.json`（anthropic、停着、
 * 从没导过凭证）。按 platform/family 判断会得出"这套部署有 Claude 服务"，于是
 * Claude 形状的请求回的是"号池负载过高"、`/v1/models` 也把 Claude 模型列了出去 ——
 * 都是给分发出去的 key 挖坑。判据必须是"有槽 **且** 有该类型的凭证"。
 */

function fixture(vms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-slot-kinds-'))
  fs.mkdirSync(path.join(dir, 'vms'), { recursive: true })
  for (const { id, ...rest } of vms) {
    fs.mkdirSync(path.join(dir, 'vms', id), { recursive: true })
    fs.writeFileSync(path.join(dir, 'vms', `${id}.json`), JSON.stringify({ id, ...rest }))
  }
  return dir
}

const withCodexCred = (dir, id, accounts = [{ access_token: 'at' }]) =>
  fs.writeFileSync(path.join(dir, 'vms', id, 'codex-credentials.json'), JSON.stringify({ accounts }))

test('空的 Claude 种子槽不算"能服务 Claude"', () => {
  const dir = fixture([
    { id: 'vm-01', platform: 'anthropic', status: 'stopped' },
    { id: 'vm-03', platform: 'openai', family: 'codex', status: 'running' },
  ])
  try {
    withCodexCred(dir, 'vm-03')
    const r = servableSlotKinds(dir)
    assert.deepEqual([...r.kinds], ['codex'])
    assert.deepEqual(r.slots, { claude: 1, codex: 1 })
    assert.deepEqual(r.withCredential, { claude: 0, codex: 1 })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('导过 Claude 凭证的槽才算能服务 Claude', () => {
  const dir = fixture([{ id: 'vm-01', platform: 'anthropic', status: 'running', claude: { has_access: true } }])
  try {
    const r = servableSlotKinds(dir)
    assert.deepEqual([...r.kinds], ['claude'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex 槽只有 refresh_token 也算有凭证（能换票）', () => {
  const dir = fixture([{ id: 'vm-03', platform: 'openai', family: 'codex' }])
  try {
    withCodexCred(dir, 'vm-03', [{ refresh_token: 'rt' }])
    assert.deepEqual([...servableSlotKinds(dir).kinds], ['codex'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('没有槽 / 读不到目录：kinds 为空 + readable 如实回答', () => {
  const empty = fixture([])
  try {
    const r = servableSlotKinds(empty)
    assert.equal(r.kinds.size, 0)
    assert.equal(r.readable, true)
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
  }
  assert.equal(servableSlotKinds('/nonexistent-kin-root').readable, false)
  assert.equal(servableSlotKinds(null).readable, false)
})
