/**
 * GET /api/panel/egress-bindings — the user ↔ IP ↔ slot ↔ credential view.
 *
 * A user's egress (IP) is their stable identity; the account behind it rotates
 * on credential death, a spent 5h/7d window, or a cooldown. `slot_state` is the
 * live verdict of the shared scheduler gate, so the table explains *why* a slot
 * is or is not being used rather than just colouring it red.
 */

export type EgressBindingRow = {
  user_id: string
  egress_id: string
  egress_kind: 'proxy' | 'direct'
  egress_reason?: string | null
  /** Every egress this user may use, primary first. 1 = one stable IP. */
  buckets?: string[]
  bucket_count?: number
  slot_id?: string | null
  slot_present?: boolean
  invariant_ok?: boolean
  migrations?: number
  last_reason?: string | null
  /** ready | quota_* | cooldown | transient:* | slot_missing | credential reasons */
  slot_state?: string
  credential?: {
    email?: string | null
    has_access?: boolean
    has_refresh?: boolean
    schedulable?: boolean
  } | null
}

export type EgressSharingRow = {
  egressId: string
  kind: 'proxy' | 'direct'
  slots: string[]
  slots_count: number
  users: number
}

export type EgressMigrationRow = {
  id?: number
  user_id: string
  egress_id: string
  from_slot?: string | null
  to_slot?: string | null
  reason: string
  detail?: string | null
  created_at?: string
}

export type EgressDirectStatus = {
  egress_id: string
  identity: string
  kind: 'direct'
  shared: boolean
  slots: string[]
  slots_count: number
  /** false means there is no proxy-less slot, so the last resort cannot serve. */
  available: boolean
  note?: string
}

export type EgressPendingRow = {
  user_id: string
  from?: string | null
  reason: string
  dry_run?: boolean
}

export type EgressBindingsPayload = {
  bindings?: EgressBindingRow[]
  sharing?: {
    shared?: EgressSharingRow[]
    total_egresses?: number
    shared_egresses?: number
  }
  direct_egress?: EgressDirectStatus
  /** Conversations pinned per egress — a user's sessions spread by bucket. */
  sessions_by_egress?: Record<string, number>
  sessions_total?: number
  unbound_slots?: string[]
  pending?: EgressPendingRow[]
  error?: string
}

export type EgressUserDetail = {
  user_id: string
  egress?: { egress_id: string; reason: string; bound_by?: string | null; bound_at?: string | null } | null
  slot?: { slot_id: string; egress_id: string; migrations: number; last_reason?: string | null } | null
  migrations?: EgressMigrationRow[]
}
