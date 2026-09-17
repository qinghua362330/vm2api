/**
 * 用户管理 — modelled on sub2api's UsersView.
 *
 * Columns keep sub2api's ordering (identity → role → limits → status →
 * activity → created → actions) reduced to the fields this build has, plus the
 * egress binding so an operator sees which IP a user comes from without
 * leaving the page.
 */

import type { EgressMigrationRow } from './panel-egress'

export type UserEgress = {
  /** Every egress this user may use, primary first. 1 = one stable IP. */
  buckets: string[]
  slot: {
    slot_id: string
    egress_id: string
    migrations: number
    last_reason?: string | null
  } | null
}

export type PanelUserRow = {
  id: string
  username: string
  email?: string | null
  role: string
  status: string
  enabled?: boolean
  balance?: number
  concurrency?: number
  vm_create_quota?: number
  notes?: string
  created_at?: string | null
  updated_at?: string | null
  last_login_at?: string | null
  last_active_at?: string | null
  /** Operator-defined fields, keyed by attribute key. */
  attributes?: Record<string, string>
  egress?: UserEgress
}

export type PanelUsersPayload = {
  users?: PanelUserRow[]
  total?: number
  page?: number
  page_size?: number
  /** 请求里带了、但定义已不存在的属性筛选键（服务端按"不生效"处理并在此回报）。 */
  ignored_attribute_filters?: string[]
  error?: string
}

export type PanelUserDetail = {
  user: PanelUserRow
  egress: UserEgress
  migrations?: EgressMigrationRow[]
}

export const USER_ROLES = ['admin', 'super', 'user'] as const
export const USER_STATUSES = ['active', 'disabled'] as const
export const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  super: '超级管理员',
  user: '普通用户',
}
