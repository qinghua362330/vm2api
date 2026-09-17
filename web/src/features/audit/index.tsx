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
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { ACTION_LABELS, auditQueryOptions, type AuditEntry } from './queries'

/** Money and access changes are the rows an operator actually comes here for. */
const SENSITIVE = /^(balance\.|payment\.|user\.delete|channel\.|subscription\.revoke|egress\.)/

function actionTone(action: string): 'destructive' | 'secondary' | 'outline' {
  if (/\.(delete|revoke|purge)$/.test(action)) return 'destructive'
  if (SENSITIVE.test(action)) return 'secondary'
  return 'outline'
}

/**
 * 审计日志 — who changed what.
 *
 * Written at the mutation site with secrets redacted on the way in, so a row here
 * is the answer to "who turned that off" or "who credited this account". The
 * detail column shows the redacted payload; a `[redacted]` value is expected and
 * means the caller passed a secret field.
 */
export function AuditPage() {
  const qc = useQueryClient()
  const query = useQuery(auditQueryOptions())
  const [detail, setDetail] = useState<AuditEntry | null>(null)
  const [purging, setPurging] = useState(false)
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = useState({})

  const rows = query.data?.entries || []
  const stats = query.data?.stats
  const refresh = () => qc.invalidateQueries({ queryKey: ['panel', 'audit-logs'] })

  const purge = useMutation({
    mutationFn: () =>
      api<{ removed?: number }>('/api/panel/audit-logs/purge', {
        method: 'POST',
        body: JSON.stringify({ days: 90 }),
      }),
    onSuccess: async (res) => {
      toast.success(`已清理 ${res?.removed ?? 0} 条 90 天前的记录`)
      setPurging(false)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const columns = useMemo<ColumnDef<AuditEntry>[]>(
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
        accessorKey: 'created_at',
        header: ({ column }) => <DataTableColumnHeader column={column} title='时间' />,
        cell: ({ row }) => (
          <span className='text-muted-foreground text-xs whitespace-nowrap'>
            {row.original.created_at ? new Date(row.original.created_at).toLocaleString() : '—'}
          </span>
        ),
      },
      {
        accessorKey: 'actor',
        header: ({ column }) => <DataTableColumnHeader column={column} title='操作人' />,
        cell: ({ row }) => (
          <div className='flex items-center gap-1 text-xs'>
            <span className='font-medium'>{row.original.actor || '—'}</span>
            {row.original.actor_role ? <Badge variant='outline'>{row.original.actor_role}</Badge> : null}
          </div>
        ),
      },
      {
        accessorKey: 'action',
        header: ({ column }) => <DataTableColumnHeader column={column} title='动作' />,
        cell: ({ row }) => (
          <Badge variant={actionTone(row.original.action)}>
            {ACTION_LABELS[row.original.action] || row.original.action}
          </Badge>
        ),
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
      },
      {
        id: 'target',
        header: '对象',
        cell: ({ row }) => (
          <span className='text-xs'>
            {row.original.target_type ? (
              <>
                <span className='text-muted-foreground'>{row.original.target_type}</span>
                <span className='ml-1 font-mono'>{row.original.target_id || '—'}</span>
              </>
            ) : (
              '—'
            )}
          </span>
        ),
        enableSorting: false,
      },
      {
        id: 'detail',
        header: '详情',
        cell: ({ row }) => {
          const text = row.original.detail ? JSON.stringify(row.original.detail) : ''
          const redacted = text.includes('[redacted]')
          return (
            <div className='flex items-center gap-2'>
              <span className='text-muted-foreground block max-w-[22rem] truncate font-mono text-xs' title={text}>
                {text || '—'}
              </span>
              {redacted ? (
                <Badge variant='outline' title='包含已脱敏的字段'>
                  已脱敏
                </Badge>
              ) : null}
            </div>
          )
        },
        enableSorting: false,
      },
      {
        accessorKey: 'ip',
        header: '来源 IP',
        cell: ({ row }) => <span className='text-muted-foreground font-mono text-xs'>{row.original.ip || '—'}</span>,
        enableSorting: false,
      },
      {
        id: 'actions',
        header: () => <span className='sr-only'>操作</span>,
        cell: ({ row }) => (
          <div className='flex justify-end'>
            <Button size='sm' variant='ghost' onClick={() => setDetail(row.original)}>
              查看
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
    initialState: { pagination: { pageSize: 25 } },
  })

  const money = rows.filter((r) => r.action.startsWith('balance.') || r.action.startsWith('payment.')).length
  const access = rows.filter((r) => /^(user|channel)\./.test(r.action)).length

  return (
    <PageHeader
      title='审计日志'
      extra={
        <Button variant='outline' onClick={() => setPurging(true)}>
          清理 90 天前
        </Button>
      }
    >
      <div className='mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
        <StatCard label='记录总数' value={String(stats?.total ?? rows.length)} hint="全部动作" />
        <StatCard label='本页金额相关' value={String(money)} hint="调账 / 支付" />
        <StatCard label='本页权限相关' value={String(access)} hint="用户 / 渠道" />
        <StatCard
          label='动作种类'
          value={String(stats?.actions?.length ?? 0)}
          hint={
            stats?.actions?.[0]
              ? `最多：${ACTION_LABELS[stats.actions[0].action] || stats.actions[0].action}`
              : '暂无'
          }
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
            searchPlaceholder='搜索操作人 / 对象 / 详情'
            filters={[
              {
                columnId: 'action',
                title: '动作',
                options: Object.entries(ACTION_LABELS).map(([value, label]) => ({ label, value })),
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
                      还没有审计记录。运营端做的每一次改动都会落在这里。
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <DataTablePagination table={table} />
        </div>
      </QueryGate>

      <Dialog open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className='max-w-2xl'>
          <DialogHeader>
            <DialogTitle>{detail ? ACTION_LABELS[detail.action] || detail.action : ''}</DialogTitle>
            <DialogDescription>
              {detail?.actor || '—'} · {detail?.created_at ? new Date(detail.created_at).toLocaleString() : '—'}
              {detail?.ip ? ` · ${detail.ip}` : ''}
            </DialogDescription>
          </DialogHeader>
          <pre className='bg-muted max-h-[50vh] overflow-auto rounded-md p-3 text-xs'>
            {detail?.detail ? JSON.stringify(detail.detail, null, 2) : '（无详情）'}
          </pre>
          <p className='text-muted-foreground text-xs'>
            `[redacted]` 表示该字段属于密钥类，写入时就已被替换，原文不在库里。
          </p>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={purging}
        onOpenChange={setPurging}
        title='清理审计日志'
        desc='删除 90 天前的记录？这一步不可撤销，且会一并写入一条 audit.purge。'
        confirmText='清理'
        cancelBtnText='取消'
        destructive
        isLoading={purge.isPending}
        handleConfirm={() => purge.mutate()}
      />
    </PageHeader>
  )
}
