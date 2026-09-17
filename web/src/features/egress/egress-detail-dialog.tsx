import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  bucketOrigin,
  originalEgressId,
  sortBucketsForDisplay,
} from './bucket-origin'
import { egressUserQueryOptions } from './queries'
import { migrationReasonLabel, reasonCrossesEgress } from './slot-state'

type Props = {
  userId: string
  onOpenChange: (open: boolean) => void
}

/**
 * One user's binding and full migration history — the "why did my IP change"
 * answer. Every row is written by the binding layer, including the failed moves
 * (`no_target`), so a wait is explainable too.
 */
export function EgressDetailDialog({ userId, onOpenChange }: Props) {
  const query = useQuery(egressUserQueryOptions(userId))
  const detail = query.data
  const history = detail?.migrations || []
  const buckets = sortBucketsForDisplay(detail?.buckets || [])
  const originalId = originalEgressId(detail?.buckets || [])

  return (
    <Dialog open={!!userId} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-3xl'>
        <DialogHeader>
          <DialogTitle className='font-mono text-base'>{userId}</DialogTitle>
          <DialogDescription>
            {detail?.egress ? (
              <span className='flex flex-wrap items-center gap-2'>
                出口
                <span className='font-mono'>{detail.egress.egress_id}</span>
                <Badge variant='outline'>{detail.egress.reason}</Badge>
                {detail.slot ? (
                  <>
                    当前槽{' '}
                    <span className='font-mono'>{detail.slot.slot_id}</span>
                    <Badge variant='outline'>
                      迁移 {detail.slot.migrations} 次
                    </Badge>
                  </>
                ) : (
                  <Badge variant='outline'>暂无槽</Badge>
                )}
              </span>
            ) : (
              '还没有绑定'
            )}
          </DialogDescription>
        </DialogHeader>

        {query.isLoading ? (
          <Skeleton className='h-32 w-full' />
        ) : (
          <div className='grid gap-2'>
            <p className='text-xs text-muted-foreground'>
              名下 IP ——
              「主」是下一个新对话会用的出口，会话数是他此刻正在用的出口；跨 IP
              迁移会追加一个桶并把「主」挪过去，老 IP 留在集合里。
            </p>
            <div className='overflow-hidden rounded-md border'>
              <Table density='compact'>
                <TableHeader>
                  <TableRow>
                    <TableHead>IP</TableHead>
                    <TableHead>主/次</TableHead>
                    <TableHead>来源</TableHead>
                    <TableHead>绑定时间</TableHead>
                    <TableHead className='text-right'>活跃会话</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {buckets.length ? (
                    buckets.map((bucket) => {
                      const origin = bucketOrigin(bucket, originalId)
                      return (
                        <TableRow key={bucket.egress_id}>
                          <TableCell className='font-mono text-xs'>
                            {bucket.egress_id}
                          </TableCell>
                          <TableCell>
                            {bucket.is_primary ? (
                              <Badge variant='secondary'>主</Badge>
                            ) : (
                              <span className='text-xs text-muted-foreground'>
                                次
                              </span>
                            )}
                          </TableCell>
                          <TableCell className='text-xs'>
                            <Badge
                              variant={
                                origin.origin === 'migrated'
                                  ? 'destructive'
                                  : origin.origin === 'admin'
                                    ? 'secondary'
                                    : 'outline'
                              }
                            >
                              {origin.label}
                            </Badge>
                            {bucket.bound_by ? (
                              <span className='ml-2 text-xs text-muted-foreground'>
                                by {bucket.bound_by}
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell className='text-xs text-muted-foreground'>
                            {bucket.bound_at
                              ? new Date(bucket.bound_at).toLocaleString()
                              : '—'}
                          </TableCell>
                          <TableCell className='text-right text-xs'>
                            {bucket.sessions}
                          </TableCell>
                        </TableRow>
                      )
                    })
                  ) : (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className='h-16 text-center text-xs text-muted-foreground'
                      >
                        还没有绑定任何 IP
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        <p className='text-xs font-medium'>迁移历史</p>
        {query.isLoading ? (
          <Skeleton className='h-24 w-full' />
        ) : history.length ? (
          <Table density='compact'>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>原因</TableHead>
                <TableHead>从</TableHead>
                <TableHead>到</TableHead>
                <TableHead>说明</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((row, index) => (
                <TableRow key={row.id ?? `${row.created_at}-${index}`}>
                  <TableCell className='text-xs text-muted-foreground'>
                    {row.created_at
                      ? new Date(row.created_at).toLocaleString()
                      : '—'}
                  </TableCell>
                  <TableCell className='text-xs'>
                    {migrationReasonLabel(row.reason)}
                    {reasonCrossesEgress(row.reason) ? (
                      <Badge variant='destructive' className='ml-2'>
                        换了 IP
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className='font-mono text-xs'>
                    {row.from_slot || '—'}
                  </TableCell>
                  <TableCell className='font-mono text-xs'>
                    {row.to_slot || <span className='text-warn-3'>等待</span>}
                  </TableCell>
                  <TableCell className='text-xs text-muted-foreground'>
                    {row.detail || '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className='py-6 text-center text-sm text-muted-foreground'>
            没有迁移记录 —— 用户一直待在同一个槽上。
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
