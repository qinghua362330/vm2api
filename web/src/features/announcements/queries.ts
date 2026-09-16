import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

export type Announcement = {
  id: number
  title: string
  body: string
  level: 'info' | 'warn' | 'critical'
  status: 'draft' | 'published' | 'archived'
  audience: string
  pinned: boolean
  starts_at?: string | null
  ends_at?: string | null
  created_at?: string | null
}

export type AnnouncementsPayload = { announcements?: Announcement[]; error?: string }

export function announcementsQueryOptions(all = false) {
  return queryOptions({
    queryKey: ['panel', 'announcements', all] as const,
    queryFn: () => api<AnnouncementsPayload>(`/api/panel/announcements${all ? '?all=1' : ''}`),
  })
}
