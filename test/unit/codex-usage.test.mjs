import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extraToCodexSnapshot, normalizeCodexLimits, buildCodexUsageView } from '../../src/lib/protocol/codex-usage.mjs'
import { summarizeCodexSlot } from '../../src/lib/vm/codex-slot.mjs'

test('extra maps 5h/7d used percent without inversion', () => {
  const snap = extraToCodexSnapshot({
    codex_5h_used_percent: 6,
    codex_7d_used_percent: 34,
    codex_5h_reset_at: '2026-09-07T22:07:49+08:00',
    codex_7d_reset_at: '2026-09-13T21:13:10+08:00',
    codex_5h_window_minutes: 300,
    codex_7d_window_minutes: 10080,
    codex_usage_updated_at: '2026-09-07T19:02:42+08:00',
  })
  assert.equal(snap.secondary_used_percent, 6)
  assert.equal(snap.primary_used_percent, 34)
  const limits = normalizeCodexLimits(snap)
  assert.equal(limits.used_5h_percent, 6)
  assert.equal(limits.used_7d_percent, 34)
  const view = buildCodexUsageView(snap)
  assert.equal(view.unit, 'percent_used')
  assert.equal(view.quota.utilization_5h, 0.06)
  assert.equal(view.quota.utilization_7d, 0.34)
})

test('smaller primary window is 5h', () => {
  const limits = normalizeCodexLimits({
    primary_used_percent: 10,
    primary_window_minutes: 300,
    secondary_used_percent: 80,
    secondary_window_minutes: 10080,
  })
  assert.equal(limits.used_5h_percent, 10)
  assert.equal(limits.used_7d_percent, 80)
})

/**
 * 线上现象：codex 槽额度永远是 `0% / —`，而上游明明回了 62%。
 *
 * 根因是这条链路：`persistCodexQuotaSnapshot` 把 view 写进 `vms/<id>.json` 的
 * `codex.usage`，`summarizeCodexSlot` 又把它读出来喂回 `buildCodexUsageView`。
 * 老实现只认顶层 `primary_used_percent`，于是 view 被当成 extra 解析 → 全 null。
 * 也就是"额度存得对，读出来是空的"。
 */
test('把落盘的 view 再喂回 buildCodexUsageView 不会把额度洗成 null', () => {
  const extra = {
    codex_7d_used_percent: 62,
    codex_7d_window_minutes: 10080,
    codex_7d_reset_at: '2026-09-21T04:00:48Z',
    codex_usage_updated_at: '2026-09-17T08:47:47Z',
  }
  const stored = buildCodexUsageView(extraToCodexSnapshot(extra))
  assert.equal(stored.quota.utilization_7d, 0.62)

  const round2 = buildCodexUsageView(stored)
  assert.equal(round2.quota.utilization_7d, 0.62, 'view → view 必须幂等')
  assert.equal(round2.windows.find((w) => w.id === '7d').used_percent, 62)
  assert.equal(round2.windows.find((w) => w.id === '7d').window_minutes, 10080)
  assert.equal(round2.snapshot.primary_used_percent, 62)
  assert.equal(round2.snapshot.updated_at, '2026-09-17T08:47:47Z')

  const round3 = buildCodexUsageView(round2)
  assert.equal(round3.quota.utilization_7d, 0.62, '再多转几手也不该掉')
})

test('summarizeCodexSlot 读落盘快照时额度是真的（面板走的就是这条路）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-usage-'))
  try {
    fs.mkdirSync(path.join(dir, 'vms', 'vm-x'), { recursive: true })
    const extra = {
      codex_5h_used_percent: 6,
      codex_5h_window_minutes: 300,
      codex_7d_used_percent: 34,
      codex_7d_window_minutes: 10080,
    }
    const vm = {
      id: 'vm-x',
      platform: 'openai',
      family: 'codex',
      codex: { extra, usage: buildCodexUsageView(extraToCodexSnapshot(extra)) },
    }
    fs.writeFileSync(path.join(dir, 'vms', 'vm-x.json'), JSON.stringify(vm))
    fs.writeFileSync(
      path.join(dir, 'vms', 'vm-x', 'codex-credentials.json'),
      JSON.stringify({ accounts: [{ id: 'a@t.local', access_token: 'at-1' }] }),
    )
    const summary = summarizeCodexSlot(dir, vm)
    assert.equal(summary.usage.quota.utilization_5h, 0.06)
    assert.equal(summary.usage.quota.utilization_7d, 0.34)
    assert.equal(summary.usage.windows.find((w) => w.id === '5h').used_percent, 6)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('7 天-only 套餐的 5 小时窗口保持 null（面板据此显示"该套餐没有"）', () => {
  const view = buildCodexUsageView({ codex_7d_used_percent: 62, codex_7d_window_minutes: 10080 })
  assert.equal(view.quota.utilization_5h, null)
  assert.equal(view.quota.utilization_7d, 0.62)
  assert.equal(view.windows.find((w) => w.id === '5h').used_percent, null)
})
