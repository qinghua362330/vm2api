import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

export type PaymentOrder = {
  id: number
  order_no: string
  user_id: string
  channel: string
  amount: number
  currency: string
  credit: number
  status: 'pending' | 'paid' | 'failed' | 'expired' | 'refunded'
  package_id?: string | null
  provider_trade_no?: string | null
  paid_at?: string | null
  expires_at?: string | null
  fail_reason?: string | null
  created_at?: string | null
}

export type PaymentConfig = {
  enabled: boolean
  order_ttl_minutes: number
  min_amount: number
  packages: { id: string; name: string; amount: number; credit: number }[]
  channels: {
    easypay: { enabled: boolean; pid: string; key: string; submit_url: string; notify_url: string; return_url: string }
    stripe: { enabled: boolean; publishable_key: string; secret_key: string; webhook_secret: string; currency: string }
  }
}

export type OrdersPayload = {
  orders?: PaymentOrder[]
  totals?: Record<string, { count: number; amount: number; credit: number }>
  error?: string
}

export function ordersQueryOptions(status = '') {
  return queryOptions({
    queryKey: ['panel', 'payments', 'orders', status] as const,
    queryFn: () =>
      api<OrdersPayload>(`/api/panel/payments/orders${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  })
}

export function paymentConfigQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'payments', 'config'] as const,
    queryFn: () => api<{ config: PaymentConfig; usable_channels: string[] }>('/api/panel/payments/config'),
  })
}
