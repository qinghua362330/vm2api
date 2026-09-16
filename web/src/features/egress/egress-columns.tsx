import { useMemo } from 'react'
import { type ColumnDef } from '@tanstack/react-table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DataTableColumnHeader } from '@/components/data-table'
import type { EgressBindingRow } from '@/types/panel-egress'
import { cn } from '@/lib/utils'
import {
  egressLabel,
  migrationReasonLabel,
  reasonCrossesEgress,
  slotStateClass,
  slotStateView,
} from './slot-state'

export type EgressColumnHandlers = {
  sessionsByEgress: Record<string, number>
  pendingByUser: Map<string, string>
  busy: boolean
  onMigrate: (userId: string) => void
  onRebind: (userId: string) => void
  onRelease: (slotId: string) => void
  onCool: (slotId: string) => void
  onDetail: (userId: string) => void
}

/**
 * 用户 · 出口 IP · 桶/会话 · 槽 · 凭证 · 状态 · 迁移
 *
 * `slot_state` is the scheduler's live verdict, so the status column answers
 * "why is traffic not going here" rather than just colouring a cell.
 */
export function useEgressColumns(handlers: EgressColumnHandlers): ColumnDef<EgressBindingRow>[] {
  const { sessionsByEgress, pendingByUser, busy } = handlers
  return useMemo(
    () => [
      {
        id: 'select',
        header: ({ table }) => (
          <Checkbox
            checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && 'indeterminate')}
            onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
            aria-label='全选'
            className='translate-y-[2px]'
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label='选择该行'
            className='translate-y-[2px]'
          />
        ),
        enableSorting: false,
        enableHiding: false,
      },
      {
        accessorKey: 'user_id',
        header: ({ column }) => <DataTableColumnHeader column={column} title='用户' />,
        cell: ({ row }) => (
          <div className='flex items-center gap-2'>
            <div className='bg-primary/10 text-primary flex h-7 w-7 shrink-0 items-center justify-center rounded-full'>
              <span className='text-xs font-medium'>{row.original.user_id.charAt(0).toUpperCase()}</span>
            </div>
            <span className='font-mono text-xs'>{row.original.user_id}</span>
          </div>
        ),
      },
      {
        accessorKey: 'egress_id',
        header: ({ column }) => <DataTableColumnHeader column={column} title='出口 IP' />,
        // The toolbar facet is 代理/本机共享, so filter on the kind rather than
        // on the raw id the column displays.
        filterFn: (row, _id, value: string[]) => value.includes(row.original.egress_kind || 'proxy'),
        cell: ({ row }) => (
          <div className='flex items-center gap-2'>
            <span className='font-mono text-xs'>{egressLabel(row.original)}</span>
            {row.original.egress_kind === 'direct' ? <Badge variant='outline'>共享</Badge> : null}
          </div>
        ),
      },
      {
        id: 'buckets',
        header: '桶 / 会话',
        cell: ({ row }) => {
          const count = row.original.bucket_count ?? 1
          return (
            <div className='flex items-center gap-2 text-xs'>
              <span title={(row.original.buckets || []).join('、')}>{count} 个桶</span>
              {count > 1 ? (
                <Badge variant='outline' title='对话按 session 固定在各桶内'>
                  按会话分流
                </Badge>
              ) : null}
              <span className='text-muted-foreground'>会话 {sessionsByEgress[row.original.egress_id] ?? 0}</span>
            </div>
          )
        },
        enableSorting: false,
      },
      {
        accessorKey: 'slot_id',
        header: '槽',
        cell: ({ row }) => (
          <div className='flex items-center gap-2'>
            <span className='font-mono text-xs'>
              {row.original.slot_id || <span className='text-destructive'>无</span>}
            </span>
            {row.original.slot_present === false ? <Badge variant='destructive'>已删除</Badge> : null}
          </div>
        ),
        enableSorting: false,
      },
      {
        id: 'credential',
        header: '凭证',
        cell: ({ row }) => {
          const cred = row.original.credential
          if (!cred) return <span className='text-muted-foreground text-xs'>—</span>
          return (
            <div className='flex flex-col text-xs'>
              <span className='max-w-[14rem] truncate' title={cred.email || ''}>
                {cred.email || '—'}
              </span>
              <span className='text-muted-foreground'>
                {cred.has_access ? 'access' : 'no-access'}
                {cred.has_refresh ? ' · refresh' : ''}
                {cred.schedulable === false ? ' · 停调' : ''}
              </span>
            </div>
          )
        },
        enableSorting: false,
      },
      {
        id: 'slot_state',
        header: ({ column }) => <DataTableColumnHeader column={column} title='状态' />,
        accessorFn: (row) => row.slot_state || '',
        cell: ({ row }) => {
          const view = slotStateView(row.original.slot_state)
          const pending = pendingByUser.get(row.original.user_id)
          return (
            <div className='flex flex-wrap items-center gap-1 text-xs'>
              <span className={cn(slotStateClass(view.tone))}>{view.label}</span>
              {pending ? <Badge variant='outline'>待迁移：{migrationReasonLabel(pending)}</Badge> : null}
              {row.original.invariant_ok === false ? <Badge variant='destructive'>绑定漂移</Badge> : null}
            </div>
          )
        },
        // States are prefix families (quota_5h_cli, quota_7d_safety, …), so the
        // facet matches the family instead of an exact string.
        filterFn: (row, id, value: string[]) => {
          const state = String(row.getValue(id) || '')
          return value.some((want) => {
            if (want === 'quota') return /^quota_|account_quota_exhausted/i.test(state)
            if (want === 'ready') return state === 'ready'
            return state === want || state.startsWith(`transient:`) === false && state === want
          })
        },
      },
      {
        id: 'migrations',
        header: '迁移',
        cell: ({ row }) => (
          <div className='flex items-center gap-1 text-xs'>
            <span title={`最近：${migrationReasonLabel(row.original.last_reason)}`}>
              {row.original.migrations ?? 0} 次
            </span>
            {reasonCrossesEgress(row.original.last_reason) ? <Badge variant='outline'>换过 IP</Badge> : null}
          </div>
        ),
        enableSorting: false,
      },
      {
        id: 'actions',
        header: () => <span className='sr-only'>操作</span>,
        cell: ({ row }) => (
          <div className='flex justify-end gap-1'>
            <Button size='sm' variant='ghost' disabled={busy} onClick={() => handlers.onDetail(row.original.user_id)}>
              历史
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={busy}
              title='在同一个 IP 内换一个槽'
              onClick={() => handlers.onMigrate(row.original.user_id)}
            >
              同 IP 换槽
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={busy}
              title='改绑到另一个 IP（会记录审计）'
              onClick={() => handlers.onRebind(row.original.user_id)}
            >
              换 IP
            </Button>
            <Button
              size='sm'
              variant='ghost'
              disabled={busy || !row.original.slot_id}
              title='槽停止服务，释放其上的用户，保留 IP 归属'
              onClick={() => row.original.slot_id && handlers.onRelease(row.original.slot_id)}
            >
              释放
            </Button>
            <Button
              size='sm'
              variant='ghost'
              disabled={busy || !row.original.slot_id}
              title='把槽打入冷却，迁移会跳过它'
              onClick={() => row.original.slot_id && handlers.onCool(row.original.slot_id)}
            >
              冷却
            </Button>
          </div>
        ),
        enableSorting: false,
        enableHiding: false,
      },
    ],
    [handlers, sessionsByEgress, pendingByUser, busy],
  )
}
