import { NAV_ITEMS } from '@/config/nav'
import { describe, expect, it } from 'vitest'
import { navGroupsFor, navItemsFor } from './sidebar-data'

/**
 * 侧边栏分组。
 *
 * 上一次的教训：新页面只加了 nav.ts、没加分组表，于是 11 个页面全掉进无名分组
 * 「其他」，堆在侧边栏最下面 —— 运营看到的就是"页面很乱"。这两条断言把顺序钉住。
 */
describe('侧边栏分组', () => {
  it('每个页面都落在具名分组里（不许有「其他」）', () => {
    const groups = navGroupsFor()
    const titles = groups.map((group) => group.title)
    expect(titles).not.toContain('其他')
    const placed = groups.flatMap((group) =>
      group.items.map((item) => item.url)
    )
    expect(placed.sort()).toEqual(NAV_ITEMS.map((item) => item.url).sort())
  })

  it('分组顺序就是操作顺序，接入组内按 出口 → 槽 → 凭证 排', () => {
    const titles = navGroupsFor().map((group) => group.title)
    expect(titles).toEqual(['总览', '接入', '分发', '运营', '账', '配置'])

    const intake = navGroupsFor().find((group) => group.title === '接入')
    const urls = (intake?.items || []).map((item) => item.url)
    expect(urls.slice(0, 3)).toEqual(['/proxies', '/vm', '/import'])

    const dispatch = navGroupsFor().find((group) => group.title === '分发')
    expect((dispatch?.items || []).map((item) => item.url)).toEqual([
      '/channels',
      '/egress',
      '/users',
    ])
  })

  it('按角色过滤时不会把没授权的页面漏出来', () => {
    const items = navItemsFor([
      'vm',
      'proxies',
      'keys',
      'billing',
      'logs',
      'wallet',
      'announcements',
    ])
    // 过滤顺序 = NAV_ITEMS 顺序（也就是操作顺序），不是传入的 views 顺序
    expect(items.map((item) => item.id)).toEqual([
      'proxies',
      'vm',
      'billing',
      'logs',
      'announcements',
      'wallet',
      'keys',
    ])
    // undefined = 不过滤（单运营安装），空数组 = 什么都看不到
    expect(navItemsFor(undefined).length).toBe(NAV_ITEMS.length)
    expect(navItemsFor([]).length).toBe(0)
  })
})
