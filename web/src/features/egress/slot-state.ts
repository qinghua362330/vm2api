/**
 * slot_state → human label + tone.
 *
 * The backend reports the scheduler's own verdict, so the table can say *why*
 * traffic is not going to a slot instead of just colouring it red:
 *
 *   ready                     the scheduler would pick it
 *   quota_5h_cli / quota_7d_* the account's window is spent (moves the user)
 *   cooldown                  parked; comes back on its own
 *   transient:<reason>        busy right now (concurrency / session cap)
 *   no_credential …           credential problems
 */

export type SlotTone = 'ok' | 'warn' | 'bad' | 'muted' | 'busy'

export type SlotStateView = {
  tone: SlotTone
  label: string
  /** true when the binding layer will move the user off this slot. */
  migrates: boolean
}

const LABELS: Record<string, string> = {
  ready: '可用',
  cooldown: '冷却中',
  slot_missing: '槽已不存在',
  no_credential: '无凭证',
  vm_unschedulable: '已停止调度',
  proxy_required: '缺出口代理',
  codex_vm: 'Codex 槽',
}

export function isQuotaState(state: string): boolean {
  return /^quota_|^account_quota_exhausted|^rate_limited/i.test(String(state || ''))
}

export function isTransientState(state: string): boolean {
  return String(state || '').startsWith('transient:')
}

export function slotStateView(state?: string | null): SlotStateView {
  const raw = String(state || '').trim()
  if (!raw) return { tone: 'muted', label: '未知', migrates: false }
  if (raw === 'ready') return { tone: 'ok', label: LABELS.ready, migrates: false }
  if (isTransientState(raw)) {
    return { tone: 'busy', label: `繁忙（${raw.slice('transient:'.length)}）`, migrates: false }
  }
  if (raw === 'cooldown') return { tone: 'warn', label: LABELS.cooldown, migrates: true }
  if (isQuotaState(raw)) return { tone: 'warn', label: `额度用尽（${raw}）`, migrates: true }
  if (LABELS[raw]) return { tone: 'bad', label: LABELS[raw], migrates: true }
  return { tone: 'bad', label: raw, migrates: true }
}

export function slotStateClass(tone: SlotTone): string {
  switch (tone) {
    case 'ok':
      return 'text-ok-3'
    case 'warn':
      return 'text-warn-3'
    case 'busy':
      // No --color-info-* token in the theme; caution is the "temporarily
      // unavailable, will come back" tone.
      return 'text-caution-3'
    case 'bad':
      return 'text-destructive'
    default:
      return 'text-muted-foreground'
  }
}

/** Human label for a migration reason from the audit table. */
export function migrationReasonLabel(reason?: string | null): string {
  const raw = String(reason || '').trim()
  const map: Record<string, string> = {
    credential_dead: '凭证失效',
    quota_exhausted: '额度用尽',
    slot_disabled: '槽停用',
    cooldown: '冷却',
    egress_failover: '换 IP（原 IP 无可用槽）',
    direct_fallback: '回落到本机共享 IP',
    no_target: '无处可去（等待）',
    admin: '管理员改绑',
    manual: '手动迁移',
  }
  return map[raw] || raw || '—'
}

/** True when the reason changed the user's egress, which is the notable case. */
export function reasonCrossesEgress(reason?: string | null): boolean {
  const raw = String(reason || '').trim()
  return raw === 'egress_failover' || raw === 'direct_fallback' || raw === 'admin'
}

export function egressLabel(row: { egress_id?: string; egress_kind?: string }): string {
  const id = String(row?.egress_id || '')
  if (row?.egress_kind === 'direct' || id.startsWith('direct:')) {
    return `本机共享 ${id.slice('direct:'.length) || ''}`.trim()
  }
  return id || '—'
}
