import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { SectionSkeleton, TableSkeleton } from '@/components/page-skeletons'
import { StatCard } from '@/components/stat-card'
import { opsQueryOptions, type SeriesPoint } from './queries'

const money = (n: number | null | undefined) => `¥${(Number(n) || 0).toFixed(2)}`
/** Last bucket date; `Array.prototype.at` is not in this tsconfig's lib. */
const lastDate = (series?: SeriesPoint[]) => (series?.length ? series[series.length - 1].date : '')
const percent = (n: number | null | undefined) =>
  n == null ? '—' : `${(Number(n) * 100).toFixed(1)}%`
const delta = (n: number | null | undefined) => {
  if (n == null) return '无基期'
  const v = Number(n)
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
}

/** Inline sparkline: dense series, so a bar per day is honest about zeros. */
function Spark({ series, className = '' }: { series: SeriesPoint[]; className?: string }) {
  const max = Math.max(1, ...series.map((p) => p.value))
  return (
    <div className={`flex h-12 items-end gap-[2px] ${className}`}>
      {series.map((point) => (
        <div
          key={point.date}
          className={`min-w-[3px] flex-1 rounded-sm ${point.value > 0 ? 'bg-primary/70' : 'bg-muted'}`}
          style={{ height: `${Math.max(2, (point.value / max) * 100)}%` }}
          title={`${point.date} · ${point.value}${point.count ? ` (${point.count})` : ''}`}
        />
      ))}
    </div>
  )
}

/**
 * 运营大盘 — money, users, usage, fleet and health on one screen.
 *
 * Deliberately separate from the fleet dashboard: that one is read every few
 * seconds by whoever watches slots, this one a few times a day by whoever
 * watches the business. Joining them would make both slow.
 *
 * Every series is dense (missing days are zeros), so a quiet day reads as a gap
 * in the bars rather than being skipped over.
 */
