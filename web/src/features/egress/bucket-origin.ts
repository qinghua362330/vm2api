import type { EgressBucketRow } from '@/types/panel-egress'

/**
 * 一个桶（IP）是怎么来的。
 *
 * 跨 IP 迁移会给用户**追加**一个桶，并把 primary 挪过去，老 IP 留在集合里 ——
 * 跑久了集合里会混着"原生出口"和若干"迁移攒出来的 IP"，光看列表分不清哪个才是
 * 他本来的脸。判定只依赖数据本身：
 *
 *   - 绑定时间最早的那个 = 原生出口（首次分配写的）；
 *   - 其余由迁移链写的（reason === 'auto'）= 迁移获得；
 *   - 管理员手工加的（reason === 'admin'）= 管理员添加。
 *
 * 时间缺失时（老数据、021 回填）不猜：退回"primary 即原生"，其余按 reason 分类。
 */
export type BucketOrigin = 'original' | 'migrated' | 'admin'

export type BucketOriginView = {
  origin: BucketOrigin
  label: string
  /** 迁移得来的桶可以回收 —— 界面据此决定要不要提示 */
  reclaimable: boolean
}

const LABELS: Record<BucketOrigin, string> = {
  original: '原生出口',
  migrated: '迁移获得',
  admin: '管理员添加',
}

function boundAtMs(bucket: EgressBucketRow): number | null {
  const ms = Date.parse(String(bucket.bound_at || ''))
  return Number.isFinite(ms) ? ms : null
}

/**
 * 找出原生出口：绑定时间最早的那个；都有时间且打平时按 primary → egress_id 定序，
 * 保证同一份数据每次渲染得到同一个答案（否则表格会闪）。
 */
export function originalEgressId(
  buckets: EgressBucketRow[] = []
): string | null {
  if (!buckets.length) return null
  const timed = buckets.filter((bucket) => boundAtMs(bucket) != null)
  const pool = timed.length
    ? [...timed].sort(
        (a, b) =>
          (boundAtMs(a) as number) - (boundAtMs(b) as number) ||
          Number(b.is_primary) - Number(a.is_primary) ||
          a.egress_id.localeCompare(b.egress_id)
      )
    : [...buckets].sort(
        (a, b) =>
          Number(b.is_primary) - Number(a.is_primary) ||
          a.egress_id.localeCompare(b.egress_id)
      )
  return pool[0]?.egress_id || null
}

export function bucketOrigin(
  bucket: EgressBucketRow,
  originalId: string | null
): BucketOriginView {
  const reason = String(bucket.reason || 'auto')
  let origin: BucketOrigin
  if (bucket.egress_id === originalId) origin = 'original'
  else if (reason === 'admin') origin = 'admin'
  else origin = 'migrated'
  return {
    origin,
    label: LABELS[origin],
    // 原生出口不给"回收"提示：把它删了用户就没有自己的脸了。
    reclaimable: origin === 'migrated',
  }
}

/** 表格用的稳定顺序：原先的在上，然后是 primary，再按 IP 定序。 */
export function sortBucketsForDisplay(
  buckets: EgressBucketRow[] = []
): EgressBucketRow[] {
  const originalId = originalEgressId(buckets)
  return [...buckets].sort((a, b) => {
    if (a.egress_id === originalId) return -1
    if (b.egress_id === originalId) return 1
    return (
      Number(b.is_primary) - Number(a.is_primary) ||
      a.egress_id.localeCompare(b.egress_id)
    )
  })
}
