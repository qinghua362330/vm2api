import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

export type EgressHealth = {
  egress_id: string
  samples: number
  ok_count: number
  availability: number | null
  latency_p50: number | null
  latency_p95: number | null
  consecutive_failures: number
  last_ok_at?: string | null
  last_error?: string | null
}

export type ChannelHealthRow = {
  channel_id: number
  name: string
  status: string
  buckets: EgressHealth[]
  health: Omit<EgressHealth, 'egress_id'>
}

export type AlertRule = {
  id: number
  name: string
  channel_id: number | null
  metric: 'availability' | 'latency_p95' | 'consecutive_failures'
  comparator: 'lt' | 'gt'
  threshold: number
  window_minutes: number
  min_samples: number
  severity: 'info' | 'warn' | 'critical'
  enabled: boolean
  cooldown_minutes: number
  last_fired_at?: string | null
}

export type AlertEvent = {
  id: number
  rule_id: number
  channel_id: number | null
  metric: string
  value: number | null
  threshold: number | null
  severity: string
  message: string
  fired_at: string
}

export type ChannelMonitorPayload = {
  window_minutes: number
  channels?: ChannelHealthRow[]
  rules?: AlertRule[]
  events?: AlertEvent[]
  error?: string
}

export const METRIC_LABELS: Record<string, string> = {
  availability: '可用率',
  latency_p95: 'P95 延迟',
  consecutive_failures: '连续失败',
}
export const SEVERITY_LABELS: Record<string, string> = { info: '提示', warn: '警告', critical: '严重' }

export function channelMonitorQueryOptions(windowMinutes = 30) {
  return queryOptions({
    queryKey: ['panel', 'channel-monitor', windowMinutes] as const,
    queryFn: () => api<ChannelMonitorPayload>(`/api/panel/channel-monitor?window=${windowMinutes}`),
    refetchInterval: 60_000,
  })
}
