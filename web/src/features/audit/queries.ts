import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

export type AuditEntry = {
  id: number
  actor?: string | null
  actor_role?: string | null
  action: string
  target_type?: string | null
  target_id?: string | null
  detail?: unknown
  ip?: string | null
  created_at?: string | null
}

export type AuditPayload = {
  entries?: AuditEntry[]
  stats?: { total: number; actions: { action: string; count: number; last_at?: string | null }[] }
  error?: string
}

export const ACTION_LABELS: Record<string, string> = {
  'user.create': '新建用户',
  'user.update': '修改用户',
  'user.delete': '删除用户',
  'channel.create': '新建渠道',
  'channel.update': '修改渠道',
  'channel.delete': '删除渠道',
  'channel.set_buckets': '调整渠道桶',
  'channel.set_pricing': '调整渠道定价',
  'redeem.create_batch': '生成兑换码',
  'redeem.delete': '删除兑换码',
  'redeem.use': '核销兑换码',
  'subscription.grant': '授予订阅',
  'subscription.update': '修改订阅',
  'subscription.revoke': '撤销订阅',
  'payment.update_config': '修改支付配置',
  'payment.confirm': '人工确认入账',
  'balance.adjust': '人工调账',
  'egress.rebind': '改绑出口 IP',
  'egress.migrate': '同 IP 换槽',
  'egress.release': '释放槽用户',
  'egress.cool': '槽冷却',
  'egress.sweep': '迁移扫描',
  'announcement.create': '发布公告',
  'announcement.update': '修改公告',
  'announcement.delete': '删除公告',
  'audit.purge': '清理审计日志',
}

export function auditQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'audit-logs'] as const,
    queryFn: () => api<AuditPayload>('/api/panel/audit-logs?limit=300'),
  })
}
