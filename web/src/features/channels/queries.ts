import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

export type ChannelPricingRow = {
  models: string[]
  input_price?: number | null
  output_price?: number | null
  cache_write_price?: number | null
  cache_read_price?: number | null
  per_request_price?: number | null
}

export type PanelChannel = {
  id: number
  name: string
  description: string
  status: string
  restrict_models: boolean
  rate_multiplier: number
  buckets: string[]
  bucket_count: number
  users: string[]
  user_count: number
  pricing: ChannelPricingRow[]
  created_at?: string | null
}

export type PanelChannelsPayload = { channels?: PanelChannel[]; error?: string }

export function channelsQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'channels'] as const,
    queryFn: () => api<PanelChannelsPayload>('/api/panel/channels'),
  })
}

export function channelDetailQueryOptions(id: number) {
  return queryOptions({
    queryKey: ['panel', 'channels', id] as const,
    queryFn: () => api<{ channel: PanelChannel }>(`/api/panel/channels/${id}`),
    enabled: Number.isFinite(id) && id > 0,
  })
}
