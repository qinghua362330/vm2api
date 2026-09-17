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
import { announcementsQueryOptions, type Announcement } from './queries'

const LEVEL_LABELS: Record<string, string> = { info: '通知', warn: '提醒', critical: '重要' }
const LEVEL_VARIANT: Record<string, 'outline' | 'secondary' | 'destructive'> = {
  info: 'outline',
  warn: 'secondary',
  critical: 'destructive',
}
const STATUS_LABELS: Record<string, string> = { draft: '草稿', published: '已发布', archived: '已归档' }

type FormState = {
  title: string
  body: string
  level: string
  status: string
  audience: string
  pinned: boolean
}

const EMPTY: FormState = { title: '', body: '', level: 'info', status: 'published', audience: 'all', pinned: false }

/**
 * 公告 — sub2api's AnnouncementsView shape.
 *
 * Audience and schedule are the whole point: `all` / `role:admin` / `user:<id>`
 * plus a start/end window decide who actually sees it, and the same rule runs
 * server-side (announcements-repo isVisibleTo), so the preview here cannot drift
 * from what a user gets.
 */
export function AnnouncementsPage() {
  const qc = useQueryClient()
  const [showAll, setShowAll] = useState(true)
  const query = useQuery(announcementsQueryOptions(showAll))
  const [editing, setEditing] = useState<Announcement | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [deleting, setDeleting] = useState<Announcement | null>(null)
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = useState({})

  const rows = query.data?.announcements || []
  const refresh = () => qc.invalidateQueries({ queryKey: ['panel', 'announcements'] })

  const save = useMutation({
    mutationFn: () => {
      const body = {
        title: form.title,
        body: form.body,
        level: form.level,
        status: form.status,
        audience: form.audience,
        pinned: form.pinned,
      }
      return editing
        ? api(`/api/panel/announcements/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : api('/api/panel/announcements', { method: 'POST', body: JSON.stringify(body) })
    },
    onSuccess: async () => {
      toast.success(editing ? '已保存' : '已发布')
      setEditing(null)
      setCreating(false)
      setForm(EMPTY)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/panel/announcements/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success('已删除')
      setDeleting(null)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const togglePin = useMutation({
    mutationFn: ({ id, pinned }: { id: number; pinned: boolean }) =>
      api(`/api/panel/announcements/${id}`, { method: 'PATCH', body: JSON.stringify({ pinned }) }),
    onSuccess: async () => {
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const columns = useMemo<ColumnDef<Announcement>[]>(
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
        accessorKey: 'title',
        header: ({ column }) => <DataTableColumnHeader column={column} title='标题' />,
        cell: ({ row }) => (
          <div className='flex items-center gap-2'>
            {row.original.pinned ? <Badge variant='secondary'>置顶</Badge> : null}
            <div className='flex min-w-0 flex-col'>
              <span className='truncate font-medium'>{row.original.title}</span>
              <span className='text-muted-foreground max-w-[26rem] truncate text-xs'>{row.original.body || '—'}</span>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'level',
        header: ({ column }) => <DataTableColumnHeader column={column} title='级别' />,
        cell: ({ row }) => (
          <Badge variant={LEVEL_VARIANT[row.original.level] || 'outline'}>
            {LEVEL_LABELS[row.original.level] || row.original.level}
          </Badge>
        ),
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
      },
      {
        accessorKey: 'audience',
        header: '受众',
        cell: ({ row }) => {
          const a = row.original.audience || 'all'
          const label = a === 'all' ? '所有人' : a.startsWith('role:') ? `角色 ${a.slice(5)}` : `用户 ${a.slice(5)}`
          return <span className='text-xs'>{label}</span>
        },
        enableSorting: false,
      },
      {
        accessorKey: 'status',
        header: ({ column }) => <DataTableColumnHeader column={column} title='状态' />,
        cell: ({ row }) => (
          <Badge variant={row.original.status === 'published' ? 'secondary' : 'outline'}>
            {STATUS_LABELS[row.original.status] || row.original.status}
          </Badge>
        ),
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
      },
      {
        accessorKey: 'created_at',
        header: ({ column }) => <DataTableColumnHeader column={column} title='创建时间' />,
        cell: ({ row }) => (
          <span className='text-muted-foreground text-xs'>
            {row.original.created_at ? new Date(row.original.created_at).toLocaleString() : '—'}
          </span>
        ),
      },
      {
        id: 'actions',
        header: () => <span className='sr-only'>操作</span>,
        cell: ({ row }) => (
          <div className='flex justify-end gap-1'>
            <Button
              size='sm'
              variant='ghost'
              disabled={togglePin.isPending}
              onClick={() => togglePin.mutate({ id: row.original.id, pinned: !row.original.pinned })}
            >
              {row.original.pinned ? '取消置顶' : '置顶'}
            </Button>
            <Button
              size='sm'
              variant='ghost'
              onClick={() => {
                setEditing(row.original)
                setForm({
                  title: row.original.title,
                  body: row.original.body,
                  level: row.original.level,
                  status: row.original.status,
                  audience: row.original.audience,
                  pinned: row.original.pinned,
                })
              }}
            >
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
    [togglePin],
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

  const published = rows.filter((r) => r.status === 'published').length

  return (
    <PageHeader
      title='公告'
      extra={
        <div className='flex gap-2'>
          <Button variant='outline' onClick={() => setShowAll((v) => !v)}>
            {showAll ? '看用户视角' : '看全部'}
          </Button>
          <Button onClick={() => { setCreating(true); setForm(EMPTY) }}>新建公告</Button>
        </div>
      }
    >
      <div className='mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
        <StatCard label={showAll ? '公告总数' : '当前可见'} value={String(rows.length)} hint={showAll ? '含草稿与归档' : '按受众与时间过滤后'} />
        <StatCard label='已发布' value={String(published)} hint="用户可见状态" />
        <StatCard label='置顶' value={String(rows.filter((r) => r.pinned).length)} hint="排在最前" />
        <StatCard
          label='重要'
          value={String(rows.filter((r) => r.level === 'critical').length)}
          hint="critical 级别"
          tone={rows.some((r) => r.level === 'critical') ? 'warn' : 'neutral'}
        />
      </div>

      <QueryGate
        loading={query.isLoading}
        error={query.error || (query.data?.error ? new Error(query.data.error) : null)}
        skeleton={<TableSkeleton rows={6} columns={6} />}
      >
        <div className='space-y-3'>
          <DataTableToolbar
            table={table}
            searchPlaceholder='搜索标题 / 正文'
            filters={[
              {
                columnId: 'status',
                title: '状态',
                options: [
                  { label: '草稿', value: 'draft' },
                  { label: '已发布', value: 'published' },
                  { label: '已归档', value: 'archived' },
                ],
              },
              {
                columnId: 'level',
                title: '级别',
                options: [
                  { label: '通知', value: 'info' },
                  { label: '提醒', value: 'warn' },
                  { label: '重要', value: 'critical' },
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
                      {showAll ? '还没有公告。' : '当前没有面向你的公告。'}
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
            <DialogTitle>{editing ? '编辑公告' : '新建公告'}</DialogTitle>
            <DialogDescription>
              受众支持 all / role:admin / user:&lt;id&gt;；草稿不会下发，归档保留记录。
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-3 py-2'>
            <div className='grid gap-1.5'>
              <Label htmlFor='an-title'>标题</Label>
              <Input id='an-title' value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='an-body'>正文</Label>
              <textarea
                id='an-body'
                rows={5}
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                className='border-input bg-background focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-[3px] focus-visible:outline-none'
              />
            </div>
            <div className='grid gap-3 sm:grid-cols-3'>
              <div className='grid gap-1.5'>
                <Label>级别</Label>
                <Select value={form.level} onValueChange={(level) => setForm({ ...form, level })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='info'>通知</SelectItem>
                    <SelectItem value='warn'>提醒</SelectItem>
                    <SelectItem value='critical'>重要</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className='grid gap-1.5'>
                <Label>状态</Label>
                <Select value={form.status} onValueChange={(status) => setForm({ ...form, status })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='draft'>草稿</SelectItem>
                    <SelectItem value='published'>已发布</SelectItem>
                    <SelectItem value='archived'>已归档</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className='grid gap-1.5'>
                <Label htmlFor='an-audience'>受众</Label>
                <Input
                  id='an-audience'
                  value={form.audience}
                  placeholder='all'
                  onChange={(e) => setForm({ ...form, audience: e.target.value })}
                />
              </div>
            </div>
            <div className='flex items-center gap-2'>
              <Checkbox
                id='an-pin'
                checked={form.pinned}
                onCheckedChange={(value) => setForm({ ...form, pinned: !!value })}
              />
              <Label htmlFor='an-pin' className='text-sm font-normal'>
                置顶显示
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
            <Button loading={save.isPending} disabled={!form.title} onClick={() => save.mutate()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={() => setDeleting(null)}
        title='删除公告'
        desc={`删除「${deleting?.title || ''}」？归档可以保留记录。`}
        confirmText='删除'
        cancelBtnText='取消'
        destructive
        isLoading={remove.isPending}
        handleConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </PageHeader>
  )
}
