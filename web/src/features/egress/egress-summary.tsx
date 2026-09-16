import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import type { EgressBindingsPayload } from '@/types/panel-egress'
import { egressLabel } from './slot-state'

type Props = {
  data: EgressBindingsPayload
}

/**
 * The four numbers that matter operationally:
 *   users bound to an IP · distinct IPs in use · IPs carrying >1 slot · pending moves
 */
export function EgressSummary({ data }: Props) {
  const bindings = data.bindings || []
  const sharing = data.sharing?.shared || []
  const pending = data.pending || []
  const direct = data.direct_egress
  const drifting = bindings.filter((row) => row.invariant_ok === false).length

  const cards = [
    {
      title: '绑定用户',
      value: bindings.length,
      desc: `${data.unbound_slots?.length ?? 0} 个槽未绑定用户`,
    },
    {
      title: '在用 IP',
      value: data.sharing?.total_egresses ?? 0,
      desc: `${data.sharing?.shared_egresses ?? 0} 个 IP 承载多个槽`,
    },
    {
      title: '在用会话',
      value: data.sessions_total ?? 0,
      desc: '每个对话固定在一个桶内',
    },
    {
      title: '待迁移',
      value: pending.length,
      desc: pending.length ? '下一次扫描会搬走' : '全部可用',
      tone: pending.length ? 'text-warn-3' : undefined,
    },
    {
      title: '绑定异常',
      value: drifting,
      desc: drifting ? '槽已不在绑定的 IP 下' : '账实一致',
      tone: drifting ? 'text-destructive' : undefined,
    },
  ]

  return (
    <div className='mb-4 space-y-3'>
      <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-5'>
        {cards.map((card) => (
          <Card key={card.title}>
            <CardHeader className='pb-2'>
              <CardDescription>{card.title}</CardDescription>
              <CardTitle className={card.tone ?? undefined}>
                {card.value}
              </CardTitle>
            </CardHeader>
            <CardContent className='text-muted-foreground text-xs'>
              {card.desc}
            </CardContent>
          </Card>
        ))}
      </div>

      {direct ? (
        <Card>
          <CardHeader className='pb-2'>
            <CardDescription className='flex items-center gap-2'>
              本机共享出口
              <Badge variant={direct.available ? 'secondary' : 'destructive'}>
                {direct.available ? '可用' : '不可用'}
              </Badge>
            </CardDescription>
            <CardTitle className='font-mono text-base'>
              {egressLabel({ egress_id: direct.egress_id, egress_kind: 'direct' })}
            </CardTitle>
          </CardHeader>
          <CardContent className='text-muted-foreground text-xs'>
            {direct.available
              ? `${direct.slots_count} 个未绑代理的槽从这里出去（${direct.slots.join('、')}）。这是最后的兜底，多用户共享属预期。`
              : '没有未绑代理的槽，代理全部不可用时无处兜底，用户只能等待。'}
          </CardContent>
        </Card>
      ) : null}

      {sharing.length ? (
        <Card>
          <CardHeader className='pb-2'>
            <CardDescription>承载多个槽的出口</CardDescription>
          </CardHeader>
          <CardContent className='space-y-1 text-xs'>
            {sharing.map((row) => (
              <div key={row.egressId} className='flex flex-wrap items-center gap-2'>
                <span className='font-mono'>
                  {egressLabel({ egress_id: row.egressId, egress_kind: row.kind })}
                </span>
                <Badge variant='outline'>{row.slots_count} 槽</Badge>
                <Badge variant='outline'>{row.users} 用户</Badge>
                <span className='text-muted-foreground'>{row.slots.join('、')}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
