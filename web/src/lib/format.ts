export function pct(value: unknown): number {
  if (value == null) return 0
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 100) return 100
  // Extra / Codex utilization is 0–1. Leftover official Settings numbers are 0–100.
  // `1` is 100% used on the 0–1 contract (and 1% on raw Settings). Panel GPT
  // windows should use usedPctOf() so `used_percent=1` stays 1%.
  return n > 1 ? n : n * 100
}

export function usedPctOf(
  source:
    | {
        utilization_5h?: unknown
        utilization_7d?: unknown
        codex_usage?: {
          windows?: Array<{ id?: string; used_percent?: unknown }>
        } | null
      }
    | null
    | undefined,
  window: '5h' | '7d'
): number {
  const hit = source?.codex_usage?.windows?.find((row) => row?.id === window)
  if (hit?.used_percent != null && hit.used_percent !== '') {
    const n = Number(hit.used_percent)
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, n))
  }
  return pct(window === '5h' ? source?.utilization_5h : source?.utilization_7d)
}

/**
 * 同 usedPctOf，但"没有这个窗口"返回 null 而不是 0。
 *
 * 0% 和"套餐里没有 5 小时窗口"是两件事：前者是"一点没用"，后者是"不存在"。面板上
 * 画成 0% 会让人以为额度没用过（Codex 的 7 天-only 套餐就是这样）。
 */
export function usedPctOrNull(
  source:
    | {
        utilization_5h?: unknown
        utilization_7d?: unknown
        codex_usage?: {
          windows?: Array<{ id?: string; used_percent?: unknown }>
        } | null
      }
    | null
    | undefined,
  window: '5h' | '7d'
): number | null {
  const hit = source?.codex_usage?.windows?.find((row) => row?.id === window)
  if (hit?.used_percent != null && hit.used_percent !== '') {
    const n = Number(hit.used_percent)
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, n))
  }
  const raw = window === '5h' ? source?.utilization_5h : source?.utilization_7d
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, n <= 1 ? n * 100 : n))
}

export function fmtNum(n: unknown): string {
  const v = Number(n) || 0
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return String(Math.round(v))
}

export function fmtUsd(n: unknown, digits?: number): string {
  const v = Number(n)
  if (!Number.isFinite(v) || v === 0) return '$0'
  const d = digits ?? (Math.abs(v) >= 100 ? 2 : Math.abs(v) >= 1 ? 3 : 4)
  return `$${v.toFixed(d)}`
}

export function fmtTok(
  row: Record<string, unknown> | null | undefined
): string {
  if (!row) return '—'
  const usage = (row.usage as Record<string, unknown> | undefined) || {}
  const inn = row.input_tokens ?? usage.input_tokens
  const out = row.output_tokens ?? usage.output_tokens
  const cr = row.cache_read_tokens ?? usage.cache_read_input_tokens
  const cc = row.cache_creation_tokens ?? usage.cache_creation_input_tokens
  if (inn == null && out == null && cr == null && cc == null) return '—'
  let s = `${inn || 0}/${out || 0}`
  if (cr || cc) s += ` · c${Number(cr) || 0}/${Number(cc) || 0}`
  return s
}

export function fmtExpiresAt(value: unknown): string {
  if (!value) return '—'
  const ms = typeof value === 'number' ? value : Date.parse(String(value))
  if (!Number.isFinite(ms)) return String(value)
  return new Date(ms).toLocaleString()
}

export function remainPct(used: unknown): number {
  return Math.max(0, 100 - pct(used))
}

/**
 * 剩余时长 → 分钟精度倒计时：`3d4h12m` / `2h17m` / `45m` / `<1m`。
 * 秒级抖动无运营意义，统一向下取整到分钟。
 */
export function fmtCountdown(leftMs: number): string {
  const totalMin = Math.floor(Math.max(0, leftMs) / 60000)
  if (totalMin < 1) return '<1m'
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d > 0) return `${d}d${h}h${m}m`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

export function fmtMs(ms: unknown): string {
  if (ms == null || !Number.isFinite(Number(ms))) return '—'
  const n = Number(ms)
  if (n >= 10000) return `${(n / 1000).toFixed(1)}s`
  return `${Math.round(n)}ms`
}

export function fmtRate(n: unknown, digits?: number): string {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  if (v >= 100) return v.toFixed(0)
  if (v >= 10) return v.toFixed(1)
  if (v >= 1) return v.toFixed(2)
  return v.toFixed(digits ?? 3)
}

export function fmtBytes(n: unknown): string {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = v
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)}${units[i]}`
}
