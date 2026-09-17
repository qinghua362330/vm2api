import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { TableSkeleton } from '@/components/page-skeletons'
import { StatCard } from '@/components/stat-card'
import { DataTableColumnHeader, DataTablePagination, DataTableToolbar } from '@/components/data-table'
import { subscriptionsQueryOptions, type PanelSubscription } from './queries'

const STATUS_LABELS: Record<string, string> = {
  active: '生效中',
  expired: '已过期',
  revoked: '已撤销',
}

type FormState = { userId: string; plan: string; days: string; dailyQuota: string; notes: string }
const EMPTY: FormState = { userId: '', plan: 'standard', days: '30', dailyQuota: '0', notes: '' }

/**
 * 订阅 — sub2api's SubscriptionsView shape on vm2api's base.
 *
 * The allowance column reads the live rolling window, so "今天还剩多少 / 何时回满"
 * is answered without opening anything. `daily_quota = 0` renders as 不限量 rather
 * than 0, because that is what the service means by it.
 */
export function SubscriptionsPage() {
  const qc = useQueryClient()
  const query = useQuery(subscriptionsQueryOptions())
  const [granting, setGranting] = useState(false)
  const [editing, setEditing] = useState<PanelSubscription | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [revoking, setRevoking] = useState<PanelSubscription | null>(null)
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = useState({})

  const rows = query.data?.subscriptions || []
  const refresh = () => qc.invalidateQueries({ queryKey: ['panel', 'subscriptions'] })

  const save = useMutation({
    mutationFn: () =>
      api<{ ok?: boolean; reason?: string; extended?: boolean }>('/api/panel/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          user_id: form.userId,
          plan: form.plan,
          days: Number(form.days) || 0,
          daily_quota: Number(form.dailyQuota) || 0,
          notes: form.notes,
        }),
      }),
    onSuccess: async (res) => {
      if (res?.ok === false) {
        toast.error(String(res.reason || '授予失败'))
        return
      }
      toast.success(res?.extended ? '已延长' : '已授予')
      setGranting(false)
      setEditing(null)
      setForm(EMPTY)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api(`/api/panel/subscriptions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: async () => {
      toast.success('已保存')
      setEditing(null)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const revoke = useMutation({
    mutationFn: (id: number) => api(`/api/panel/subscriptions/${id}/revoke`, { method: 'POST' }),
    onSuccess: async () => {
      toast.success('已撤销')
      setRevoking(null)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const columns = useMemo<ColumnDef<PanelSubscription>[]>(
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
        accessorKey: 'plan',
        header: ({ column }) => <DataTableColumnHeader column={column} title='套餐' />,
        cell: ({ row }) => <Badge variant='outline'>{row.original.plan}</Badge>,
      },
      {
        id: 'allowance',
        header: '今日额度',
        cell: ({ row }) => {
          const w = row.original.window
          if (!w?.open) {
            return <span className='text-muted-foreground text-xs'>—</span>
          }
          if (w.unlimited) return <span className='text-xs'>不限量</span>
          return (
            <div className='flex flex-col text-xs'>
              <span>
                剩 <span className={w.remaining && w.remaining > 0 ? 'text-ok-3' : 'text-destructive'}>{w.remaining}</span>
                <span className='text-muted-foreground'> / {w.quota}</span>
              </span>
              <span className='text-muted-foreground'>
                {w.resets_at ? `${new Date(w.resets_at).toLocaleTimeString()} 回满` : '—'}
              </span>
            </div>
          )
        },
        enableSorting: false,
      },
      {
        accessorKey: 'days_left',
        header: ({ column }) => <DataTableColumnHeader column={column} title='剩余天数' />,
        cell: ({ row }) => (
          <span className='text-xs'>
            {row.original.days_left == null ? '—' : `${row.original.days_left} 天`}
          </span>
        ),
      },
      {
        accessorKey: 'expires_at',
        header: ({ column }) => <DataTableColumnHeader column={column} title='到期时间' />,
        cell: ({ row }) => (
          <span className='text-muted-foreground text-xs'>
            {row.original.expires_at ? new Date(row.original.expires_at).toLocaleDateString() : '—'}
          </span>
        ),
      },
      {
        accessorKey: 'status',
        header: ({ column }) => <DataTableColumnHeader column={column} title='状态' />,
        cell: ({ row }) => (
          <Badge variant={row.original.status === 'active' ? 'secondary' : 'destructive'}>
            {STATUS_LABELS[row.original.status] || row.original.status}
          </Badge>
        ),
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
      },
      {
        accessorKey: 'notes',
        header: '备注',
        cell: ({ row }) => (
          <span className='text-muted-foreground block max-w-[14rem] truncate text-xs'>
            {row.original.notes || '—'}
          </span>
        ),
        enableSorting: false,
      },
      {
        id: 'actions',
        header: () => <span className='sr-only'>操作</span>,
        cell: ({ row }) => (
          <div className='flex justify-end gap-1'>
            <Button
              size='sm'
              variant='ghost'
              onClick={() => {
                setEditing(row.original)
                setForm({
                  userId: row.original.user_id,
                  plan: row.original.plan,
                  days: '30',
                  dailyQuota: String(row.original.daily_quota ?? 0),
                  notes: row.original.notes || '',
                })
              }}
            >
              编辑
            </Button>
            <Button
              size='sm'
              variant='outline'
              title='再延长 30 天'
              disabled={patch.isPending}
              onClick={() => patch.mutate({ id: row.original.id, body: {} })}
            >
              +30 天
            </Button>
            <Button
              size='sm'
              variant='ghost'
              className='text-destructive'
              onClick={() => setRevoking(row.original)}
            >
              撤销
            </Button>
          </div>
        ),
        enableSorting: false,
        enableHiding: false,
      },
    ],
    [patch],
  )

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, columnFilters, columnVisibility, rowSelection },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 20 } },
  })

  const active = rows.filter((r) => r.status === 'active')
  const expiringSoon = active.filter((r) => (r.days_left ?? 0) <= 3).length
  const unlimited = active.filter((r) => r.window?.unlimited).length

  return (
    <PageHeader title='订阅' extra={<Button onClick={() => { setGranting(true); setForm(EMPTY) }}>授予订阅</Button>}>
      <div className='mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
        <StatCard label='订阅数' value={String(rows.length)} hint={`${active.length} 个生效中`} />
        <StatCard
          label='即将到期'
          value={String(expiringSoon)}
          hint="3 天内到期"
          tone={expiringSoon ? 'warn' : 'neutral'}
        />
        <StatCard
          label='已过期/撤销'
          value={String(rows.length - active.length)}
          hint="不再消耗额度"
        />
        <StatCard label='不限量' value={String(unlimited)} hint="日额度为 0" />
      </div>

      <QueryGate
        loading={query.isLoading}
        error={query.error || (query.data?.error ? new Error(query.data.error) : null)}
        skeleton={<TableSkeleton rows={8} columns={7} />}
      >
        <div className='space-y-3'>
          <DataTableToolbar
            table={table}
            searchPlaceholder='搜索 user_id / 套餐 / 备注'
            filters={[
              {
                columnId: 'status',
                title: '状态',
                options: [
                  { label: '生效中', value: 'active' },
                  { label: '已过期', value: 'expired' },
                  { label: '已撤销', value: 'revoked' },
                ],
              },
            ]}
          />
          <div className='overflow-hidden rounded-md border'>
            <Table density='compact'>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id}>
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.length ? (
                  table.getRowModel().rows.map((row) => (
                    <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={columns.length} className='h-24 text-center'>
                      还没有订阅。授予后用户就有了按日额度。
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <DataTablePagination table={table} />
        </div>
      </QueryGate>

      <Dialog
        open={granting || !!editing}
        onOpenChange={(open) => {
          if (!open) {
            setGranting(false)
            setEditing(null)
            setForm(EMPTY)
          }
        }}
      >
        <DialogContent className='max-w-lg'>
          <DialogHeader>
            <DialogTitle>{editing ? `编辑 ${editing.user_id} 的订阅` : '授予订阅'}</DialogTitle>
            <DialogDescription>
              对已有生效订阅的用户，天数是**延长**而不是叠加 —— 不会出现两条订阅把额度翻倍。
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-3 py-2'>
            <div className='grid gap-1.5'>
              <Label htmlFor='sub-user'>user_id</Label>
              <Input
                id='sub-user'
                value={form.userId}
                disabled={!!editing}
                onChange={(e) => setForm({ ...form, userId: e.target.value })}
              />
            </div>
            <div className='grid gap-3 sm:grid-cols-3'>
              <div className='grid gap-1.5'>
                <Label htmlFor='sub-plan'>套餐</Label>
                <Input id='sub-plan' value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })} />
              </div>
              <div className='grid gap-1.5'>
                <Label htmlFor='sub-days'>{editing ? '再延长天数' : '天数'}</Label>
                <Input id='sub-days' value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} />
              </div>
              <div className='grid gap-1.5'>
                <Label htmlFor='sub-quota'>每日额度</Label>
                <Input
                  id='sub-quota'
                  value={form.dailyQuota}
                  onChange={(e) => setForm({ ...form, dailyQuota: e.target.value })}
                />
              </div>
            </div>
            <p className='text-muted-foreground text-xs'>每日额度填 0 表示不限量。窗口是滚动 24 小时，从当天首次使用起算。</p>
            <div className='grid gap-1.5'>
              <Label htmlFor='sub-notes'>备注</Label>
              <Input
                id='sub-notes'
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => {
                setGranting(false)
                setEditing(null)
              }}
            >
              取消
            </Button>
            <Button
              loading={save.isPending || patch.isPending}
              disabled={!form.userId}
              onClick={() => {
                if (editing) {
                  patch.mutate({
                    id: editing.id,
                    body: {
                      plan: form.plan,
                      daily_quota: Number(form.dailyQuota) || 0,
                      notes: form.notes,
                    },
                  })
                  // A day change is a grant (it extends), not a field edit.
                  if (Number(form.days) > 0) {
                    save.mutate()
                  }
                  return
                }
                save.mutate()
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!revoking}
        onOpenChange={() => setRevoking(null)}
        title='撤销订阅'
        desc={`撤销 ${revoking?.user_id || ''} 的订阅？撤销后立刻停止消耗额度，剩余天数作废。`}
        confirmText='撤销'
        cancelBtnText='取消'
        destructive
        isLoading={revoke.isPending}
        handleConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </PageHeader>
  )
}
