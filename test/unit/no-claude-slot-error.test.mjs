import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'

/**
 * 「号池负载过高，稍后再试」只在真的还有 Claude 账号、只是排队/冷却时才对。
 *
 * 整套部署只有 codex 槽时（线上现在就是），一个 Claude 形状的请求（/v1/messages、
 * Claude Code）根本没有槽能服务 —— 渲染成"稍后再试"会让人一直重试一条永远不可能
 * 成功的路。这类"没有这种槽"必须说清楚，并且不能被 pool-capacity 改写规则吃掉。
 */

function fixture(vms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-no-claude-slot-'))
  fs.mkdirSync(path.join(dir, 'vms'), { recursive: true })
  for (const vm of vms) {
    fs.writeFileSync(path.join(dir, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  }
  return dir
}

const runner = (projectRoot) =>
  new FailoverRunner({ scheduler: { projectRoot, selectAndReserve: async () => ({ ok: false, reason: 'codex_vm' }) } })

test('只有 codex 槽时：报 no_claude_slot 而不是号池负载过高', () => {
  const dir = fixture([{ id: 'vm-03', platform: 'openai', family: 'codex', status: 'running' }])
  try {
    const r = runner(dir)
    assert.equal(r.hasClaudeSlot(), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('有 Claude 槽时保持老行为（交给 failover 排队/重试）', () => {
  const dir = fixture([
    { id: 'vm-01', platform: 'anthropic', status: 'running' },
    { id: 'vm-03', platform: 'openai', family: 'codex', status: 'running' },
  ])
  try {
    const r = runner(dir)
    assert.equal(r.hasClaudeSlot(), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('读不到槽列表时宁可保持老行为（不能把正常请求误判成没有槽）', () => {
  const r = new FailoverRunner({ scheduler: { selectAndReserve: async () => ({ ok: false }) } })
  assert.equal(r.hasClaudeSlot(), true)
  const bad = new FailoverRunner({ scheduler: { projectRoot: '/nonexistent-kin-root' } })
  assert.equal(bad.hasClaudeSlot(), true)
})
