import { createFileRoute } from '@tanstack/react-router'
import { ChannelMonitorPage } from '@/features/channel-monitor'

export const Route = createFileRoute('/_authenticated/channel-monitor')({
  component: ChannelMonitorPage,
})
