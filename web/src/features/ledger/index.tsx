import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
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
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { TableSkeleton } from '@/components/page-skeletons'
import { StatCard } from '@/components/stat-card'
import { DataTableColumnHeader, DataTablePagination, DataTableToolbar } from '@/components/data-table'
import { LEDGER_SOURCE_LABELS, ledgerQueryOptions } from './queries'
import type { LedgerEntry } from '@/features/wallet/queries'

/**
 * 余额流水 — the audit view over every movement.
 *
 * This is the table that answers "why is this user's balance 12.30": each row
 * carries what changed, what it landed on, and what caused it (source + ref,
 * which is the code or order number). Nothing moves a balance without a row here.
 */
export function LedgerPage() {
  const [userId, setUserId] = useState('')
  const query = useQuery(ledgerQueryOptions(userId.trim()))
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = useState({})

  const rows = query.data?.entries || []
  const totals = query.data?.totals || {}

  const columns = useMemo<ColumnDef<LedgerEntry>[]>(
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
          <span className='text-muted-foreground text-xs'>
            {row.original.created_at ? new Date(row.original.created_at).toLocaleString() : '—'}
          </span>
        ),
      },
      {
        accessorKey: 'user_id',
        header: ({ column }) => <DataTableColumnHeader column={column} title='用户' />,
        cell: ({ row }) => <span className='font-mono text-xs'>{row.original.user_id}</span>,
      },
      {
        accessorKey: 'source',
        header: ({ column }) => <DataTableColumnHeader column={column} title='来源' />,
        cell: ({ row }) => (
          <Badge variant='outline'>{LEDGER_SOURCE_LABELS[row.original.source] || row.original.source}</Badge>
        ),
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
      },
      {
        accessorKey: 'delta',
        header: ({ column }) => <DataTableColumnHeader column={column} title='变动' />,
        cell: ({ row }) => (
          <span className={`text-xs ${row.original.delta >= 0 ? 'text-ok-3' : 'text-destructive'}`}>
            {row.original.delta >= 0 ? '+' : ''}
            {row.original.delta.toFixed(2)}
          </span>
        ),
      },
      {
        accessorKey: 'balance_after',
        header: ({ column }) => <DataTableColumnHeader column={column} title='变动后余额' />,
        cell: ({ row }) => <span className='text-xs'>¥{row.original.balance_after.toFixed(2)}</span>,
      },
      {
        accessorKey: 'ref',
        header: '关联',
        cell: ({ row }) => (
          <span className='text-muted-foreground font-mono text-xs'>{row.original.ref || '—'}</span>
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'notes',
        header: '备注',
        cell: ({ row }) => (
          <span className='text-muted-foreground block max-w-[16rem] truncate text-xs' title={row.original.notes || ''}>
            {row.original.notes || '—'}
          </span>
        ),
        enableSorting: false,
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

  const paid = totals.payment?.total ?? 0
  const redeemed = totals.redeem?.total ?? 0
  const adjusted = totals.admin?.total ?? 0
  const consumed = Math.abs(totals.usage?.total ?? 0)

  return (
    <PageHeader
      title='余额流水'
      extra={
        <Input
          value={userId}
          placeholder='按 user_id 过滤'
          className='h-9 w-64 font-mono text-xs'
          onChange={(e) => setUserId(e.target.value)}
        />
      }
    >
      <div className='mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
        <StatCard label='充值入账' value={`¥${paid.toFixed(2)}`} hint={`${totals.payment?.count ?? 0} 笔`} />
        <StatCard label='兑换码入账' value={`¥${redeemed.toFixed(2)}`} hint={`${totals.redeem?.count ?? 0} 笔`} />
        <StatCard label='人工调整' value={`¥${adjusted.toFixed(2)}`} hint={`${totals.admin?.count ?? 0} 笔`} />
        <StatCard label='消费' value={`¥${consumed.toFixed(2)}`} hint={`${totals.usage?.count ?? 0} 笔`} tone='warn' />
      </div>

      <QueryGate
        loading={query.isLoading}
        error={query.error || (query.data?.error ? new Error(query.data.error) : null)}
        skeleton={<TableSkeleton rows={10} columns={7} />}
      >
        <div className='space-y-3'>
          <DataTableToolbar
            table={table}
            searchPlaceholder='搜索 user_id / 关联号 / 备注'
            filters={[
              {
                columnId: 'source',
                title: '来源',
                options: Object.entries(LEDGER_SOURCE_LABELS).map(([value, label]) => ({ label, value })),
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
                      没有匹配的流水。
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <DataTablePagination table={table} />
        </div>
      </QueryGate>
    </PageHeader>
  )
}
