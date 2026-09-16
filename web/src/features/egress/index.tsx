import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { SectionSkeleton, TableSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { EgressSummary } from './egress-summary'
import { EgressTable } from './egress-table'
import { EgressDetailDialog } from './egress-detail-dialog'
import { egressBindingsQueryOptions } from './queries'

/**
 * 用户 · 出口 IP · 槽 · 凭证 一屏四维。
 *
 * A user's egress is stable; the account behind it rotates on credential death,
 * a spent window, or a cooldown. The page shows what the next sweep would do
 * before it does it, so a change of IP is always explainable after the fact.
 */
export function EgressPage() {
  const query = useQuery(egressBindingsQueryOptions())
  const qc = useQueryClient()
  const [detailUser, setDetailUser] = useState('')
  const [rebindUser, setRebindUser] = useState('')
  const [rebindTo, setRebindTo] = useState('')
  const [releaseSlot, setReleaseSlot] = useState('')

  const data = query.data || {}
  const rows = data.bindings || []
  const egressOptions = useMemo(() => {
    const ids = new Set<string>()
    for (const row of rows) ids.add(row.egress_id)
    for (const row of data.sharing?.shared || []) ids.add(row.egressId)
    if (data.direct_egress?.egress_id) ids.add(data.direct_egress.egress_id)
    for (const slot of data.unbound_slots || []) ids.add(`(未绑定槽 ${slot})`)
    return [...ids].filter(Boolean).sort()
  }, [rows, data.sharing, data.direct_egress, data.unbound_slots])

  const pendingByUser = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of data.pending || []) map.set(item.user_id, item.reason)
    return map
  }, [data.pending])

  const refresh = () => qc.invalidateQueries({ queryKey: egressBindingsQueryOptions().queryKey })

  const post = (path: string, body: Record<string, unknown> = {}) =>
    api<Record<string, unknown>>(`/api/panel/egress-bindings/${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
    })

  const sweep = useMutation({
    mutationFn: (dryRun: boolean) => post('sweep', { dry_run: dryRun }),
    onSuccess: async (result, dryRun) => {
      const moved = Number(result.moved ?? 0)
      const failed = Number(result.failed ?? 0)
      if (dryRun) {
        toast.success(`预演：会迁移 ${Array.isArray(result.results) ? result.results.length : 0} 个用户`)
      } else {
        toast.success(`已迁移 ${moved} 个用户${failed ? `，${failed} 个无目标` : ''}`)
      }
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const migrate = useMutation({
    mutationFn: (userId: string) => post('migrate', { user_id: userId, reason: 'manual' }),
    onSuccess: async (result) => {
      if (result.ok) {
        toast.success(`已换到 ${String(result.slotId ?? '')}（同一 IP）`)
      } else {
        toast.error(`同 IP 内没有可用槽：${String(result.reason ?? '')}`)
      }
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const rebind = useMutation({
    mutationFn: ({ userId, egressId }: { userId: string; egressId: string }) =>
      post('rebind', { user_id: userId, egress_id: egressId }),
    onSuccess: async (result) => {
      if (result.ok) {
        toast.success(result.slotId ? `已改绑到 ${String(result.egressId)}` : '已改绑，但该 IP 暂无可用槽')
      } else {
        toast.error(String(result.reason ?? '改绑失败'))
      }
      setRebindUser('')
      setRebindTo('')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const release = useMutation({
    mutationFn: (slotId: string) => post('release', { slot_id: slotId }),
    onSuccess: async (result) => {
      toast.success(`已释放 ${String(result.released ?? 0)} 个用户（保留 IP 归属）`)
      setReleaseSlot('')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const cool = useMutation({
    mutationFn: (slotId: string) => post('cool', { slot_id: slotId, minutes: 5 }),
    onSuccess: async (result) => {
      if (result.ok) toast.success('已冷却 5 分钟')
      else toast.error(String(result.reason ?? '冷却失败'))
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const busy =
    sweep.isPending || migrate.isPending || rebind.isPending || release.isPending || cool.isPending

  return (
    <PageHeader
      title='出口绑定'
      extra={
        <div className='flex gap-2'>
          <Button
            variant='outline'
            disabled={busy}
            loading={sweep.isPending && sweep.variables === true}
            title='只看会迁移谁，不写任何东西'
            onClick={() => sweep.mutate(true)}
          >
            预演
          </Button>
          <Button
            disabled={busy}
            loading={sweep.isPending && sweep.variables === false}
            title='立即执行一次迁移扫描'
            onClick={() => sweep.mutate(false)}
          >
            立即扫描
          </Button>
        </div>
      }
    >
      <QueryGate
        loading={query.isLoading}
        error={query.error || (data.error ? new Error(data.error) : null)}
        skeleton={
          <div>
            <SectionSkeleton className='mb-4' titleWidth='w-28' showDescription rows={2} />
            <TableSkeleton rows={8} columns={7} />
          </div>
        }
      >
        <EgressSummary data={data} />
        <EgressTable
          rows={rows}
          busy={busy}
          pendingByUser={pendingByUser}
          sessionsByEgress={data.sessions_by_egress || {}}
          onMigrate={(userId) => migrate.mutate(userId)}
          onRebind={(userId) => {
            setRebindUser(userId)
            setRebindTo('')
          }}
          onRelease={setReleaseSlot}
          onCool={(slotId) => cool.mutate(slotId)}
          onDetail={setDetailUser}
        />
      </QueryGate>

      <EgressDetailDialog
        userId={detailUser}
        onOpenChange={(open) => !open && setDetailUser('')}
      />

      <ConfirmDialog
        open={!!rebindUser}
        onOpenChange={() => setRebindUser('')}
        title='改绑出口 IP'
        desc={
          rebindTo
            ? `把 ${rebindUser} 改绑到 ${rebindTo}？这会给该用户换一个新 IP，并写入审计。`
            : '请选择目标 IP。'
        }
        confirmText='改绑'
        cancelBtnText='取消'
        destructive
        isLoading={rebind.isPending}
        handleConfirm={() => {
          if (rebindUser && rebindTo) rebind.mutate({ userId: rebindUser, egressId: rebindTo })
        }}
      >
        <div className='flex flex-wrap gap-2 py-2'>
          {egressOptions.map((id) => (
            <Button
              key={id}
              size='sm'
              variant={rebindTo === id ? 'default' : 'outline'}
              className='font-mono text-xs'
              onClick={() => setRebindTo(id)}
            >
              {id}
            </Button>
          ))}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={!!releaseSlot}
        onOpenChange={() => setReleaseSlot('')}
        title='释放槽上的用户'
        desc={`释放 ${releaseSlot} 上的用户绑定。用户保留原 IP 归属，下次请求会在同 IP 内重新落槽。`}
        confirmText='释放'
        cancelBtnText='取消'
        destructive
        isLoading={release.isPending}
        handleConfirm={() => releaseSlot && release.mutate(releaseSlot)}
      />
    </PageHeader>
  )
}
