import { describe, expect, it } from 'vitest'
import { pct, remainPct, usedPctOf, usedPctOrNull } from '@/lib/format'

describe('usedPctOf', () => {
  it('prefers Codex used_percent and does not scale it', () => {
    expect(
      usedPctOf(
        {
          utilization_5h: 0.06,
          utilization_7d: 0.34,
          codex_usage: {
            windows: [
              { id: '5h', used_percent: 6 },
              { id: '7d', used_percent: 34 },
            ],
          },
        },
        '5h'
      )
    ).toBe(6)
    expect(
      usedPctOf(
        {
          utilization_5h: 1,
          codex_usage: { windows: [{ id: '5h', used_percent: 1 }] },
        },
        '5h'
      )
    ).toBe(1)
  })

  it('falls back to utilization ratio', () => {
    expect(usedPctOf({ utilization_5h: 0.12, utilization_7d: 0.4 }, '7d')).toBe(
      40
    )
  })
})

describe('pct', () => {
  it('keeps leftover 0-100 numbers', () => {
    expect(pct(12)).toBe(12)
    expect(remainPct(12)).toBe(88)
  })

  it('treats 0-1 utilization as a fraction', () => {
    expect(pct(0.12)).toBe(12)
  })
})

describe('usedPctOrNull（"没用过" vs "没这个窗口"）', () => {
  it('没有窗口时返回 null，而不是 0', () => {
    expect(
      usedPctOrNull({ utilization_5h: null, utilization_7d: 0.62 }, '5h')
    ).toBe(null)
    expect(usedPctOrNull({}, '7d')).toBe(null)
    expect(usedPctOrNull(null, '5h')).toBe(null)
  })

  it('真的 0% 仍然是 0（不是 null）', () => {
    expect(usedPctOrNull({ utilization_5h: 0, utilization_7d: 0 }, '5h')).toBe(
      0
    )
    expect(usedPctOrNull({ utilization_7d: 0.62 }, '7d')).toBe(62)
  })

  it('codex 的窗口数组优先于 utilization 字段', () => {
    const src = {
      utilization_7d: 0.1,
      codex_usage: { windows: [{ id: '7d', used_percent: 42 }] },
    }
    expect(usedPctOrNull(src, '7d')).toBe(42)
    expect(
      usedPctOrNull(
        { codex_usage: { windows: [{ id: '5h', used_percent: '' }] } },
        '5h'
      )
    ).toBe(null)
  })
})
