import { queryOptions } from '@tanstack/react-query'
import type { EgressBindingsPayload, EgressUserDetail } from '@/types/panel-egress'
import { api } from '@/lib/api'

export function egressBindingsQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'egress-bindings'] as const,
    queryFn: () => api<EgressBindingsPayload>('/api/panel/egress-bindings'),
    // `pending` is a dry-run preview of the next sweep, so it goes stale fast.
    staleTime: 5_000,
  })
}

export function egressUserQueryOptions(userId: string) {
  return queryOptions({
    queryKey: ['panel', 'egress-bindings', userId] as const,
    queryFn: () =>
      api<EgressUserDetail>(`/api/panel/egress-bindings/${encodeURIComponent(userId)}`),
    enabled: !!userId,
  })
}
