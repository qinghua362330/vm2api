import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
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
import { Skeleton } from '@/components/ui/skeleton'
import { migrationReasonLabel, reasonCrossesEgress } from './slot-state'
import { egressUserQueryOptions } from './queries'

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
                    当前槽 <span className='font-mono'>{detail.slot.slot_id}</span>
                    <Badge variant='outline'>迁移 {detail.slot.migrations} 次</Badge>
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
                  <TableCell className='text-muted-foreground text-xs'>
                    {row.created_at ? new Date(row.created_at).toLocaleString() : '—'}
                  </TableCell>
                  <TableCell className='text-xs'>
                    {migrationReasonLabel(row.reason)}
                    {reasonCrossesEgress(row.reason) ? (
                      <Badge variant='destructive' className='ml-2'>
                        换了 IP
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className='font-mono text-xs'>{row.from_slot || '—'}</TableCell>
                  <TableCell className='font-mono text-xs'>
                    {row.to_slot || <span className='text-warn-3'>等待</span>}
                  </TableCell>
                  <TableCell className='text-muted-foreground text-xs'>
                    {row.detail || '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className='text-muted-foreground py-6 text-center text-sm'>
            没有迁移记录 —— 用户一直待在同一个槽上。
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
