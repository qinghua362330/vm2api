import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { LedgerEntry } from '@/features/wallet/queries'

export type LedgerPayload = {
  entries?: LedgerEntry[]
  totals?: Record<string, { count: number; total: number }>
  error?: string
}

export const LEDGER_SOURCE_LABELS: Record<string, string> = {
  redeem: '兑换码',
  payment: '充值',
  subscription: '订阅',
  admin: '人工调整',
  usage: '消费',
  refund: '退款',
}

export function ledgerQueryOptions(userId = '') {
  return queryOptions({
    queryKey: ['panel', 'ledger', userId] as const,
    queryFn: () =>
      api<LedgerPayload>(`/api/panel/billing/ledger${userId ? `?user_id=${encodeURIComponent(userId)}` : ''}`),
  })
}
