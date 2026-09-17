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
  overview: '总览',
  cluster: '资源',
  vm: '资源',
  import: '资源',
  usage: '运营',
  billing: '运营',
  proxies: '资源',
  egress: '资源',
  models: '配置',
  loadtest: '配置',
  protocol: '配置',
  keys: '配置',
  logs: '运营',
  database: '配置',
  settings: '配置',
  wrap: '配置',
}

const GROUP_ORDER = ['总览', '资源', '运营', '配置']

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
