import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { TableSkeleton } from '@/components/page-skeletons'
import { StatCard } from '@/components/stat-card'
import {
  METRIC_LABELS,
  SEVERITY_LABELS,
  channelMonitorQueryOptions,
  type AlertRule,
} from './queries'

const WINDOWS = [15, 30, 60, 180]

function availabilityTone(value: number | null): string {
  if (value == null) return 'text-muted-foreground'
  if (value >= 0.99) return 'text-ok-3'
  if (value >= 0.9) return 'text-caution-3'
  return 'text-destructive'
}

const fmtAvailability = (value: number | null) => (value == null ? '无样本' : `${(value * 100).toFixed(1)}%`)
const fmtLatency = (value: number | null) => (value == null ? '—' : `${Math.round(value)}ms`)

type FormState = {
  name: string
  channelId: string
  metric: string
  comparator: string
  threshold: string
  windowMinutes: string
  minSamples: string
  severity: string
  cooldownMinutes: string
}

const EMPTY: FormState = {
  name: '',
  channelId: '',
  metric: 'availability',
  comparator: 'lt',
  threshold: '0.9',
  windowMinutes: '30',
  minSamples: '3',
  severity: 'warn',
  cooldownMinutes: '30',
}

/**
 * 渠道监控 — availability and latency per channel and per bucket, plus the rules
 * that alert on them.
 *
 * Health comes from a window of probes, not from the latest sample: an
 * availability of 无样本 is deliberately distinct from 0%, so a channel nobody
 * has probed does not read as down.
 */
