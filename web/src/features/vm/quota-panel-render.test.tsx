import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OpenaiQuotaPanel } from './openai-quota-panel'

/**
 * 渲染级断言：卡片上真正显示的数字。
 *
 * 只断言源码文本是不够的 —— 上一轮的 bug 就是"源码看着对、单位算重了"：
 * 入参是 62（百分比），卡片又乘 100，`Meter` 夹到 100%，用户看到「7 天已用 100%」。
 * 这里直接把组件渲染成静态 HTML，检查人眼看到的那几个字符。
 */

const baseVm = {
  id: 'vm-03',
  platform: 'openai',
  family: 'codex',
  status: 'running',
  reset_7d: '2026-09-21T04:00:48.000Z',
  status_7d: 'ok',
  reset_credits: { available_count: 0, credits: [] },
} as unknown as Vm

function render(props: { u5: number | null; u7: number | null }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <OpenaiQuotaPanel
        vm={baseVm}
        u5={props.u5}
        u7={props.u7}
        now={Date.now()}
      />
    </QueryClientProvider>
  )
}

/** 把 HTML 收成纯文本，免得断言碰到属性里的数字 */
const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

describe('Codex 额度卡渲染出来的数字', () => {
  it('7 天 62% 显示 62，不是 6200 / 100', () => {
    const text = textOf(render({ u5: null, u7: 62 }))
    expect(text).toContain('7 天已用')
    expect(text).toMatch(/\b62%/)
    expect(text).not.toContain('6200')
    expect(text).not.toMatch(/\b100%/)
  })

  it('没有 5 小时窗口时说清楚，而不是画成 0%', () => {
    const text = textOf(render({ u5: null, u7: 62 }))
    expect(text).toContain('该套餐没有')
    expect(text).not.toContain('5 小时已用')
  })

  it('窗口真为 0% 时才显示 0%', () => {
    const text = textOf(render({ u5: 0, u7: 62 }))
    expect(text).toContain('5 小时已用')
    expect(text).toMatch(/\b0%/)
  })

  it('两个窗口都没有快照时两条都提示，不假装 0%', () => {
    const text = textOf(render({ u5: null, u7: null }))
    expect(text).toContain('该套餐没有')
    expect(text).toContain('还没有数据')
  })
})
