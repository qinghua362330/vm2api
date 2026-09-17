import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { usedPctOf, usedPctOrNull } from '@/lib/format'

/**
 * 额度条的单位契约：**全前端统一用百分比（0..100）**。
 *
 * 线上就撞过一次：面板以为拿到的是 0..1 的比例，于是把已经算好的 62% 又乘了
 * 100 → 6200%，`Meter` 夹到 100%，槽详情显示「7 天已用 100%」，而同一个槽在
 * 列表里显示 62.0%。两处不一致，用户看到的就是"额度不对"。
 *
 * 归一化只发生在 `usedPctOf` / `usedPctOrNull` 里（它们同时容忍 0.62 和 62），
 * 下游一律直接画。
 */

const read = (rel: string) =>
  fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8')

describe('额度条单位契约', () => {
  it('usedPctOrNull 把比例换成百分比，且不重复放大', () => {
    const view = {
      codex_usage: { windows: [{ id: '7d', used_percent: 62 }] },
    }
    expect(usedPctOrNull(view, '7d')).toBe(62)
    expect(usedPctOrNull({ utilization_7d: 0.62 }, '7d')).toBe(62)
    expect(usedPctOrNull({ utilization_7d: 62 }, '7d')).toBe(62)
  })

  it('没有这个窗口时是 null，不是 0', () => {
    const view = {
      codex_usage: { windows: [{ id: '5h', used_percent: null }] },
      utilization_5h: null,
    }
    expect(usedPctOrNull(view, '5h')).toBeNull()
    // 数字版（列表的 Claude 行还在用）保持 0，不改变老行为
    expect(usedPctOf(view, '5h')).toBe(0)
  })

  it('codex 额度卡不再把百分比乘 100', () => {
    const src = read('src/features/vm/openai-quota-panel.tsx')
    expect(src).not.toMatch(/u5\s*\*\s*100/)
    expect(src).not.toMatch(/u7\s*\*\s*100/)
    expect(src).toMatch(/value=\{u5\}/)
    expect(src).toMatch(/value=\{u7\}/)
  })

  it('槽详情传给额度卡的已经是百分比（null-aware）', () => {
    const page = read('src/features/vm/detail-page.tsx')
    expect(page).toMatch(/const u5n = usedPctOrNull\(/)
    expect(page).toMatch(/u5=\{u5n\}/)
    expect(page).toMatch(/u7=\{u7n\}/)
  })

  it('列表里 codex 行也区分"没有这个窗口"（显示 — 而不是 0.0%）', () => {
    const src = read('src/features/vm/vm-list-table.tsx')
    expect(src).toMatch(/isCodexVm\(vm\) \? usedPctOrNull\(vm, '5h'\)/)
    expect(src).toMatch(/value: number \| null/)
  })
})
