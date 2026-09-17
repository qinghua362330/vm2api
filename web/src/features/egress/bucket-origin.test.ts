import type { EgressBucketRow } from '@/types/panel-egress'
import { describe, expect, it } from 'vitest'
import {
  bucketOrigin,
  originalEgressId,
  sortBucketsForDisplay,
} from './bucket-origin'

function bucket(patch: Partial<EgressBucketRow>): EgressBucketRow {
  return {
    egress_id: 'proxy-a',
    is_primary: false,
    reason: 'auto',
    bound_at: '2024-01-01T00:00:00.000Z',
    sessions: 0,
    ...patch,
  }
}

describe('originalEgressId', () => {
  it('绑定时间最早的那个是原生出口', () => {
    const buckets = [
      bucket({
        egress_id: 'proxy-new',
        is_primary: true,
        bound_at: '2024-06-01T00:00:00.000Z',
      }),
      bucket({ egress_id: 'proxy-home', bound_at: '2024-01-01T00:00:00.000Z' }),
    ]
    // primary 已经是迁移后的新 IP，但原生出口仍然是时间最早的那个。
    expect(originalEgressId(buckets)).toBe('proxy-home')
  })

  it('时间全部缺失时退回 primary，不猜', () => {
    const buckets = [
      bucket({ egress_id: 'proxy-b', bound_at: null }),
      bucket({ egress_id: 'proxy-a', bound_at: null, is_primary: true }),
    ]
    expect(originalEgressId(buckets)).toBe('proxy-a')
  })

  it('空集合返回 null', () => {
    expect(originalEgressId([])).toBe(null)
  })
})

describe('bucketOrigin', () => {
  it('迁移攒出来的桶标成迁移获得，并可回收', () => {
    const view = bucketOrigin(
      bucket({ egress_id: 'proxy-new', is_primary: true }),
      'proxy-home'
    )
    expect(view.origin).toBe('migrated')
    expect(view.label).toBe('迁移获得')
    expect(view.reclaimable).toBe(true)
  })

  it('原生出口不可回收 —— 删了用户就没有自己的脸了', () => {
    const view = bucketOrigin(bucket({ egress_id: 'proxy-home' }), 'proxy-home')
    expect(view.origin).toBe('original')
    expect(view.reclaimable).toBe(false)
  })

  it('管理员手工加的单独标出来', () => {
    const view = bucketOrigin(
      bucket({ egress_id: 'proxy-pinned', reason: 'admin' }),
      'proxy-home'
    )
    expect(view.origin).toBe('admin')
    expect(view.reclaimable).toBe(false)
  })
})

describe('sortBucketsForDisplay', () => {
  it('原生出口永远排第一，其次 primary', () => {
    const rows = sortBucketsForDisplay([
      bucket({
        egress_id: 'proxy-new',
        is_primary: true,
        bound_at: '2024-06-01T00:00:00.000Z',
      }),
      bucket({
        egress_id: 'proxy-other',
        bound_at: '2024-03-01T00:00:00.000Z',
      }),
      bucket({ egress_id: 'proxy-home', bound_at: '2024-01-01T00:00:00.000Z' }),
    ])
    expect(rows.map((row) => row.egress_id)).toEqual([
      'proxy-home',
      'proxy-new',
      'proxy-other',
    ])
  })
})
