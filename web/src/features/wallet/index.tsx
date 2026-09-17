import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { TableSkeleton } from '@/components/page-skeletons'
import { StatCard } from '@/components/stat-card'
import { paymentConfigQueryOptions, type PaymentOrder } from '@/features/payments/queries'
import { LEDGER_SOURCE_LABELS } from '@/features/ledger/queries'
import { walletQueryOptions } from './queries'

const ORDER_STATUS: Record<string, string> = {
  pending: '待支付',
  paid: '已支付',
  failed: '失败',
  expired: '已过期',
  refunded: '已退款',
}

/**
 * 钱包 — the tenant's own view: balance, what moved it, the live daily
 * allowance, and a top-up flow.
 *
 * Everything here is scoped server-side to the caller (`req.panelUserId`), so a
 * tenant cannot read another wallet by changing a query string; only an operator
 * may pass `user_id`, and the ACL lets a tenant reach exactly these routes.
 */
export function WalletPage() {
  const wallet = useQuery(walletQueryOptions())
  const cfg = useQuery(paymentConfigQueryOptions())
  const [topUpOpen, setTopUpOpen] = useState(false)
  const [packageId, setPackageId] = useState('')
  const [amount, setAmount] = useState('')

  const data = wallet.data
  const packages = cfg.data?.config?.packages || []
  const usable = cfg.data?.usable_channels || []

  const checkout = useMutation({
    mutationFn: () =>
      api<{ order?: PaymentOrder; pay_url?: string | null }>('/api/panel/payments/checkout', {
        method: 'POST',
        body: JSON.stringify({
          package_id: packageId || undefined,
          amount: packageId ? undefined : Number(amount) || 0,
          channel: usable[0],
        }),
      }),
    onSuccess: async (res) => {
      if (res?.pay_url) {
        // The gateway needs a real browser navigation, not a fetch.
        window.location.href = res.pay_url
        return
      }
      toast.success(`订单 ${res?.order?.order_no || ''} 已创建，请按所选通道完成支付`)
      setTopUpOpen(false)
      await wallet.refetch()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const usage = data?.subscription
  const stats = useMemo(() => {
    const ledger = data?.ledger || []
    const spent = ledger.filter((e) => e.delta < 0).reduce((sum, e) => sum + Math.abs(e.delta), 0)
    const added = ledger.filter((e) => e.delta > 0).reduce((sum, e) => sum + e.delta, 0)
    return { spent, added }
  }, [data?.ledger])

  return (
    <PageHeader
      title='我的钱包'
      extra={
        <Button disabled={!usable.length} onClick={() => setTopUpOpen(true)}>
          {usable.length ? '充值' : '未开通充值'}
        </Button>
      }
    >
      <QueryGate
        loading={wallet.isLoading}
        error={wallet.error || (data?.error ? new Error(data.error) : null)}
        skeleton={<TableSkeleton rows={8} columns={5} />}
      >
        <div className='mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
          <StatCard label='余额' value={`¥${(data?.balance ?? 0).toFixed(2)}`} hint="可直接消费" />
          <StatCard
            label='今日额度'
            value={usage?.active ? (usage.unlimited ? '不限量' : String(usage.remaining ?? 0)) : '无订阅'}
            hint={
              usage?.active && !usage.unlimited && usage.resets_at
                ? `${new Date(usage.resets_at).toLocaleTimeString()} 回满`
                : usage?.active
                  ? `${usage.subscription?.plan || ''} 套餐`
                  : '兑换或购买订阅后生效'
            }
          />
          <StatCard label='累计充值' value={`¥${stats.added.toFixed(2)}`} hint="近 50 笔流水合计" />
          <StatCard label='累计消费' value={`¥${stats.spent.toFixed(2)}`} hint="近 50 笔流水合计" />
        </div>

        <div className='grid gap-3 lg:grid-cols-2'>
          <Card>
            <CardHeader className='pb-2'>
              <CardDescription>余额流水</CardDescription>
              <CardTitle className='text-base'>最近的每一笔变动</CardTitle>
            </CardHeader>
            <CardContent>
              {data?.ledger?.length ? (
                <Table density='compact'>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>来源</TableHead>
                      <TableHead>金额</TableHead>
                      <TableHead>余额</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.ledger.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className='text-muted-foreground text-xs'>
                          {entry.created_at ? new Date(entry.created_at).toLocaleString() : '—'}
                        </TableCell>
                        <TableCell className='text-xs'>
                          {LEDGER_SOURCE_LABELS[entry.source] || entry.source}
                          {entry.ref ? (
                            <span className='text-muted-foreground ml-1 font-mono'>{entry.ref}</span>
                          ) : null}
                        </TableCell>
                        <TableCell
                          className={`text-xs ${entry.delta >= 0 ? 'text-ok-3' : 'text-destructive'}`}
                        >
                          {entry.delta >= 0 ? '+' : ''}
                          {entry.delta.toFixed(2)}
                        </TableCell>
                        <TableCell className='text-xs'>¥{entry.balance_after.toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className='text-muted-foreground py-6 text-center text-sm'>还没有余额变动。</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className='pb-2'>
              <CardDescription>充值订单</CardDescription>
              <CardTitle className='text-base'>最近的订单</CardTitle>
            </CardHeader>
            <CardContent>
              {data?.orders?.length ? (
                <Table density='compact'>
                  <TableHeader>
                    <TableRow>
                      <TableHead>订单号</TableHead>
                      <TableHead>金额</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.orders.map((order) => (
                      <TableRow key={order.id}>
                        <TableCell className='font-mono text-xs'>{order.order_no}</TableCell>
                        <TableCell className='text-xs'>¥{order.amount.toFixed(2)}</TableCell>
                        <TableCell>
                          <Badge variant={order.status === 'paid' ? 'secondary' : 'outline'}>
                            {ORDER_STATUS[order.status] || order.status}
                          </Badge>
                        </TableCell>
                        <TableCell className='text-muted-foreground text-xs'>
                          {order.created_at ? new Date(order.created_at).toLocaleString() : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className='text-muted-foreground py-6 text-center text-sm'>还没有充值记录。</p>
              )}
            </CardContent>
          </Card>
        </div>
      </QueryGate>

      <Dialog open={topUpOpen} onOpenChange={setTopUpOpen}>
        <DialogContent className='max-w-lg'>
          <DialogHeader>
            <DialogTitle>充值</DialogTitle>
            <DialogDescription>
              选一个套餐，或自己填金额。订单有效期 {cfg.data?.config?.order_ttl_minutes ?? 30} 分钟，超时自动关闭。
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-3 py-2'>
            <div className='grid gap-2 sm:grid-cols-3'>
              {packages.map((pkg) => {
                const bonus = pkg.credit - pkg.amount
                const active = packageId === pkg.id
                return (
                  <button
                    key={pkg.id}
                    type='button'
                    onClick={() => {
                      setPackageId(active ? '' : pkg.id)
                      setAmount('')
                    }}
                    className={`rounded-md border p-3 text-left transition ${active ? 'border-primary bg-primary/5' : 'hover:border-primary/50'}`}
                  >
                    <div className='font-medium'>{pkg.name}</div>
                    <div className='text-muted-foreground text-xs'>到账 ¥{pkg.credit.toFixed(2)}</div>
                    {bonus > 0 ? <Badge variant='outline'>赠 ¥{bonus.toFixed(2)}</Badge> : null}
                  </button>
                )
              })}
            </div>
            <div className='grid gap-1.5'>
              <label htmlFor='topup-amount' className='text-sm'>
                或自定义金额（最低 ¥{cfg.data?.config?.min_amount ?? 1}）
              </label>
              <input
                id='topup-amount'
                value={amount}
                disabled={!!packageId}
                onChange={(e) => setAmount(e.target.value)}
                className='border-input bg-background focus-visible:ring-ring/50 h-9 w-full rounded-md border px-3 py-1 text-sm focus-visible:ring-[3px] focus-visible:outline-none disabled:opacity-50'
                placeholder={packageId ? '已选套餐' : '例如 20'}
              />
            </div>
            <p className='text-muted-foreground text-xs'>
              支付通道：{usable.join('、') || '未配置'}。支付成功后余额会自动到账。
            </p>
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => setTopUpOpen(false)}>
              取消
            </Button>
            <Button
              loading={checkout.isPending}
              disabled={!packageId && !(Number(amount) > 0)}
              onClick={() => checkout.mutate()}
            >
              去支付
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageHeader>
  )
}
