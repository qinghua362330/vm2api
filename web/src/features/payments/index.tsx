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
import { Switch } from '@/components/ui/switch'
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
import { ordersQueryOptions, paymentConfigQueryOptions, type PaymentConfig, type PaymentOrder } from './queries'

const STATUS_LABELS: Record<string, string> = {
  pending: '待支付',
  paid: '已支付',
  failed: '失败',
  expired: '已过期',
  refunded: '已退款',
}
const STATUS_VARIANT: Record<string, 'outline' | 'secondary' | 'destructive'> = {
  pending: 'outline',
  paid: 'secondary',
  failed: 'destructive',
  expired: 'outline',
  refunded: 'outline',
}
const CHANNEL_LABELS: Record<string, string> = { easypay: '易支付', stripe: 'Stripe', manual: '人工' }

/**
 * 订单 + 支付设置 — sub2api's OrdersView / payment settings shape.
 *
 * The list is the audit surface: an order only ever credits once, so a `paid`
 * row that a support ticket disputes can be checked against its 流水 entry by
 * order_no. Manual confirm exists for the case where a gateway callback never
 * arrived, and it goes through the same idempotent path.
 */
export function PaymentsPage() {
  const qc = useQueryClient()
  const [status, setStatus] = useState('')
  const orders = useQuery(ordersQueryOptions(status))
  const cfg = useQuery(paymentConfigQueryOptions())
  const [confirming, setConfirming] = useState<PaymentOrder | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [draft, setDraft] = useState<PaymentConfig | null>(null)
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = useState({})

  const rows = orders.data?.orders || []
  const totals = orders.data?.totals || {}
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['panel', 'payments'] })
  }

  const confirm = useMutation({
    mutationFn: (orderNo: string) =>
      api<{ ok?: boolean; alreadyPaid?: boolean; reason?: string }>(
        `/api/panel/payments/orders/${encodeURIComponent(orderNo)}/confirm`,
        { method: 'POST' },
      ),
    onSuccess: async (res) => {
      if (res?.ok === false) {
        toast.error(String(res.reason || '确认失败'))
        return
      }
      toast.success(res?.alreadyPaid ? '该订单已经入账过' : '已确认并入账')
      setConfirming(null)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const saveConfig = useMutation({
    mutationFn: (patch: Partial<PaymentConfig>) =>
      api('/api/panel/payments/config', { method: 'PUT', body: JSON.stringify(patch) }),
    onSuccess: async () => {
      toast.success('已保存')
      setSettingsOpen(false)
      setDraft(null)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const columns = useMemo<ColumnDef<PaymentOrder>[]>(
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
        accessorKey: 'order_no',
        header: ({ column }) => <DataTableColumnHeader column={column} title='订单号' />,
        cell: ({ row }) => <span className='font-mono text-xs'>{row.original.order_no}</span>,
      },
      {
        accessorKey: 'user_id',
        header: ({ column }) => <DataTableColumnHeader column={column} title='用户' />,
        cell: ({ row }) => <span className='font-mono text-xs'>{row.original.user_id}</span>,
      },
      {
        accessorKey: 'channel',
        header: '通道',
        cell: ({ row }) => <Badge variant='outline'>{CHANNEL_LABELS[row.original.channel] || row.original.channel}</Badge>,
        enableSorting: false,
      },
      {
        accessorKey: 'amount',
        header: ({ column }) => <DataTableColumnHeader column={column} title='应付' />,
        cell: ({ row }) => (
          <span className='text-xs'>
            {row.original.currency === 'USD' ? '$' : '¥'}
            {row.original.amount.toFixed(2)}
          </span>
        ),
      },
      {
        accessorKey: 'credit',
        header: ({ column }) => <DataTableColumnHeader column={column} title='到账' />,
        cell: ({ row }) => {
          const bonus = row.original.credit - row.original.amount
          return (
            <div className='flex items-center gap-1 text-xs'>
              <span>¥{row.original.credit.toFixed(2)}</span>
              {bonus > 0.0001 ? <Badge variant='outline'>赠 {bonus.toFixed(2)}</Badge> : null}
            </div>
          )
        },
      },
      {
        accessorKey: 'status',
        header: ({ column }) => <DataTableColumnHeader column={column} title='状态' />,
        cell: ({ row }) => (
          <div className='flex flex-col gap-0.5'>
            <Badge variant={STATUS_VARIANT[row.original.status] || 'outline'}>
              {STATUS_LABELS[row.original.status] || row.original.status}
            </Badge>
            {row.original.fail_reason ? (
              <span className='text-muted-foreground max-w-[16rem] truncate text-xs' title={row.original.fail_reason}>
                {row.original.fail_reason}
              </span>
            ) : null}
          </div>
        ),
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
      },
      {
        id: 'paid_at',
        header: '支付时间',
        cell: ({ row }) => (
          <span className='text-muted-foreground text-xs'>
            {row.original.paid_at ? new Date(row.original.paid_at).toLocaleString() : '—'}
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
              variant='outline'
              disabled={row.original.status !== 'pending'}
              title='网关回调没到时的兜底确认（同样只会入账一次）'
              onClick={() => setConfirming(row.original)}
            >
              人工确认
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

  const openSettings = () => {
    const current = cfg.data?.config
    if (!current) return
    setDraft(JSON.parse(JSON.stringify(current)))
    setSettingsOpen(true)
  }

  const usable = cfg.data?.usable_channels || []

  return (
    <PageHeader
      title='充值订单'
      extra={
        <div className='flex gap-2'>
          <Button variant='outline' onClick={openSettings}>
            支付设置
          </Button>
        </div>
      }
    >
      <div className='mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
        <StatCard
          label='已支付'
          value={`¥${(totals.paid?.amount ?? 0).toFixed(2)}`}
          hint={`${totals.paid?.count ?? 0} 笔 · 到账 ¥${(totals.paid?.credit ?? 0).toFixed(2)}`}
        />
        <StatCard label='待支付' value={String(totals.pending?.count ?? 0)} hint="超时后自动关闭" />
        <StatCard
          label='失败'
          value={String(totals.failed?.count ?? 0)}
          hint="金额不符或上游拒绝"
          tone={(totals.failed?.count ?? 0) > 0 ? 'warn' : 'neutral'}
        />
        <StatCard
          label='可用通道'
          value={String(usable.length)}
          hint={usable.length ? usable.map((c) => CHANNEL_LABELS[c] || c).join(' · ') : '未配置'}
          tone={usable.length ? 'neutral' : 'warn'}
        />
      </div>

      <QueryGate
        loading={orders.isLoading}
        error={orders.error || (orders.data?.error ? new Error(orders.data.error) : null)}
        skeleton={<TableSkeleton rows={8} columns={8} />}
      >
        <div className='space-y-3'>
          <DataTableToolbar
            table={table}
            searchPlaceholder='搜索订单号 / 用户'
            filters={[
              {
                columnId: 'status',
                title: '状态',
                options: Object.entries(STATUS_LABELS).map(([value, label]) => ({ label, value })),
              },
            ]}
          />
          <div className='flex justify-end'>
            <Button size='sm' variant='ghost' onClick={() => setStatus(status ? '' : 'pending')}>
              {status ? '显示全部' : '只看待支付'}
            </Button>
          </div>
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
                      还没有订单。
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <DataTablePagination table={table} />
        </div>
      </QueryGate>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className='max-w-2xl'>
          <DialogHeader>
            <DialogTitle>支付设置</DialogTitle>
            <DialogDescription>
              密钥留空表示不修改。回调必须验签，金额必须与订单一致才会入账。
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className='grid max-h-[60vh] gap-4 overflow-y-auto py-2'>
              <div className='flex items-center justify-between rounded-md border p-3'>
                <div>
                  <Label>启用充值</Label>
                  <p className='text-muted-foreground text-xs'>关闭后所有下单接口都会拒绝</p>
                </div>
                <Switch
                  checked={draft.enabled}
                  onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
                />
              </div>

              <div className='grid gap-3 rounded-md border p-3'>
                <div className='flex items-center justify-between'>
                  <Label>易支付</Label>
                  <Switch
                    checked={draft.channels.easypay.enabled}
                    onCheckedChange={(enabled) =>
                      setDraft({ ...draft, channels: { ...draft.channels, easypay: { ...draft.channels.easypay, enabled } } })
                    }
                  />
                </div>
                <div className='grid gap-3 sm:grid-cols-2'>
                  <div className='grid gap-1.5'>
                    <Label htmlFor='ep-pid'>商户 PID</Label>
                    <Input
                      id='ep-pid'
                      value={draft.channels.easypay.pid}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          channels: { ...draft.channels, easypay: { ...draft.channels.easypay, pid: e.target.value } },
                        })
                      }
                    />
                  </div>
                  <div className='grid gap-1.5'>
                    <Label htmlFor='ep-key'>商户密钥</Label>
                    <Input
                      id='ep-key'
                      type='password'
                      placeholder={draft.channels.easypay.key === '__SET__' ? '已配置（留空不改）' : '未配置'}
                      value={draft.channels.easypay.key === '__SET__' ? '' : draft.channels.easypay.key}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          channels: { ...draft.channels, easypay: { ...draft.channels.easypay, key: e.target.value } },
                        })
                      }
                    />
                  </div>
                </div>
                <div className='grid gap-1.5'>
                  <Label htmlFor='ep-url'>提交地址</Label>
                  <Input
                    id='ep-url'
                    value={draft.channels.easypay.submit_url}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        channels: {
                          ...draft.channels,
                          easypay: { ...draft.channels.easypay, submit_url: e.target.value },
                        },
                      })
                    }
                  />
                </div>
              </div>

              <div className='grid gap-3 rounded-md border p-3'>
                <div className='flex items-center justify-between'>
                  <Label>Stripe</Label>
                  <Switch
                    checked={draft.channels.stripe.enabled}
                    onCheckedChange={(enabled) =>
                      setDraft({ ...draft, channels: { ...draft.channels, stripe: { ...draft.channels.stripe, enabled } } })
                    }
                  />
                </div>
                <div className='grid gap-1.5'>
                  <Label htmlFor='st-secret'>Secret Key</Label>
                  <Input
                    id='st-secret'
                    type='password'
                    placeholder={draft.channels.stripe.secret_key === '__SET__' ? '已配置（留空不改）' : '未配置'}
                    value={draft.channels.stripe.secret_key === '__SET__' ? '' : draft.channels.stripe.secret_key}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        channels: { ...draft.channels, stripe: { ...draft.channels.stripe, secret_key: e.target.value } },
                      })
                    }
                  />
                </div>
                <div className='grid gap-1.5'>
                  <Label htmlFor='st-wh'>Webhook Secret</Label>
                  <Input
                    id='st-wh'
                    type='password'
                    placeholder={draft.channels.stripe.webhook_secret === '__SET__' ? '已配置（留空不改）' : '未配置'}
                    value={draft.channels.stripe.webhook_secret === '__SET__' ? '' : draft.channels.stripe.webhook_secret}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        channels: {
                          ...draft.channels,
                          stripe: { ...draft.channels.stripe, webhook_secret: e.target.value },
                        },
                      })
                    }
                  />
                </div>
              </div>

              <div className='grid gap-3 rounded-md border p-3'>
                <Label>充值套餐</Label>
                <div className='grid gap-2 sm:grid-cols-3'>
                  <div className='grid gap-1.5'>
                    <Label htmlFor='pk-min' className='text-xs font-normal'>
                      最低金额
                    </Label>
                    <Input
                      id='pk-min'
                      value={String(draft.min_amount)}
                      onChange={(e) => setDraft({ ...draft, min_amount: Number(e.target.value) || 0 })}
                    />
                  </div>
                  <div className='grid gap-1.5'>
                    <Label htmlFor='pk-ttl' className='text-xs font-normal'>
                      订单有效期（分钟）
                    </Label>
                    <Input
                      id='pk-ttl'
                      value={String(draft.order_ttl_minutes)}
                      onChange={(e) => setDraft({ ...draft, order_ttl_minutes: Number(e.target.value) || 30 })}
                    />
                  </div>
                </div>
                <p className='text-muted-foreground text-xs'>
                  现有套餐：{draft.packages.map((p) => `${p.name}(到账${p.credit})`).join('、') || '无'}
                </p>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant='outline' onClick={() => setSettingsOpen(false)}>
              取消
            </Button>
            <Button
              loading={saveConfig.isPending}
              disabled={!draft}
              onClick={() => {
                if (!draft) return
                // A redacted secret that was never retyped must not be written
                // back as the literal marker.
                const clean = JSON.parse(JSON.stringify(draft))
                for (const name of ['easypay', 'stripe'] as const) {
                  for (const field of ['key', 'secret_key', 'webhook_secret'] as const) {
                    if (clean.channels[name][field] === '__SET__') clean.channels[name][field] = ''
                  }
                }
                saveConfig.mutate(clean)
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirming}
        onOpenChange={() => setConfirming(null)}
        title='人工确认入账'
        desc={`确认订单 ${confirming?.order_no || ''} 已收款并给 ${confirming?.user_id || ''} 入账 ¥${(confirming?.credit ?? 0).toFixed(2)}？同一订单只会入账一次。`}
        confirmText='确认入账'
        cancelBtnText='取消'
        isLoading={confirm.isPending}
        handleConfirm={() => confirming && confirm.mutate(confirming.order_no)}
      />
    </PageHeader>
  )
}
