import { NAV_ITEMS, VIEW_TITLES, type ViewId } from '@/config/nav'
import type { SidebarData, NavGroup } from './types'

/**
 * Sidebar groups derived from the single nav config in @/config/nav.
 *
 * This module was missing from the public snapshot while app-sidebar.tsx and
 * command-menu.tsx both import it, so the console could not build at all. It is
 * generated from NAV_ITEMS rather than duplicating the list, so adding a view
 * stays a one-line change in nav.ts.
 *
 * `views` is the server's per-role allowlist (panel-auth `me.views`). Undefined
 * means "no filtering" — a single-operator install — and an empty array means
 * the operator may see nothing, which must not silently become "everything".
 */

const GROUP_TITLES: Record<string, string> = {
  // 顺序即操作顺序：接入 → 分发 → 运营 → 账 → 配置。
  // 新页面必须在这里出现，否则会掉进「其他」——那正是它上次变成一锅乱炖的原因。
  overview: '总览',

  proxies: '接入',
  vm: '接入',
  import: '接入',
  cluster: '接入',

  channels: '分发',
  egress: '分发',
  users: '分发',

  usage: '运营',
  billing: '运营',
  'channel-monitor': '运营',
  ops: '运营',
  audit: '运营',
  logs: '运营',
  announcements: '运营',

  redeem: '账',
  subscriptions: '账',
  payments: '账',
  ledger: '账',
  wallet: '账',

  models: '配置',
  protocol: '配置',
  keys: '配置',
  database: '配置',
  settings: '配置',
  loadtest: '配置',
  wrap: '配置',
}

const GROUP_ORDER = ['总览', '接入', '分发', '运营', '账', '配置']

export function navItemsFor(views?: string[] | null): typeof NAV_ITEMS {
  if (!Array.isArray(views)) return NAV_ITEMS
  const allowed = new Set(views.map((view) => String(view || '').trim()))
  return NAV_ITEMS.filter((item) => allowed.has(item.id))
}

export function navGroupsFor(views?: string[] | null): NavGroup[] {
  const items = navItemsFor(views)
  const byTitle = new Map<string, NavGroup>()
  for (const item of items) {
    const title = GROUP_TITLES[item.id] || '其他'
    if (!byTitle.has(title)) byTitle.set(title, { title, items: [] })
    byTitle.get(title)?.items.push({
      title: VIEW_TITLES[item.id as ViewId] || item.id,
      url: item.url,
      icon: item.icon,
    })
  }
  return [...byTitle.entries()]
    .sort(([a], [b]) => {
      const ai = GROUP_ORDER.indexOf(a)
      const bi = GROUP_ORDER.indexOf(b)
      return (
        (ai < 0 ? GROUP_ORDER.length : ai) - (bi < 0 ? GROUP_ORDER.length : bi)
      )
    })
    .map(([, group]) => group)
}

const DEFAULT_USER = {
  name: 'admin',
  email: 'admin@local',
  avatar: '',
}

/** Static shape for the command menu; the sidebar resolves its own user. */
export const sidebarData: SidebarData = {
  user: DEFAULT_USER,
  teams: [],
  navGroups: navGroupsFor(null),
}
