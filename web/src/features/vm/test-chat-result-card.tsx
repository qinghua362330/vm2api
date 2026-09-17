import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/empty-state'
import { StatusMark } from '@/components/status-mark'
import {
  type TestChatLogLine,
  type TestChatResult,
  groupTestChatStages,
  lineElapsedMs,
} from './test-chat-types'

const LEVEL_CLS: Record<string, string> = {
  error: 'text-[color:var(--status-bad)]',
  ok: 'text-[color:var(--status-ok)]',
  info: 'text-muted-foreground',
  content: 'text-foreground',
}

function fmtNum(n: unknown): string {
  const v = Number(n)
  return Number.isFinite(v) ? v.toLocaleString() : '—'
}

/**
 * 这个"失败"是不是连测试流程都没进（网络/反代/控制面问题）。
 *
 * 判据：一条日志都没有、耗时 0ms、而且带着 HTTP 状态码 —— 凭证类失败一定会先
 * 写下"开始测试凭证槽 …"这行 info，所以空日志 + 有状态码只可能是请求没到达。
 */
function transportFailed(result: TestChatResult): boolean {
  return !result.log?.length && (Number(result.error?.status) || 0) >= 500
}

/**
 * 测试对话的结果面板：状态头 → 回复正文 → usage → 错误 → 阶段化执行日志。
 * 镜像 index.html `renderVmTestPanel()` 的结果区（3880-3891）。
 *
 * 端点不是流式的，拿到的是一次性的完整结果，所以这里展示的是「回放」而非实时进度。
 */
export function TestChatResultCard({
  result,
  running,
}: {
  result: TestChatResult | null
  running: boolean
}) {
  // TestChatError 带索引签名，status 是 unknown；渲染前收成 number
  const errorStatus = Number(result?.error?.status) || 0

  if (running) {
    return (
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>结果</CardTitle>
        </CardHeader>
        <CardContent className='pt-0'>
          <p className='text-sm text-muted-foreground'>
            测试中… 正在走 loopback 发一条真实对话，耗时取决于上游响应。
          </p>
        </CardContent>
      </Card>
    )
  }

  if (!result) {
    return (
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>结果</CardTitle>
        </CardHeader>
        <CardContent className='pt-0'>
          <EmptyState reason='尚未运行。选好模型后点「开始测试」。' />
        </CardContent>
      </Card>
    )
  }

  const stages = groupTestChatStages(result.log || [])
  // level: 'content' 是模型回复正文而非日志。优先用顶层 text（完整 4000 字符），
  // 回落到 log 里那行（截断到 2000 字符）。
  const contentLine = (result.log || []).find((l) => l.level === 'content')
  const answer = result.text || contentLine?.message || ''
  const usage = result.usage

  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='flex flex-wrap items-center gap-2 text-sm'>
          结果
          <StatusMark
            tone={{
              key: result.ok ? 'ok' : 'bad',
              text: result.ok ? '成功' : '失败',
              cls: result.ok ? 'ok' : 'bad',
            }}
          />
          <span className='font-normal text-muted-foreground'>
            {result.duration_ms ?? 0}ms
            {result.model ? ` · ${result.model}` : ''}
            {result.status ? ` · HTTP ${result.status}` : ''}
            {result.stop_reason ? ` · ${result.stop_reason}` : ''}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className='space-y-3 pt-0'>
        {answer ? (
          <div className='rounded-md border border-border/60 bg-muted/30 p-3 text-sm whitespace-pre-wrap'>
            {answer}
          </div>
        ) : null}

        {usage ? (
          <div className='flex flex-wrap gap-3 text-xs text-muted-foreground'>
            <span>
              入 <b className='text-foreground'>{fmtNum(usage.input_tokens)}</b>
            </span>
            <span>
              出{' '}
              <b className='text-foreground'>{fmtNum(usage.output_tokens)}</b>
            </span>
            {usage.cache_read_input_tokens != null ? (
              <span>
                缓存读{' '}
                <b className='text-foreground'>
                  {fmtNum(usage.cache_read_input_tokens)}
                </b>
              </span>
            ) : null}
            {usage.cache_creation_input_tokens != null ? (
              <span>
                缓存写{' '}
                <b className='text-foreground'>
                  {fmtNum(usage.cache_creation_input_tokens)}
                </b>
              </span>
            ) : null}
          </div>
        ) : null}

        {!result.ok && result.error ? (
          <div className='space-y-1 rounded-md border border-[color:var(--status-bad)]/40 bg-destructive/10 p-3'>
            <p className='text-sm text-[color:var(--status-bad)]'>
              {result.error.message || '未知错误'}
            </p>
            <p className='flex flex-wrap gap-2 text-xs text-muted-foreground'>
              {errorStatus ? <span>HTTP {errorStatus}</span> : null}
              {result.error.code ? <span>code {result.error.code}</span> : null}
              {result.error.request_id ? (
                <span className='font-mono'>
                  request_id {result.error.request_id}
                </span>
              ) : null}
              {result.error.retry_after != null ? (
                <span>{result.error.retry_after}s 后可重试</span>
              ) : null}
            </p>
          </div>
        ) : null}

        <div className='space-y-2'>
          <p className='text-xs font-medium text-muted-foreground'>执行日志</p>
          {stages.length ? (
            <div className='space-y-2'>
              {stages.map((stage) => (
                <div key={stage.key} className='space-y-0.5'>
                  <div className='flex items-center gap-1.5'>
                    <Badge
                      variant={stage.failed ? 'destructive' : 'secondary'}
                      className='px-1.5 py-0 text-[10px]'
                    >
                      {stage.label}
                    </Badge>
                  </div>
                  {stage.lines.map((line, i) => (
                    <LogRow
                      key={`${stage.key}-${i}`}
                      line={line}
                      elapsed={lineElapsedMs(
                        result.log || [],
                        (result.log || []).indexOf(line)
                      )}
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : transportFailed(result) ? (
            // 0ms + 空日志 = 这个请求根本没进到测试流程：多半是反代/控制面没应答
            // （重启、502/504），不是凭证被拒。以前这里和"凭证问题"长得一模一样。
            <p className='text-xs text-muted-foreground'>
              控制面没有应答（HTTP {errorStatus || '5xx'}
              {result.error?.code ? ` · ${String(result.error.code)}` : ''}
              ）：请求没有进入测试流程，通常是网关/控制面正在重启或反代断了 ——
              稍后重试即可，不代表凭证有问题。
            </p>
          ) : (
            <p className='text-xs text-muted-foreground'>
              没有日志（请求在进入测试流程前就被拒了）。
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function LogRow({
  line,
  elapsed,
}: {
  line: TestChatLogLine
  elapsed: number | null
}) {
  return (
    <div className='flex gap-2 pl-1 font-mono text-xs break-all'>
      <span className='shrink-0 text-muted-foreground/60'>[{line.level}]</span>
      <span className={cn('whitespace-pre-wrap', LEVEL_CLS[line.level])}>
        {line.message}
      </span>
      {/* 只有「发起 → 结果」那段是真耗时，其余全挤在同一毫秒，故差值为 0 时不显示 */}
      {elapsed ? (
        <span className='ms-auto shrink-0 text-muted-foreground/60'>
          +{elapsed}ms
        </span>
      ) : null}
    </div>
  )
}
