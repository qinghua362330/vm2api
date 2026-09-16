import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  type ColumnFiltersState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
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
import { DataTableBulkActions, DataTablePagination, DataTableToolbar } from '@/components/data-table'
import { StatCard } from '@/components/stat-card'
import type { PanelUserRow } from '@/types/panel-users'
import { ROLE_LABELS, USER_ROLES } from '@/types/panel-users'
import { usersQueryOptions } from './queries'
import { userColumns } from './user-columns'

type FormState = {
  username: string
  password: string
  role: string
  status: string
  concurrency: string
  vm_create_quota: string
  notes: string
}

const EMPTY_FORM: FormState = {
  username: '',
  password: '',
  role: 'user',
  status: 'active',
  concurrency: '0',
  vm_create_quota: '0',
  notes: '',
}

/**
 * 用户管理 — sub2api's UsersView shape: toolbar (search · faceted filters ·
 * column visibility · primary action) → scrollable table card → pagination, with
 * bulk selection raising a bulk bar.
 */
export function UsersPage() {
  const qc = useQueryClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [sorting, setSorting] = useState<SortingState>([{ id: 'created_at', desc: true }])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = useState({})
  const [editing, setEditing] = useState<PanelUserRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [deleting, setDeleting] = useState<PanelUserRow | null>(null)

  const activeFilter = (id: string): string[] => {
    const found = columnFilters.find((f) => f.id === id)
    return Array.isArray(found?.value) ? (found?.value as string[]) : []
  }

  const query = useQuery(
    usersQueryOptions({
      // The toolbar's search box is a column filter on username.
      search: activeFilter('username')[0] || '',
      role: activeFilter('role')[0] || '',
      status: activeFilter('status')[0] || '',
      page,
      pageSize,
      sortBy: sorting[0]?.id || 'created_at',
      sortOrder: sorting[0]?.desc === false ? 'asc' : 'desc',
    }),
  )

  const rows = query.data?.users || []
  const total = query.data?.total ?? rows.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  const table = useReactTable({
    data: rows,
    columns: userColumns,
    state: { sorting, columnFilters, columnVisibility, rowSelection },
    // Server-side: search / filters / sort / paging all go to the API.
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    pageCount,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    enableRowSelection: true,
  })

  const selected = useMemo(() => table.getFilteredSelectedRowModel().rows.map((r) => r.original), [table, rowSelection])

  // Server-side paging: any filter change starts again from page 1.
  const filterSignature = JSON.stringify(columnFilters)
  const lastSignature = useRef(filterSignature)
  useEffect(() => {
    if (lastSignature.current !== filterSignature) {
      lastSignature.current = filterSignature
      setPage(1)
    }
  }, [filterSignature])

  const refresh = () => qc.invalidateQueries({ queryKey: ['panel', 'users'] })

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        role: form.role,
        status: form.status,
        concurrency: Number(form.concurrency) || 0,
        vm_create_quota: Number(form.vm_create_quota) || 0,
        notes: form.notes,
        ...(form.password ? { password: form.password } : {}),
      }
      if (editing) {
        return api(`/api/panel/users/${encodeURIComponent(editing.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        })
      }
      return api('/api/panel/users', {
        method: 'POST',
        body: JSON.stringify({ ...body, username: form.username, password: form.password }),
      })
    },
    onSuccess: async () => {
      toast.success(editing ? '已保存' : '已创建')
      setEditing(null)
      setCreating(false)
      setForm(EMPTY_FORM)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/panel/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success('已删除')
      setDeleting(null)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const bulkStatus = useMutation({
    mutationFn: async ({ users, status }: { users: PanelUserRow[]; status: string }) => {
      for (const user of users) {
        await api(`/api/panel/users/${encodeURIComponent(user.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status }),
        })
      }
      return users.length
    },
    onSuccess: async (count, { status }) => {
      toast.success(`${count} 个用户已${status === 'active' ? '启用' : '禁用'}`)
      table.resetRowSelection()
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const openEdit = (user: PanelUserRow) => {
    setEditing(user)
    setForm({
      username: user.username,
      password: '',
      role: user.role,
      status: user.status,
      concurrency: String(user.concurrency ?? 0),
      vm_create_quota: String(user.vm_create_quota ?? 0),
      notes: user.notes || '',
    })
  }

  const openCreate = () => {
    setCreating(true)
    setEditing(null)
    setForm(EMPTY_FORM)
  }

  return (
    <PageHeader
      title='用户'
      extra={
        <Button onClick={openCreate}>新建用户</Button>
      }
    >
      <div className='mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
        <StatCard label='用户总数' value={String(total)} hint='全部租户账号' />
        <StatCard
          label='本页启用'
          value={String(rows.filter((r) => r.status === 'active').length)}
          hint={`共 ${rows.length} 行`}
        />
        <StatCard
          label='多桶用户'
          value={String(rows.filter((r) => (r.egress?.buckets?.length || 0) > 1).length)}
          hint='对话按 session 分流'
        />
        <StatCard
          label='未落槽'
          value={String(rows.filter((r) => !r.egress?.slot).length)}
          hint="下次请求时自动分配"
        />
      </div>

      <QueryGate
        loading={query.isLoading}
        error={query.error || (query.data?.error ? new Error(query.data.error) : null)}
        skeleton={<TableSkeleton rows={10} columns={8} />}
      >
        <div className='space-y-3'>
          <DataTableToolbar
            table={table}
            searchKey='username'
            searchPlaceholder='搜索用户名 / 邮箱 / ID'
            filters={[
              {
                columnId: 'role',
                title: '角色',
                options: USER_ROLES.map((role) => ({ label: ROLE_LABELS[role] || role, value: role })),
              },
              {
                columnId: 'status',
                title: '状态',
                options: [
                  { label: '正常', value: 'active' },
                  { label: '已禁用', value: 'disabled' },
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
                    <TableHead className='text-right'>操作</TableHead>
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
                      <TableCell className='text-right'>
                        <div className='flex justify-end gap-1'>
                          <Button size='sm' variant='ghost' onClick={() => openEdit(row.original)}>
                            编辑
                          </Button>
                          <Button
                            size='sm'
                            variant='ghost'
                            className='text-destructive'
                            onClick={() => setDeleting(row.original)}
                          >
                            删除
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={userColumns.length + 1} className='h-24 text-center'>
                      没有匹配的用户
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className='flex items-center justify-end gap-2'>
            <Select
              value={String(pageSize)}
              onValueChange={(value) => {
                setPageSize(Number(value))
                setPage(1)
              }}
            >
              <SelectTrigger className='h-8 w-28'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[20, 50, 100].map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    每页 {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DataTablePagination table={table} />

          <DataTableBulkActions table={table} entityName='用户'>
            <Button
              size='sm'
              variant='outline'
              disabled={bulkStatus.isPending}
              onClick={() => bulkStatus.mutate({ users: selected, status: 'active' })}
            >
              批量启用
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={bulkStatus.isPending}
              onClick={() => bulkStatus.mutate({ users: selected, status: 'disabled' })}
            >
              批量禁用
            </Button>
          </DataTableBulkActions>
        </div>
      </QueryGate>

      <Dialog
        open={creating || !!editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false)
            setEditing(null)
            setForm(EMPTY_FORM)
          }
        }}
      >
        <DialogContent className='max-w-lg'>
          <DialogHeader>
            <DialogTitle>{editing ? `编辑 ${editing.username}` : '新建用户'}</DialogTitle>
          </DialogHeader>
          <div className='grid gap-3 py-2'>
            {!editing ? (
              <div className='grid gap-1.5'>
                <Label htmlFor='user-name'>用户名</Label>
                <Input
                  id='user-name'
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                />
              </div>
            ) : null}
            <div className='grid gap-1.5'>
              <Label htmlFor='user-pass'>{editing ? '重置密码（留空不改）' : '密码'}</Label>
              <Input
                id='user-pass'
                type='password'
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </div>
            <div className='grid gap-3 sm:grid-cols-2'>
              <div className='grid gap-1.5'>
                <Label>角色</Label>
                <Select value={form.role} onValueChange={(role) => setForm({ ...form, role })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {USER_ROLES.map((role) => (
                      <SelectItem key={role} value={role}>
                        {ROLE_LABELS[role] || role}
                      </SelectItem>
                    ))}
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
                    <SelectItem value='active'>正常</SelectItem>
                    <SelectItem value='disabled'>已禁用</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className='grid gap-1.5'>
                <Label htmlFor='user-conc'>并发</Label>
                <Input
                  id='user-conc'
                  value={form.concurrency}
                  onChange={(e) => setForm({ ...form, concurrency: e.target.value })}
                />
              </div>
              <div className='grid gap-1.5'>
                <Label htmlFor='user-quota'>建槽额度</Label>
                <Input
                  id='user-quota'
                  value={form.vm_create_quota}
                  onChange={(e) => setForm({ ...form, vm_create_quota: e.target.value })}
                />
              </div>
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='user-notes'>备注</Label>
              <Input
                id='user-notes'
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
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
            <Button
              loading={save.isPending}
              disabled={!editing && (!form.username || !form.password)}
              onClick={() => save.mutate()}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={() => setDeleting(null)}
        title='删除用户'
        desc={`删除 ${deleting?.username || ''}？其密钥与出口绑定会一并失效。`}
        confirmText='删除'
        cancelBtnText='取消'
        destructive
        isLoading={remove.isPending}
        handleConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </PageHeader>
  )
}
