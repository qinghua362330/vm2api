import { queryOptions } from '@tanstack/react-query'
import type { PanelUserDetail, PanelUsersPayload } from '@/types/panel-users'
import { api } from '@/lib/api'

export type UsersQueryParams = {
  search?: string
  role?: string
  status?: string
  /** 自定义属性筛选，序列化成 `attr_<key>=<value>`。 */
  attributes?: Record<string, string>
  page?: number
  pageSize?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

/**
 * 列表查询串。属性筛选用 `attr_<key>` 前缀，服务端按同名参数取出——两边各写一次
 * 前缀就会静默失配，所以这里单独成形并直接测。
 */
export function usersSearchParams(params: UsersQueryParams = {}): string {
  const qs = new URLSearchParams()
  if (params.search) qs.set('search', params.search)
  if (params.role) qs.set('role', params.role)
  if (params.status) qs.set('status', params.status)
  for (const [key, value] of Object.entries(params.attributes || {})) {
    if (value) qs.set(`attr_${key}`, value)
  }
  if (params.page) qs.set('page', String(params.page))
  if (params.pageSize) qs.set('page_size', String(params.pageSize))
  if (params.sortBy) qs.set('sort_by', params.sortBy)
  if (params.sortOrder) qs.set('sort_order', params.sortOrder)
  return qs.toString()
}

export function usersQueryOptions(params: UsersQueryParams = {}) {
  const suffix = usersSearchParams(params)
  return queryOptions({
    // Keyed by the serialised query (suffix) so the key cannot disagree with the request.
    queryKey: ['panel', 'users', 'list', suffix] as const,
    queryFn: () => api<PanelUsersPayload>(`/api/panel/users${suffix ? `?${suffix}` : ''}`),
  })
}

export function userDetailQueryOptions(userId: string) {
  return queryOptions({
    queryKey: ['panel', 'users', userId] as const,
    queryFn: () => api<PanelUserDetail>(`/api/panel/users/${encodeURIComponent(userId)}`),
    enabled: !!userId,
  })
}

// ── 用户属性 ────────────────────────────────────────────────────────────────

export type AttributeDef = {
  id: number
  key: string
  name: string
  type: 'text' | 'number' | 'select' | 'date' | 'bool'
  options: string[]
  default_value?: string | null
  show_in_filter: boolean
  sort_order: number
  status: 'active' | 'hidden'
  used_values: string[]
}

export function userAttributesQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'user-attributes'] as const,
    queryFn: () => api<{ attributes: AttributeDef[] }>('/api/panel/user-attributes'),
  })
}
