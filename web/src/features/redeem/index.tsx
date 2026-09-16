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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { redeemQueryOptions, type RedeemCode } from './queries'

const TYPE_LABELS: Record<string, string> = {
  balance: '余额',
  subscription_days: '订阅天数',
  concurrency: '并发',
}

const STATUS_LABELS: Record<string, string> = {
  unused: '未使用',
  partial: '部分使用',
  used: '已用完',
}

type FormState = {
  count: string
  value: string
  type: string
  maxUses: string
  batch: string
  notes: string
  expiresAt: string
}

const EMPTY: FormState = {
  count: '10',
  value: '10',
  type: 'balance',
  maxUses: '1',
  batch: '',
  notes: '',
  expiresAt: '',
}

/**
 * 兑换码 — sub2api's RedeemView shape on vm2api's billing core.
 *
 * A batch is the unit of creation; a code carries its own use limit, so
 * "已用 3/10" is legible without opening anything.
 */
export function RedeemPage() {
  const qc = useQueryClient()
  const query = useQuery(redeemQueryOptions())
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [useCode, setUseCode] = useState<RedeemCode | null>(null)
  const [useUserId, setUseUserId] = useState('')
  const [deleting, setDeleting] = useState<RedeemCode | null>(null)
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = useState({})

  const rows = query.data?.codes || []
  const refresh = () => qc.invalidateQueries({ queryKey: ['panel', 'redeem'] })

  const create = useMutation({
    mutationFn: () =>
      api<{ created?: number; codes?: string[] }>('/api/panel/redeem', {
        method: 'POST',
        body: JSON.stringify({
          count: Number(form.count) || 1,
          value: Number(form.value) || 0,
          type: form.type,
          max_uses: Number(form.maxUses) || 1,
          batch: form.batch || null,
          notes: form.notes || null,
          expires_at: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
        }),
      }),
    onSuccess: async (data) => {
      toast.success(`已生成 ${data.created ?? 0} 个兑换码`)
      setCreating(false)
      setForm(EMPTY)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const redeem = useMutation({
    mutationFn: () =>
      api<{ ok?: boolean; reason?: string }>(
        `/api/panel/redeem/${encodeURIComponent(useCode?.code || '')}/use`,
        { method: 'POST', body: JSON.stringify({ user_id: useUserId }) },
      ),
    onSuccess: async (res) => {
      if (res?.ok === false) {
        const reason = String(res.reason || '')
        const label: Record<string, string> = {
          already_redeemed: '该用户已经用过这个码',
          code_exhausted: '这个码已经用完',
          code_expired: '这个码已过期',
          code_not_found: '找不到这个码',
        }
        toast.error(label[reason] || reason)
        return
      }
      toast.success('已核销')
      setUseCode(null)
      setUseUserId('')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/panel/redeem/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success('已删除')
      setDeleting(null)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const columns = useMemo<ColumnDef<RedeemCode>[]>(
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
        accessorKey: 'code',
        header: ({ column }) => <DataTableColumnHeader column={column} title='兑换码' />,
        cell: ({ row }) => <span className='font-mono text-xs'>{row.original.code}</span>,
      },
      {
        accessorKey: 'type',
        header: '类型',
        cell: ({ row }) => (
          <div className='flex items-center gap-2 text-xs'>
            <Badge variant='outline'>{TYPE_LABELS[row.original.type] || row.original.type}</Badge>
            <span>
              {row.original.type === 'balance' ? `$${row.original.value}` : `${row.original.value} 天`}
            </span>
          </div>
        ),
        enableSorting: false,
      },
      {
        id: 'usage',
        header: '使用',
        cell: ({ row }) => {
          const used = row.original.used_count ?? 0
          const max = row.original.max_uses ?? 1
          return (
            <span className='text-xs'>
              已用 <span className={used >= max ? 'text-muted-foreground' : 'text-ok-3'}>{used}</span>/{max}
            </span>
          )
        },
        enableSorting: false,
      },
      {
        accessorKey: 'status',
        header: ({ column }) => <DataTableColumnHeader column={column} title='状态' />,
        cell: ({ row }) => (
          <Badge variant={row.original.status === 'used' ? 'secondary' : 'outline'}>
            {STATUS_LABELS[row.original.status] || row.original.status}
          </Badge>
        ),
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
      },
      {
        accessorKey: 'batch',
        header: '批次',
        cell: ({ row }) => <span className='font-mono text-xs'>{row.original.batch || '—'}</span>,
        enableSorting: false,
      },
      {
        accessorKey: 'notes',
        header: '备注',
        cell: ({ row }) => (
          <span className='text-muted-foreground block max-w-[12rem] truncate text-xs'>
            {row.original.notes || '—'}
          </span>
        ),
        enableSorting: false,
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
        id: 'actions',
        header: () => <span className='sr-only'>操作</span>,
        cell: ({ row }) => (
          <div className='flex justify-end gap-1'>
            <Button size='sm' variant='outline' onClick={() => setUseCode(row.original)}>
              核销
            </Button>
            <Button size='sm' variant='ghost' className='text-destructive' onClick={() => setDeleting(row.original)}>
              删除
            </Button>
          </div>
        ),
        enableSorting: false,
        enableHiding: false,
      },
    ],
    [],
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

  const live = rows.filter((r) => r.status !== 'used').length
  const totalValue = rows.filter((r) => r.type === 'balance').reduce((sum, r) => sum + (r.value || 0), 0)

  return (
    <PageHeader title='兑换码' extra={<Button onClick={() => setCreating(true)}>生成兑换码</Button>}>
      <div className='mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
        <StatCard label='兑换码' value={String(rows.length)} hint="全部批次" />
        <StatCard label='仍可用' value={String(live)} hint="未用完的码" />
        <StatCard
          label='已核销'
          value={String(rows.reduce((sum, r) => sum + (r.used_count || 0), 0))}
          hint="累计使用次数"
        />
        <StatCard label='面值合计' value={`$${totalValue.toFixed(2)}`} hint="仅余额类" />
      </div>

      <QueryGate
        loading={query.isLoading}
        error={query.error || (query.data?.error ? new Error(query.data.error) : null)}
        skeleton={<TableSkeleton rows={8} columns={7} />}
      >
        <div className='space-y-3'>
          <DataTableToolbar
            table={table}
            searchPlaceholder='搜索兑换码 / 批次 / 备注'
            filters={[
              {
                columnId: 'status',
                title: '状态',
                options: [
                  { label: '未使用', value: 'unused' },
                  { label: '部分使用', value: 'partial' },
                  { label: '已用完', value: 'used' },
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
                      还没有兑换码。生成一批用于充值或送订阅天数。
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <DataTablePagination table={table} />
        </div>
      </QueryGate>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className='max-w-lg'>
          <DialogHeader>
            <DialogTitle>生成兑换码</DialogTitle>
            <DialogDescription>
              一个码可被多人使用（设置「每人一次」上限），但同一个人不能重复用同一个码。
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-3 py-2'>
            <div className='grid gap-3 sm:grid-cols-3'>
              <div className='grid gap-1.5'>
                <Label htmlFor='rd-count'>数量</Label>
                <Input
                  id='rd-count'
                  value={form.count}
                  onChange={(e) => setForm({ ...form, count: e.target.value })}
                />
              </div>
              <div className='grid gap-1.5'>
                <Label htmlFor='rd-value'>面值</Label>
                <Input
                  id='rd-value'
                  value={form.value}
                  onChange={(e) => setForm({ ...form, value: e.target.value })}
                />
              </div>
              <div className='grid gap-1.5'>
                <Label>类型</Label>
                <Select value={form.type} onValueChange={(type) => setForm({ ...form, type })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='balance'>余额</SelectItem>
                    <SelectItem value='subscription_days'>订阅天数</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className='grid gap-3 sm:grid-cols-2'>
              <div className='grid gap-1.5'>
                <Label htmlFor='rd-uses'>每码可用次数</Label>
                <Input
                  id='rd-uses'
                  value={form.maxUses}
                  onChange={(e) => setForm({ ...form, maxUses: e.target.value })}
                />
              </div>
              <div className='grid gap-1.5'>
                <Label htmlFor='rd-batch'>批次名</Label>
                <Input
                  id='rd-batch'
                  value={form.batch}
                  placeholder='可留空'
                  onChange={(e) => setForm({ ...form, batch: e.target.value })}
                />
              </div>
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='rd-exp'>过期时间</Label>
              <Input
                id='rd-exp'
                type='datetime-local'
                value={form.expiresAt}
                onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
              />
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='rd-notes'>备注</Label>
              <Input
                id='rd-notes'
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => setCreating(false)}>
              取消
            </Button>
            <Button loading={create.isPending} onClick={() => create.mutate()}>
              生成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!useCode} onOpenChange={(open) => !open && setUseCode(null)}>
        <DialogContent className='max-w-md'>
          <DialogHeader>
            <DialogTitle>核销 {useCode?.code}</DialogTitle>
            <DialogDescription>填 user_id 代为核销，走同一套余额流水。</DialogDescription>
          </DialogHeader>
          <div className='grid gap-1.5 py-2'>
            <Label htmlFor='rd-user'>user_id</Label>
            <Input id='rd-user' value={useUserId} onChange={(e) => setUseUserId(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => setUseCode(null)}>
              取消
            </Button>
            <Button loading={redeem.isPending} disabled={!useUserId} onClick={() => redeem.mutate()}>
              核销
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={() => setDeleting(null)}
        title='删除兑换码'
        desc={`删除 ${deleting?.code || ''}？已核销的记录会保留在流水里。`}
        confirmText='删除'
        cancelBtnText='取消'
        destructive
        isLoading={remove.isPending}
        handleConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </PageHeader>
  )
}
