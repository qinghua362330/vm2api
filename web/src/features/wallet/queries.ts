import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { PaymentOrder } from '@/features/payments/queries'

export type LedgerEntry = {
  id: number
  user_id: string
  delta: number
  balance_after: number
  source: string
  ref?: string | null
  notes?: string | null
  created_at?: string | null
}

export type WalletUsage = {
  active: boolean
  reason?: string
  unlimited?: boolean
  quota?: number
  used?: number
  remaining?: number
  resets_at?: string | null
  subscription?: {
    id: number
    plan: string
    status: string
    daily_quota: number
    expires_at?: string | null
  }
}

export type WalletPayload = {
  user_id: string
  username?: string | null
  balance: number
  ledger?: LedgerEntry[]
  subscription?: WalletUsage
  orders?: PaymentOrder[]
  totals?: Record<string, { count: number; total: number }>
  error?: string
}

export function walletQueryOptions(userId = '') {
  return queryOptions({
    queryKey: ['panel', 'wallet', userId] as const,
    queryFn: () => api<WalletPayload>(`/api/panel/wallet${userId ? `?user_id=${encodeURIComponent(userId)}` : ''}`),
  })
}
