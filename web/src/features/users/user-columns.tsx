import { type ColumnDef } from '@tanstack/react-table'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { DataTableColumnHeader } from '@/components/data-table'
import type { PanelUserRow } from '@/types/panel-users'
import { ROLE_LABELS } from '@/types/panel-users'
import { migrationReasonLabel } from '@/features/egress/slot-state'

function relative(iso?: string | null): string {
  if (!iso) return '—'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

function egressText(row: PanelUserRow): string {
  const buckets = row.egress?.buckets || []
  if (!buckets.length) return '—'
  const primary = buckets[0].startsWith('direct:') ? `本机共享 ${buckets[0].slice(7)}` : buckets[0]
  return buckets.length > 1 ? `${primary} +${buckets.length - 1}` : primary
}

export const userColumns: ColumnDef<PanelUserRow>[] = [
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
    accessorKey: 'username',
    header: ({ column }) => <DataTableColumnHeader column={column} title='用户' />,
    cell: ({ row }) => (
      <div className='flex items-center gap-2'>
        <div className='bg-primary/10 text-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-full'>
          <span className='text-sm font-medium'>
            {String(row.original.username || row.original.email || '?').charAt(0).toUpperCase()}
          </span>
        </div>
        <div className='flex min-w-0 flex-col'>
          <span className='truncate font-medium'>{row.original.username}</span>
          <span className='text-muted-foreground truncate text-xs'>{row.original.email || '—'}</span>
        </div>
      </div>
    ),
  },
  {
    accessorKey: 'id',
    header: ({ column }) => <DataTableColumnHeader column={column} title='ID' />,
    cell: ({ row }) => <span className='font-mono text-xs'>{row.original.id}</span>,
  },
  {
    accessorKey: 'role',
    header: ({ column }) => <DataTableColumnHeader column={column} title='角色' />,
    cell: ({ row }) => (
      <Badge variant={row.original.role === 'user' ? 'outline' : 'secondary'}>
        {ROLE_LABELS[row.original.role] || row.original.role}
      </Badge>
    ),
    filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
  },
  {
    id: 'egress',
    header: '出口 IP / 槽',
    cell: ({ row }) => {
      const slot = row.original.egress?.slot
      const buckets = row.original.egress?.buckets || []
      return (
        <div className='flex flex-col gap-0.5 text-xs'>
          <span className='font-mono'>{egressText(row.original)}</span>
          <span className='text-muted-foreground'>
            {slot ? (
              <>
                {slot.slot_id} · 迁移 {slot.migrations}
                {slot.last_reason ? ` · ${migrationReasonLabel(slot.last_reason)}` : ''}
              </>
            ) : (
              '未落槽'
            )}
          </span>
          {buckets.length > 1 ? (
            <Badge variant='outline' className='w-fit'>
              按会话分流
            </Badge>
          ) : null}
        </div>
      )
    },
    enableSorting: false,
  },
  {
    accessorKey: 'concurrency',
    header: ({ column }) => <DataTableColumnHeader column={column} title='并发' />,
    cell: ({ row }) => <span className='text-xs'>{row.original.concurrency ?? 0}</span>,
  },
  {
    accessorKey: 'vm_create_quota',
    header: '建槽额度',
    cell: ({ row }) => <span className='text-xs'>{row.original.vm_create_quota ?? 0}</span>,
    enableSorting: false,
  },
  {
    accessorKey: 'balance',
    header: ({ column }) => <DataTableColumnHeader column={column} title='余额' />,
    cell: ({ row }) => <span className='text-xs'>{(row.original.balance ?? 0).toFixed(2)}</span>,
  },
  {
    accessorKey: 'status',
    header: ({ column }) => <DataTableColumnHeader column={column} title='状态' />,
    cell: ({ row }) => (
      <Badge variant={row.original.status === 'active' ? 'secondary' : 'destructive'}>
        {row.original.status === 'active' ? '正常' : '已禁用'}
      </Badge>
    ),
    filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
  },
  {
    accessorKey: 'last_active_at',
    header: ({ column }) => <DataTableColumnHeader column={column} title='最近活动' />,
    cell: ({ row }) => (
      <span className='text-muted-foreground text-xs' title={row.original.last_active_at || ''}>
        {relative(row.original.last_active_at)}
      </span>
    ),
  },
  {
    accessorKey: 'created_at',
    header: ({ column }) => <DataTableColumnHeader column={column} title='创建时间' />,
    cell: ({ row }) => (
      <span className='text-muted-foreground text-xs'>
        {row.original.created_at ? new Date(row.original.created_at).toLocaleDateString() : '—'}
      </span>
    ),
  },
  {
    accessorKey: 'notes',
    header: '备注',
    cell: ({ row }) => (
      <span className='text-muted-foreground block max-w-[12rem] truncate text-xs' title={row.original.notes || ''}>
        {row.original.notes || '—'}
      </span>
    ),
    enableSorting: false,
  },
]
