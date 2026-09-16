import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  type ColumnFiltersState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
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
import { channelsQueryOptions, type PanelChannel } from './queries'

type FormState = {
  name: string
  description: string
  status: string
  rate_multiplier: string
  restrict_models: boolean
  buckets: string
  users: string
}

const EMPTY: FormState = {
  name: '',
  description: '',
  status: 'active',
  rate_multiplier: '1',
  restrict_models: false,
  buckets: '',
  users: '',
}

const splitList = (raw: string) =>
  String(raw || '')
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean)

/**
 * 渠道 — sub2api's channel shape (a channel groups buckets, carries channel-level
 * model pricing, and can restrict models) with this fork's distribution rule:
 * the channel bounds which buckets a request may use and never selects an
 * account. Slot/session resolution stays where it belongs.
 */
export function ChannelsPage() {
  const qc = useQueryClient()
  const query = useQuery(channelsQueryOptions())
  const [editing, setEditing] = useState<PanelChannel | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [deleting, setDeleting] = useState<PanelChannel | null>(null)
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = useState({})

  const rows = query.data?.channels || []
  const refresh = () => qc.invalidateQueries({ queryKey: ['panel', 'channels'] })

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name,
        description: form.description,
        status: form.status,
        rate_multiplier: Number(form.rate_multiplier) || 1,
        restrict_models: form.restrict_models,
        buckets: splitList(form.buckets),
        users: splitList(form.users),
      }
      return editing
        ? api(`/api/panel/channels/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : api('/api/panel/channels', { method: 'POST', body: JSON.stringify(body) })
    },
    onSuccess: async () => {
      toast.success(editing ? '已保存' : '已创建')
      setEditing(null)
      setCreating(false)
      setForm(EMPTY)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/panel/channels/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success('已删除，桶已释放')
      setDeleting(null)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const columns = useMemo<ColumnDef<PanelChannel>[]>(
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
        accessorKey: 'name',
        header: ({ column }) => <DataTableColumnHeader column={column} title='渠道' />,
        cell: ({ row }) => (
          <div className='flex flex-col'>
            <span className='font-medium'>{row.original.name}</span>
            <span className='text-muted-foreground max-w-[16rem] truncate text-xs'>
              {row.original.description || '—'}
            </span>
          </div>
        ),
      },
      {
        accessorKey: 'id',
        header: ({ column }) => <DataTableColumnHeader column={column} title='ID' />,
        cell: ({ row }) => <span className='font-mono text-xs'>{row.original.id}</span>,
      },
      {
        id: 'buckets',
        header: '桶（出口 IP）',
        cell: ({ row }) => (
          <div className='flex flex-wrap items-center gap-1 text-xs'>
            <Badge variant='outline'>{row.original.bucket_count} 个</Badge>
            <span className='text-muted-foreground max-w-[18rem] truncate' title={row.original.buckets.join('、')}>
              {row.original.buckets.join('、') || '—'}
            </span>
          </div>
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'user_count',
        header: ({ column }) => <DataTableColumnHeader column={column} title='用户' />,
        cell: ({ row }) => <span className='text-xs'>{row.original.user_count}</span>,
      },
      {
        id: 'pricing',
        header: '定价',
        cell: ({ row }) => {
          const pricing = row.original.pricing || []
          if (!pricing.length) return <span className='text-muted-foreground text-xs'>未配置</span>
          return (
            <div className='flex flex-col text-xs'>
              <span>{pricing.length} 条</span>
              <span className='text-muted-foreground max-w-[14rem] truncate'>
                {pricing.flatMap((p) => p.models).slice(0, 3).join('、')}
              </span>
            </div>
          )
        },
        enableSorting: false,
      },
      {
        accessorKey: 'rate_multiplier',
        header: ({ column }) => <DataTableColumnHeader column={column} title='倍率' />,
        cell: ({ row }) => <span className='text-xs'>×{row.original.rate_multiplier}</span>,
      },
      {
        accessorKey: 'status',
        header: ({ column }) => <DataTableColumnHeader column={column} title='状态' />,
        cell: ({ row }) => (
          <div className='flex items-center gap-1'>
            <Badge variant={row.original.status === 'active' ? 'secondary' : 'destructive'}>
              {row.original.status === 'active' ? '启用' : '停用'}
            </Badge>
            {row.original.restrict_models ? <Badge variant='outline'>限模型</Badge> : null}
          </div>
        ),
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
      },
      {
        id: 'actions',
        header: () => <span className='sr-only'>操作</span>,
        cell: ({ row }) => (
          <div className='flex justify-end gap-1'>
            <Button size='sm' variant='ghost' onClick={() => openEdit(row.original)}>
              编辑
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

  function openEdit(channel: PanelChannel) {
    setEditing(channel)
    setForm({
      name: channel.name,
      description: channel.description || '',
      status: channel.status,
      rate_multiplier: String(channel.rate_multiplier ?? 1),
      restrict_models: channel.restrict_models === true,
      buckets: channel.buckets.join('\n'),
      users: channel.users.join('\n'),
    })
  }

  function openCreate() {
    setCreating(true)
    setEditing(null)
    setForm(EMPTY)
  }

  const claimed = rows.reduce((sum, row) => sum + row.bucket_count, 0)

  return (
    <PageHeader title='渠道' extra={<Button onClick={openCreate}>新建渠道</Button>}>
      <div className='mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
        <StatCard label='渠道数' value={String(rows.length)} hint='分发与定价单位' />
        <StatCard label='已分配桶' value={String(claimed)} hint='一个桶只能属于一个渠道' />
        <StatCard
          label='启用中'
          value={String(rows.filter((r) => r.status === 'active').length)}
          hint={`${rows.filter((r) => r.status !== 'active').length} 个停用`}
        />
        <StatCard
          label='限模型'
          value={String(rows.filter((r) => r.restrict_models).length)}
          hint='仅放行已定价的模型'
        />
      </div>

      <QueryGate
        loading={query.isLoading}
        error={query.error || (query.data?.error ? new Error(query.data.error) : null)}
        skeleton={<TableSkeleton rows={6} columns={8} />}
      >
        <div className='space-y-3'>
          <DataTableToolbar
            table={table}
            searchPlaceholder='搜索渠道名'
            filters={[
              {
                columnId: 'status',
                title: '状态',
                options: [
                  { label: '启用', value: 'active' },
                  { label: '停用', value: 'disabled' },
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
                      还没有渠道。建一个渠道并把桶分配进去，用户才有分发范围。
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
        open={creating || !!editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false)
            setEditing(null)
            setForm(EMPTY)
          }
        }}
      >
        <DialogContent className='max-w-2xl'>
          <DialogHeader>
            <DialogTitle>{editing ? `编辑 ${editing.name}` : '新建渠道'}</DialogTitle>
          </DialogHeader>
          <div className='grid gap-3 py-2'>
            <div className='grid gap-3 sm:grid-cols-2'>
              <div className='grid gap-1.5'>
                <Label htmlFor='ch-name'>名称</Label>
                <Input id='ch-name' value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className='grid gap-1.5'>
                <Label htmlFor='ch-rate'>倍率</Label>
                <Input
                  id='ch-rate'
                  value={form.rate_multiplier}
                  onChange={(e) => setForm({ ...form, rate_multiplier: e.target.value })}
                />
              </div>
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='ch-desc'>描述</Label>
              <Input
                id='ch-desc'
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='ch-buckets'>桶（出口 IP，每行一个）</Label>
              <textarea
                id='ch-buckets'
                rows={4}
                value={form.buckets}
                onChange={(e) => setForm({ ...form, buckets: e.target.value })}
                className='border-input bg-background focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 font-mono text-xs focus-visible:ring-[3px] focus-visible:outline-none'
                placeholder={'px-a3f1\npx-b7c2\ndirect:203.0.113.9'}
              />
              <p className='text-muted-foreground text-xs'>
                一个桶只能属于一个渠道。渠道只界定「可以用哪些桶」，不参与选槽 —— 选槽仍由 session 绑定 &gt; 桶偏好 &gt; 故障转移决定。
              </p>
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='ch-users'>授权用户（每行一个 user_id）</Label>
              <textarea
                id='ch-users'
                rows={3}
                value={form.users}
                onChange={(e) => setForm({ ...form, users: e.target.value })}
                className='border-input bg-background focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 font-mono text-xs focus-visible:ring-[3px] focus-visible:outline-none'
              />
            </div>
            <div className='flex items-center gap-2'>
              <Checkbox
                id='ch-restrict'
                checked={form.restrict_models}
                onCheckedChange={(value) => setForm({ ...form, restrict_models: !!value })}
              />
              <Label htmlFor='ch-restrict' className='text-sm font-normal'>
                限制模型：只放行已定价的模型
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => {
                setCreating(false)
                setEditing(null)
              }}
            >
              取消
            </Button>
            <Button loading={save.isPending} disabled={!editing && !form.name} onClick={() => save.mutate()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={() => setDeleting(null)}
        title='删除渠道'
        desc={`删除 ${deleting?.name || ''}？其占用的桶会被释放，可分配给其他渠道。`}
        confirmText='删除'
        cancelBtnText='取消'
        destructive
        isLoading={remove.isPending}
        handleConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </PageHeader>
  )
}
