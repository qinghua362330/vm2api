import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

export type SeriesPoint = { date: string; value: number; count: number }

export type OpsPayload = {
  generated_at: string
  window_days: number
  revenue: { today: number; d7: number; d30: number; all_time: number; delta_7d_pct: number | null; series: SeriesPoint[] }
  balance: { liability: number; credited_30d: number; consumed_30d: number; adjusted_30d: number }
  users: { total: number; active: number; new_7d: number; with_subscription: number; multi_bucket: number }
  orders: { pending: number; paid_30d: number; failed_30d: number; expired_30d: number; conversion: number | null }
  usage: {
    requests: number
    requests_series: SeriesPoint[]
    cost_series: SeriesPoint[]
    cost_30d: number
    tokens: { input: number; output: number }
  }
  fleet: { slots: number; schedulable: number; buckets: number; sessions_pinned: number }
  health: { channels: number; probed: number; degraded: number; alerts_24h: number; migrations_7d: number; failovers_7d: number }
  error?: string
}

export function opsQueryOptions(days = 30) {
  return queryOptions({
    queryKey: ['panel', 'ops', days] as const,
    queryFn: () => api<OpsPayload>(`/api/panel/ops?days=${days}`),
    refetchInterval: 120_000,
  })
}
