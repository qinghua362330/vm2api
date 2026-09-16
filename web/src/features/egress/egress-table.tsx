import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { EgressBindingRow } from '@/types/panel-egress'
import { cn } from '@/lib/utils'
import {
  egressLabel,
  migrationReasonLabel,
  reasonCrossesEgress,
  slotStateClass,
  slotStateView,
} from './slot-state'

type Props = {
  rows: EgressBindingRow[]
  busy: boolean
  /** Users whose next sweep will move them, keyed by user id. */
  pendingByUser: Map<string, string>
  /** Live conversations pinned per egress. */
  sessionsByEgress: Record<string, number>
  onMigrate: (userId: string) => void
  onRebind: (userId: string) => void
  onRelease: (slotId: string) => void
  onCool: (slotId: string) => void
  onDetail: (userId: string) => void
}

/**
 * 用户 / 出口 IP / 槽 / 凭证 in one row.
 *
 * `slot_state` is the scheduler's live verdict, so the "状态" column answers
 * "why is traffic not going here" instead of just showing a colour.
 */
export function EgressTable({
  rows,
  busy,
  pendingByUser,
  sessionsByEgress,
  onMigrate,
  onRebind,
  onRelease,
  onCool,
  onDetail,
}: Props) {
  if (!rows.length) {
    return (
      <p className='text-muted-foreground py-8 text-center text-sm'>
        还没有用户绑定。用户第一次调用 /v1 时会自动分配一个出口 IP。
      </p>
    )
  }

  return (
    <Table density='compact'>
      <TableHeader>
        <TableRow>
          <TableHead>用户</TableHead>
          <TableHead>出口 IP</TableHead>
          <TableHead>桶 / 会话</TableHead>
          <TableHead>槽</TableHead>
          <TableHead>凭证</TableHead>
          <TableHead>状态</TableHead>
          <TableHead>迁移</TableHead>
          <TableHead className='text-right'>操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const view = slotStateView(row.slot_state)
          const pending = pendingByUser.get(row.user_id)
          const cred = row.credential
          return (
            <TableRow key={row.user_id}>
              <TableCell className='font-mono text-xs'>{row.user_id}</TableCell>
              <TableCell>
                <span className='font-mono text-xs'>
                  {egressLabel(row)}
                </span>
                {row.egress_kind === 'direct' ? (
                  <Badge variant='outline' className='ml-2'>
                    共享
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className='text-xs'>
                <span title={(row.buckets || []).join('、')}>
                  {row.bucket_count ?? 1} 个桶
                </span>
                {(row.bucket_count ?? 1) > 1 ? (
                  <Badge variant='outline' className='ml-2' title='对话按 session 固定在各桶内'>
                    按会话分流
                  </Badge>
                ) : null}
                <span className='text-muted-foreground ml-2'>
                  会话 {sessionsByEgress[row.egress_id] ?? 0}
                </span>
              </TableCell>
              <TableCell className='font-mono text-xs'>
                {row.slot_id || <span className='text-destructive'>无</span>}
                {row.slot_present === false ? (
                  <Badge variant='destructive' className='ml-2'>
                    已删除
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className='text-xs'>
                {cred ? (
                  <span className='flex flex-col'>
                    <span className='truncate' title={cred.email || ''}>
                      {cred.email || '—'}
                    </span>
                    <span className='text-muted-foreground'>
                      {cred.has_access ? 'access' : 'no-access'}
                      {cred.has_refresh ? ' · refresh' : ''}
                      {cred.schedulable === false ? ' · 停调' : ''}
                    </span>
                  </span>
                ) : (
                  <span className='text-muted-foreground'>—</span>
                )}
              </TableCell>
              <TableCell className='text-xs'>
                <span className={cn(slotStateClass(view.tone))}>{view.label}</span>
                {pending ? (
                  <Badge variant='outline' className='ml-2'>
                    待迁移：{migrationReasonLabel(pending)}
                  </Badge>
                ) : null}
                {row.invariant_ok === false ? (
                  <Badge variant='destructive' className='ml-2'>
                    绑定漂移
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className='text-xs'>
                <span title={`最近：${migrationReasonLabel(row.last_reason)}`}>
                  {row.migrations ?? 0} 次
                </span>
                {reasonCrossesEgress(row.last_reason) ? (
                  <Badge variant='outline' className='ml-2'>
                    换过 IP
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className='text-right'>
                <div className='flex justify-end gap-1'>
                  <Button
                    size='sm'
                    variant='ghost'
                    disabled={busy}
                    onClick={() => onDetail(row.user_id)}
                  >
                    历史
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={busy}
                    title='在同一个 IP 内换一个槽'
                    onClick={() => onMigrate(row.user_id)}
                  >
                    同 IP 换槽
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={busy}
                    title='改绑到另一个 IP（会记录审计）'
                    onClick={() => onRebind(row.user_id)}
                  >
                    换 IP
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    disabled={busy || !row.slot_id}
                    title='槽停止服务，释放其上的用户，保留 IP 归属'
                    onClick={() => row.slot_id && onRelease(row.slot_id)}
                  >
                    释放
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    disabled={busy || !row.slot_id}
                    title='把槽打入冷却，迁移会跳过它'
                    onClick={() => row.slot_id && onCool(row.slot_id)}
                  >
                    冷却
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
