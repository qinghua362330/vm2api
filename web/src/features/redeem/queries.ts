import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

export type RedeemCode = {
  id: number
  code: string
  type: string
  value: number
  status: string
  max_uses: number
  used_count: number
  redemptions?: number
  batch?: string | null
  notes?: string | null
  expires_at?: string | null
  created_at?: string | null
}

export type RedeemPayload = { codes?: RedeemCode[]; error?: string }

export function redeemQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'redeem'] as const,
    queryFn: () => api<RedeemPayload>('/api/panel/redeem'),
  })
}