export function ChannelMonitorPage() {
  const qc = useQueryClient()
  const [windowMinutes, setWindowMinutes] = useState(30)
  const query = useQuery(channelMonitorQueryOptions(windowMinutes))
  const [editing, setEditing] = useState<AlertRule | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [deleting, setDeleting] = useState<AlertRule | null>(null)

  const data = query.data
  const channels = data?.channels || []
  const rules = data?.rules || []
  const events = data?.events || []
  const refresh = () => qc.invalidateQueries({ queryKey: ['panel', 'channel-monitor'] })

  const run = useMutation({
    mutationFn: (probe: boolean) =>
      api<{ probe?: { total?: number } | null; fired?: unknown[]; suppressed?: unknown[] }>(
        '/api/panel/channel-monitor/run',
        { method: 'POST', body: JSON.stringify({ probe }) },
      ),
    onSuccess: async (res) => {
      const probed = res?.probe?.total
      toast.success(
        `${probed != null ? `已探测 ${probed} 个出口，` : ''}触发 ${res?.fired?.length ?? 0} 条告警，冷却中 ${res?.suppressed?.length ?? 0} 条`,
      )
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name,
        channel_id: form.channelId ? Number(form.channelId) : null,
        metric: form.metric,
        comparator: form.comparator,
        threshold: Number(form.threshold),
        window_minutes: Number(form.windowMinutes),
        min_samples: Number(form.minSamples),
        severity: form.severity,
        cooldown_minutes: Number(form.cooldownMinutes),
      }
      return editing
        ? api(`/api/panel/channel-monitor/rules/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : api('/api/panel/channel-monitor/rules', { method: 'POST', body: JSON.stringify(body) })
    },
    onSuccess: async () => {
      toast.success(editing ? '已保存' : '已创建')
      setEditing(null)
      setCreating(false)
      setForm(EMPTY)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/panel/channel-monitor/rules/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success('已删除')
      setDeleting(null)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const probedChannels = channels.filter((c) => c.health.samples > 0)
  const degraded = probedChannels.filter((c) => (c.health.availability ?? 1) < 0.9).length
  const totalBuckets = channels.reduce((sum, c) => sum + c.buckets.length, 0)

  return (
    <PageHeader
      title='渠道监控'
      extra={
        <div className='flex items-center gap-2'>
          <Select value={String(windowMinutes)} onValueChange={(v) => setWindowMinutes(Number(v))}>
            <SelectTrigger className='h-9 w-32'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOWS.map((w) => (
                <SelectItem key={w} value={String(w)}>
                  近 {w} 分钟
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant='outline' loading={run.isPending} onClick={() => run.mutate(true)}>
            探测并评估
          </Button>
          <Button
            onClick={() => {
              setCreating(true)
              setForm(EMPTY)
            }}
          >
            新建告警规则
          </Button>
        </div>
      }
    >
      <div className='mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
        <StatCard label='渠道' value={String(channels.length)} hint={`${totalBuckets} 个桶`} />
        <StatCard
          label='有样本'
          value={String(probedChannels.length)}
          hint={probedChannels.length ? '窗口内有探测' : '还没探测过'}
        />
        <StatCard
          label='可用率异常'
          value={String(degraded)}
          hint="低于 90%"
          tone={degraded ? 'warn' : 'neutral'}
        />
        <StatCard label='告警规则' value={String(rules.length)} hint={`${events.length} 条触发记录`} />
      </div>

      <QueryGate
        loading={query.isLoading}
        error={query.error || (data?.error ? new Error(data.error) : null)}
        skeleton={<TableSkeleton rows={8} columns={6} />}
      >
        <div className='space-y-3'>
          <Card>
            <CardHeader className='pb-2'>
              <CardDescription>渠道健康度</CardDescription>
              <CardTitle className='text-base'>按窗口统计，不是最后一笔</CardTitle>
            </CardHeader>
            <CardContent>
              {channels.length ? (
                <Table density='compact'>
                  <TableHeader>
                    <TableRow>
                      <TableHead>渠道</TableHead>
                      <TableHead>可用率</TableHead>
                      <TableHead>P50 / P95</TableHead>
                      <TableHead>连续失败</TableHead>
                      <TableHead>样本</TableHead>
                      <TableHead>桶明细</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {channels.map((channel) => (
                      <TableRow key={channel.channel_id}>
                        <TableCell className='text-xs'>
                          <div className='flex items-center gap-2'>
                            <span className='font-medium'>{channel.name}</span>
                            <span className='text-muted-foreground font-mono'>#{channel.channel_id}</span>
                            {channel.status !== 'active' ? <Badge variant='outline'>停用</Badge> : null}
                          </div>
                        </TableCell>
                        <TableCell className={`text-xs ${availabilityTone(channel.health.availability)}`}>
                          {fmtAvailability(channel.health.availability)}
                        </TableCell>
                        <TableCell className='text-xs'>
                          {fmtLatency(channel.health.latency_p50)} / {fmtLatency(channel.health.latency_p95)}
                        </TableCell>
                        <TableCell className='text-xs'>
                          {channel.health.consecutive_failures > 0 ? (
                            <span className='text-destructive'>{channel.health.consecutive_failures} 次</span>
                          ) : (
                            '0'
                          )}
                        </TableCell>
                        <TableCell className='text-muted-foreground text-xs'>{channel.health.samples}</TableCell>
                        <TableCell>
                          <div className='flex flex-wrap gap-1'>
                            {channel.buckets.length ? (
                              channel.buckets.map((bucket) => (
                                <Badge
                                  key={bucket.egress_id}
                                  variant='outline'
                                  className='font-mono text-xs'
                                  title={
                                    bucket.samples
                                      ? `${bucket.egress_id} · ${fmtAvailability(bucket.availability)} · ${fmtLatency(bucket.latency_p95)}${bucket.last_error ? ` · ${bucket.last_error}` : ''}`
                                      : `${bucket.egress_id} · 无样本`
                                  }
                                >
                                  <span className={availabilityTone(bucket.availability)}>
                                    {bucket.egress_id}
                                  </span>
                                </Badge>
                              ))
                            ) : (
                              <span className='text-muted-foreground text-xs'>未分配桶</span>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className='text-muted-foreground py-6 text-center text-sm'>
                  还没有渠道。建渠道并分配桶之后这里才会有健康度。
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className='pb-2'>
              <CardDescription>告警规则</CardDescription>
              <CardTitle className='text-base'>阈值 · 最小样本 · 冷却</CardTitle>
            </CardHeader>
            <CardContent>
              {rules.length ? (
                <Table density='compact'>
                  <TableHeader>
                    <TableRow>
                      <TableHead>规则</TableHead>
                      <TableHead>条件</TableHead>
                      <TableHead>范围</TableHead>
                      <TableHead>最小样本</TableHead>
                      <TableHead>冷却</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className='text-right'>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rules.map((rule) => (
                      <TableRow key={rule.id}>
                        <TableCell className='text-xs font-medium'>{rule.name}</TableCell>
                        <TableCell className='text-xs'>
                          {METRIC_LABELS[rule.metric] || rule.metric} {rule.comparator === 'gt' ? '>' : '<'}{' '}
                          {rule.metric === 'availability'
                            ? `${(rule.threshold * 100).toFixed(0)}%`
                            : rule.threshold}
                          <span className='text-muted-foreground'> / {rule.window_minutes} 分钟</span>
                        </TableCell>
                        <TableCell className='text-xs'>
                          {rule.channel_id == null ? '全部渠道' : `#${rule.channel_id}`}
                        </TableCell>
                        <TableCell className='text-muted-foreground text-xs'>{rule.min_samples}</TableCell>
                        <TableCell className='text-muted-foreground text-xs'>{rule.cooldown_minutes} 分钟</TableCell>
                        <TableCell>
                          <div className='flex items-center gap-1'>
                            <Badge variant={rule.severity === 'critical' ? 'destructive' : 'outline'}>
                              {SEVERITY_LABELS[rule.severity] || rule.severity}
                            </Badge>
                            {rule.enabled ? null : <Badge variant='outline'>已停用</Badge>}
                            {rule.last_fired_at ? (
                              <span className='text-muted-foreground text-xs'>
                                {new Date(rule.last_fired_at).toLocaleTimeString()}
                              </span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className='text-right'>
                          <div className='flex justify-end gap-1'>
                            <Button
                              size='sm'
                              variant='ghost'
                              onClick={() => {
                                setEditing(rule)
                                setForm({
                                  name: rule.name,
                                  channelId: rule.channel_id == null ? '' : String(rule.channel_id),
                                  metric: rule.metric,
                                  comparator: rule.comparator,
                                  threshold: String(rule.threshold),
                                  windowMinutes: String(rule.window_minutes),
                                  minSamples: String(rule.min_samples),
                                  severity: rule.severity,
                                  cooldownMinutes: String(rule.cooldown_minutes),
                                })
                              }}
                            >
                              编辑
                            </Button>
                            <Button size='sm' variant='ghost' className='text-destructive' onClick={() => setDeleting(rule)}>
                              删除
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className='text-muted-foreground py-6 text-center text-sm'>
                  还没有告警规则。建议先加一条「可用率 &lt; 90%」。
                </p>
              )}
            </CardContent>
          </Card>

          {events.length ? (
            <Card>
              <CardHeader className='pb-2'>
                <CardDescription>最近触发</CardDescription>
              </CardHeader>
              <CardContent className='space-y-1 text-xs'>
                {events.slice(0, 15).map((event) => (
                  <div key={event.id} className='flex flex-wrap items-center gap-2'>
                    <Badge variant={event.severity === 'critical' ? 'destructive' : 'outline'}>
                      {SEVERITY_LABELS[event.severity] || event.severity}
                    </Badge>
                    <span>{event.message}</span>
                    <span className='text-muted-foreground'>{new Date(event.fired_at).toLocaleString()}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </QueryGate>

      <Dialog
        open={creating || !!editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false)
            setEditing(null)
            setForm(EMPTY)
          }
        }}
      >
        <DialogContent className='max-w-lg'>
          <DialogHeader>
            <DialogTitle>{editing ? `编辑 ${editing.name}` : '新建告警规则'}</DialogTitle>
            <DialogDescription>
              样本数不足时不报警；冷却期内不重复触发。阈值不设默认值 —— 猜错会报出没人要的告警。
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-3 py-2'>
            <div className='grid gap-1.5'>
              <Label htmlFor='ar-name'>名称</Label>
              <Input id='ar-name' value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className='grid gap-3 sm:grid-cols-2'>
              <div className='grid gap-1.5'>
                <Label>指标</Label>
                <Select
                  value={form.metric}
                  onValueChange={(metric) =>
                    setForm({ ...form, metric, comparator: metric === 'availability' ? 'lt' : 'gt' })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='availability'>可用率</SelectItem>
                    <SelectItem value='latency_p95'>P95 延迟</SelectItem>
                    <SelectItem value='consecutive_failures'>连续失败</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className='grid gap-1.5'>
                <Label>比较</Label>
                <Select value={form.comparator} onValueChange={(comparator) => setForm({ ...form, comparator })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='lt'>小于</SelectItem>
                    <SelectItem value='gt'>大于</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className='grid gap-1.5'>
                <Label htmlFor='ar-threshold'>
                  阈值{form.metric === 'availability' ? '（0-1，如 0.9）' : form.metric === 'latency_p95' ? '（毫秒）' : '（次数）'}
                </Label>
                <Input
                  id='ar-threshold'
                  value={form.threshold}
                  onChange={(e) => setForm({ ...form, threshold: e.target.value })}
                />
              </div>
              <div className='grid gap-1.5'>
                <Label>范围</Label>
                <Select
                  value={form.channelId || 'all'}
                  onValueChange={(v) => setForm({ ...form, channelId: v === 'all' ? '' : v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='all'>全部渠道</SelectItem>
                    {channels.map((channel) => (
                      <SelectItem key={channel.channel_id} value={String(channel.channel_id)}>
                        {channel.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className='grid gap-1.5'>
                <Label htmlFor='ar-window'>窗口（分钟）</Label>
                <Input
                  id='ar-window'
                  value={form.windowMinutes}
                  onChange={(e) => setForm({ ...form, windowMinutes: e.target.value })}
                />
              </div>
              <div className='grid gap-1.5'>
                <Label htmlFor='ar-min'>最小样本</Label>
                <Input
                  id='ar-min'
                  value={form.minSamples}
                  onChange={(e) => setForm({ ...form, minSamples: e.target.value })}
                />
              </div>
              <div className='grid gap-1.5'>
                <Label>级别</Label>
                <Select value={form.severity} onValueChange={(severity) => setForm({ ...form, severity })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='info'>提示</SelectItem>
                    <SelectItem value='warn'>警告</SelectItem>
                    <SelectItem value='critical'>严重</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className='grid gap-1.5'>
                <Label htmlFor='ar-cool'>冷却（分钟）</Label>
                <Input
                  id='ar-cool'
                  value={form.cooldownMinutes}
                  onChange={(e) => setForm({ ...form, cooldownMinutes: e.target.value })}
                />
              </div>
            </div>
            {editing ? (
              <div className='flex items-center gap-2'>
                <Checkbox
                  id='ar-enabled'
                  checked={editing.enabled}
                  onCheckedChange={(enabled) => setEditing({ ...editing, enabled: !!enabled })}
                />
                <Label htmlFor='ar-enabled' className='text-sm font-normal'>
                  启用
                </Label>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => {
                setCreating(false)
                setEditing(null)
              }}
            >
              取消
            </Button>
            <Button
              loading={save.isPending}
              disabled={!form.name || !form.threshold}
              onClick={() => {
                if (editing && !editing.enabled) {
                  api(`/api/panel/channel-monitor/rules/${editing.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ enabled: false }),
                  }).finally(() => save.mutate())
                  return
                }
                save.mutate()
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleting} onOpenChange={() => setDeleting(null)}>
        <DialogContent className='max-w-md'>
          <DialogHeader>
            <DialogTitle>删除告警规则</DialogTitle>
            <DialogDescription>删除「{deleting?.name}」？已触发的历史记录会保留。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant='outline' onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button
              variant='destructive'
              loading={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.id)}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageHeader>
  )
}
