import { queryOptions } from '@tanstack/react-query'
import type { PanelUserDetail, PanelUsersPayload } from '@/types/panel-users'
import { api } from '@/lib/api'

export type UsersQueryParams = {
  search?: string
  role?: string
  status?: string
  page?: number
  pageSize?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

export function usersQueryOptions(params: UsersQueryParams = {}) {
  const qs = new URLSearchParams()
  if (params.search) qs.set('search', params.search)
  if (params.role) qs.set('role', params.role)
  if (params.status) qs.set('status', params.status)
  if (params.page) qs.set('page', String(params.page))
  if (params.pageSize) qs.set('page_size', String(params.pageSize))
  if (params.sortBy) qs.set('sort_by', params.sortBy)
  if (params.sortOrder) qs.set('sort_order', params.sortOrder)
  const suffix = qs.toString()
  return queryOptions({
    queryKey: ['panel', 'users', params] as const,
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
