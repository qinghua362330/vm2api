import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TestChatResultCard } from './test-chat-result-card'
import type { TestChatResult } from './test-chat-types'

/**
 * 两种"失败"必须长得不一样。
 *
 * 线上把它们混成了一句「请求失败 / 没有日志」，于是一次反代 502（我在重启控制面）
 * 被读成"这个账号凭证不能用了"。凭证类失败一定会先写日志（"开始测试凭证槽 …"），
 * 所以判据很干净：空日志 + HTTP 5xx = 请求根本没到，别赖凭证。
 */

const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function render(result: TestChatResult) {
  return textOf(
    renderToStaticMarkup(<TestChatResultCard result={result} running={false} />)
  )
}

describe('测试结果卡：控制面没应答 vs 凭证/上游失败', () => {
  it('0ms + 空日志 + HTTP 502 → 说清是控制面没应答，不是凭证', () => {
    const text = render({
      ok: false,
      duration_ms: 0,
      log: [],
      error: { message: '请求失败', status: 502 },
    })
    expect(text).toContain('控制面没有应答')
    expect(text).toContain('HTTP 502')
    expect(text).toContain('不代表凭证有问题')
  })

  it('进了流程的失败（有日志）仍然按上游错误展示，并回显原因', () => {
    const text = render({
      ok: false,
      duration_ms: 165,
      log: [
        {
          at: '2026-09-17T09:54:06.000Z',
          level: 'info',
          message: '开始测试凭证槽 03',
        },
      ],
      error: {
        code: 'codex_cli_failed',
        message: 'Selected model is at capacity. Please try a different model.',
        status: 502,
      },
    })
    expect(text).toContain('Selected model is at capacity')
    expect(text).toContain('codex_cli_failed')
    expect(text).not.toContain('控制面没有应答')
  })

  it('凭证门禁类早退（4xx、空日志）不谎报成控制面故障', () => {
    const text = render({
      ok: false,
      duration_ms: 0,
      log: [],
      error: {
        message: 'VM has no Codex credential',
        code: 'no_credential',
        status: 400,
      },
    })
    expect(text).toContain('VM has no Codex credential')
    expect(text).not.toContain('控制面没有应答')
  })
})
