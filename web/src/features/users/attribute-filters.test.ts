import { describe, expect, it } from 'vitest'
import { attributeValueLabel } from './attribute-label'
import { usersSearchParams, type AttributeDef } from './queries'

function def(patch: Partial<AttributeDef> = {}): AttributeDef {
  return {
    id: 1,
    key: 'source',
    name: '渠道来源',
    type: 'text',
    options: [],
    show_in_filter: true,
    sort_order: 0,
    status: 'active',
    used_values: [],
    ...patch,
  }
}

describe('usersSearchParams', () => {
  it('把属性筛选写成服务端认识的前缀', () => {
    const qs = usersSearchParams({
      attributes: { source: '抖音', risk: 'true' },
      page: 2,
    })
    const parsed = new URLSearchParams(qs)
    // 服务端在 panel-routes 里按 attr_ 前缀取参；前缀写错只会得到"筛选无效"。
    expect(parsed.get('attr_source')).toBe('抖音')
    expect(parsed.get('attr_risk')).toBe('true')
    expect(parsed.get('page')).toBe('2')
  })

  it('空值既不占参数也不影响键', () => {
    const qs = usersSearchParams({
      attributes: { source: '', risk: '' },
      search: '',
    })
    expect(qs).toBe('')
  })

  it('筛选值里带 & 和 = 时仍然是单个参数', () => {
    const parsed = new URLSearchParams(
      usersSearchParams({ attributes: { note: 'a&b=c' } })
    )
    expect(parsed.get('attr_note')).toBe('a&b=c')
    expect([...parsed.keys()]).toEqual(['attr_note'])
  })

  it('同一属性不同取值给出不同的查询串', () => {
    const a = usersSearchParams({ attributes: { source: '抖音' } })
    const b = usersSearchParams({ attributes: { source: 'B站' } })
    expect(a).not.toBe(b)
  })
})

describe('attributeValueLabel', () => {
  it('布尔按存储值翻译成中文', () => {
    const bool = def({ type: 'bool' })
    expect(attributeValueLabel(bool, 'true')).toBe('是')
    expect(attributeValueLabel(bool, 'false')).toBe('否')
  })

  it('日期渲染成本地日期而不是 ISO 串', () => {
    const date = def({ type: 'date' })
    const iso = new Date('2024-03-05T00:00:00.000Z').toISOString()
    expect(attributeValueLabel(date, iso)).not.toContain('T')
  })

  it('空值显示占位符，不显示 null', () => {
    expect(attributeValueLabel(def(), '')).toBe('—')
  })
})
