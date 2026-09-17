import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

export type SubscriptionWindow = {
  open: boolean
  unlimited?: boolean
  quota?: number
  used?: number
  remaining?: number
  rolled?: boolean
  resets_at?: string | null
  reason?: string
}

export type PanelSubscription = {
  id: number
  user_id: string
  plan: string
  status: 'active' | 'expired' | 'revoked'
  daily_quota: number
  daily_used: number
  window_start?: string | null
  starts_at?: string | null
  expires_at?: string | null
  notes: string
  created_at?: string | null
  days_left?: number | null
  window?: SubscriptionWindow
}

export type SubscriptionsPayload = { subscriptions?: PanelSubscription[]; error?: string }

export function subscriptionsQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'subscriptions'] as const,
    queryFn: () => api<SubscriptionsPayload>('/api/panel/subscriptions'),
  })
}