export function OpsPage() {
  const [days, setDays] = useState(30)
  const query = useQuery(opsQueryOptions(days))
  const data = query.data

  return (
    <PageHeader
      title='运营大盘'
      extra={
        <div className='flex items-center gap-2'>
          <span className='text-muted-foreground text-xs'>
            {data?.generated_at ? `更新于 ${new Date(data.generated_at).toLocaleTimeString()}` : ''}
          </span>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className='h-9 w-28'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[7, 14, 30, 90].map((d) => (
                <SelectItem key={d} value={String(d)}>
                  近 {d} 天
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant='outline' onClick={() => query.refetch()} loading={query.isFetching}>
            刷新
          </Button>
        </div>
      }
    >
      <QueryGate
        loading={query.isLoading}
        error={query.error || (data?.error ? new Error(data.error) : null)}
        skeleton={
          <div>
            <SectionSkeleton className='mb-4' titleWidth='w-28' showDescription={false} rows={2} />
            <TableSkeleton rows={6} columns={4} />
          </div>
        }
      >
        <div className='mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
          <StatCard
            label='今日收入'
            value={money(data?.revenue.today)}
            hint={`近 7 天 ${money(data?.revenue.d7)}（${delta(data?.revenue.delta_7d_pct)}）`}
            tone='neutral'
          />
          <StatCard
            label='余额负债'
            value={money(data?.balance.liability)}
            hint={`近 ${days} 天入账 ${money(data?.balance.credited_30d)} · 消费 ${money(data?.balance.consumed_30d)}`}
          />
          <StatCard
            label='用户'
            value={String(data?.users.total ?? 0)}
            hint={`近 7 天新增 ${data?.users.new_7d ?? 0} · 订阅 ${data?.users.with_subscription ?? 0}`}
          />
          <StatCard
            label='订单转化'
            value={percent(data?.orders.conversion)}
            hint={`待支付 ${data?.orders.pending ?? 0} · 失败 ${data?.orders.failed_30d ?? 0}`}
            tone={data?.orders.conversion != null && data.orders.conversion < 0.8 ? 'warn' : 'neutral'}
          />
        </div>

        <div className='grid gap-3 lg:grid-cols-2'>
          <Card>
            <CardHeader className='pb-2'>
              <CardDescription>收入（近 {days} 天，已支付订单）</CardDescription>
              <CardTitle className='text-base'>
                {money(data?.revenue.d30)} <span className='text-muted-foreground text-xs'>区间合计</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Spark series={data?.revenue.series || []} />
              <div className='text-muted-foreground mt-2 flex justify-between text-xs'>
                <span>{data?.revenue.series?.[0]?.date || ''}</span>
                <span>累计 {money(data?.revenue.all_time)}</span>
                <span>{lastDate(data?.revenue.series)}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className='pb-2'>
              <CardDescription>请求量（近 {days} 天）</CardDescription>
              <CardTitle className='text-base'>
                {data?.usage.requests ?? 0} <span className='text-muted-foreground text-xs'>次请求</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Spark series={data?.usage.requests_series || []} />
              <div className='text-muted-foreground mt-2 flex justify-between text-xs'>
                <span>
                  输入 {(data?.usage.tokens.input ?? 0).toLocaleString()} · 输出{' '}
                  {(data?.usage.tokens.output ?? 0).toLocaleString()}
                </span>
                <span>成本 {money(data?.usage.cost_30d)}</span>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className='mt-3 grid gap-3 lg:grid-cols-2'>
          <Card>
            <CardHeader className='pb-2'>
              <CardDescription>反代底座</CardDescription>
              <CardTitle className='text-base'>槽位 · 桶 · 会话</CardTitle>
            </CardHeader>
            <CardContent>
              <Table density='compact'>
                <TableHeader>
                  <TableRow>
                    <TableHead>指标</TableHead>
                    <TableHead className='text-right'>值</TableHead>
                    <TableHead>说明</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className='text-xs'>槽位</TableCell>
                    <TableCell className='text-right text-xs'>
                      {data?.fleet.schedulable ?? 0} / {data?.fleet.slots ?? 0}
                    </TableCell>
                    <TableCell className='text-muted-foreground text-xs'>可调度 / 总数</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className='text-xs'>桶（出口）</TableCell>
                    <TableCell className='text-right text-xs'>{data?.fleet.buckets ?? 0}</TableCell>
                    <TableCell className='text-muted-foreground text-xs'>已分配渠道的出口</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className='text-xs'>固定会话</TableCell>
                    <TableCell className='text-right text-xs'>{data?.fleet.sessions_pinned ?? 0}</TableCell>
                    <TableCell className='text-muted-foreground text-xs'>对话固定在各自桶内</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className='text-xs'>多桶用户</TableCell>
                    <TableCell className='text-right text-xs'>{data?.users.multi_bucket ?? 0}</TableCell>
                    <TableCell className='text-muted-foreground text-xs'>按 session 分流</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className='text-xs'>迁移 / 换 IP</TableCell>
                    <TableCell className='text-right text-xs'>
                      {data?.health.migrations_7d ?? 0} / {data?.health.failovers_7d ?? 0}
                    </TableCell>
                    <TableCell className='text-muted-foreground text-xs'>近 7 天 · 其中跨 IP</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className='pb-2'>
              <CardDescription>渠道健康</CardDescription>
              <CardTitle className='text-base'>
                {data?.health.channels ?? 0} 个渠道 · {data?.health.probed ?? 0} 个有样本
              </CardTitle>
            </CardHeader>
            <CardContent className='space-y-2'>
              <div className='flex flex-wrap items-center gap-2 text-xs'>
                <Badge variant={data?.health.degraded ? 'destructive' : 'secondary'}>
                  可用率异常 {data?.health.degraded ?? 0}
                </Badge>
                <Badge variant={data?.health.alerts_24h ? 'destructive' : 'outline'}>
                  24 小时告警 {data?.health.alerts_24h ?? 0}
                </Badge>
              </div>
              <Table density='compact'>
                <TableHeader>
                  <TableRow>
                    <TableHead>账目</TableHead>
                    <TableHead className='text-right'>值</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className='text-xs'>运营端人工调整</TableCell>
                    <TableCell className='text-right text-xs'>{money(data?.balance.adjusted_30d)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className='text-xs'>已过期订单</TableCell>
                    <TableCell className='text-right text-xs'>{data?.orders.expired_30d ?? 0}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className='text-xs'>活跃用户</TableCell>
                    <TableCell className='text-right text-xs'>
                      {data?.users.active ?? 0} / {data?.users.total ?? 0}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </QueryGate>
    </PageHeader>
  )
}
