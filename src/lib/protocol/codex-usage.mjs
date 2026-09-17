/**
 * Codex usage contract aligned with sub2api OpenAICodexUsageSnapshot.
 *
 * extra keys (direct used %, never inverted):
 *   codex_5h_used_percent / codex_7d_used_percent
 *   codex_primary_* (7d by default) / codex_secondary_* (5h by default)
 * Normalize() maps primary/secondary by window_minutes like sub2api.
 */

function num(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function int(value) {
  const n = num(value)
  return n == null ? null : Math.trunc(n)
}

export function extraToCodexSnapshot(extra = {}) {
  if (!extra || typeof extra !== 'object') return emptySnapshot()
  return {
    primary_used_percent: num(extra.codex_primary_used_percent ?? extra.codex_7d_used_percent),
    primary_reset_after_seconds: int(extra.codex_primary_reset_after_seconds ?? extra.codex_7d_reset_after_seconds),
    primary_window_minutes: int(extra.codex_primary_window_minutes ?? extra.codex_7d_window_minutes),
    primary_reset_at: extra.codex_primary_reset_at || extra.codex_7d_reset_at || null,
    secondary_used_percent: num(extra.codex_secondary_used_percent ?? extra.codex_5h_used_percent),
    secondary_reset_after_seconds: int(extra.codex_secondary_reset_after_seconds ?? extra.codex_5h_reset_after_seconds),
    secondary_window_minutes: int(extra.codex_secondary_window_minutes ?? extra.codex_5h_window_minutes),
    secondary_reset_at: extra.codex_secondary_reset_at || extra.codex_5h_reset_at || null,
    primary_over_secondary_percent: num(extra.codex_primary_over_secondary_percent),
    updated_at: extra.codex_usage_updated_at || extra.updated_at || null,
  }
}

function emptySnapshot() {
  return {
    primary_used_percent: null,
    primary_reset_after_seconds: null,
    primary_window_minutes: null,
    primary_reset_at: null,
    secondary_used_percent: null,
    secondary_reset_after_seconds: null,
    secondary_window_minutes: null,
    secondary_reset_at: null,
    primary_over_secondary_percent: null,
    updated_at: null,
  }
}

export function normalizeCodexLimits(snapshot = {}) {
  const primaryMins = num(snapshot.primary_window_minutes)
  const secondaryMins = num(snapshot.secondary_window_minutes)
  const hasPrimary = primaryMins != null
  const hasSecondary = secondaryMins != null
  let fiveFromPrimary = false
  let sevenFromPrimary = false
  if (hasPrimary && hasSecondary) {
    if (primaryMins < secondaryMins) fiveFromPrimary = true
    else sevenFromPrimary = true
  } else if (hasPrimary) {
    if (primaryMins <= 360) fiveFromPrimary = true
    else sevenFromPrimary = true
  } else if (hasSecondary) {
    if (secondaryMins <= 360) sevenFromPrimary = true
    else fiveFromPrimary = true
  } else {
    sevenFromPrimary = true
  }
  if (fiveFromPrimary) {
    return {
      used_5h_percent: snapshot.primary_used_percent,
      reset_5h_seconds: snapshot.primary_reset_after_seconds,
      window_5h_minutes: snapshot.primary_window_minutes ?? 300,
      reset_5h_at: snapshot.primary_reset_at,
      used_7d_percent: snapshot.secondary_used_percent,
      reset_7d_seconds: snapshot.secondary_reset_after_seconds,
      window_7d_minutes: snapshot.secondary_window_minutes ?? 10080,
      reset_7d_at: snapshot.secondary_reset_at,
    }
  }
  return {
    used_5h_percent: snapshot.secondary_used_percent,
    reset_5h_seconds: snapshot.secondary_reset_after_seconds,
    window_5h_minutes: snapshot.secondary_window_minutes ?? 300,
    reset_5h_at: snapshot.secondary_reset_at,
    used_7d_percent: snapshot.primary_used_percent,
    reset_7d_seconds: snapshot.primary_reset_after_seconds,
    window_7d_minutes: snapshot.primary_window_minutes ?? 10080,
    reset_7d_at: snapshot.primary_reset_at,
  }
}

function pctToRatio(percent) {
  if (percent == null) return null
  return Math.max(0, Math.min(1, Number(percent) / 100))
}

export function codexLimitsToQuota(limits = {}) {
  return {
    utilization_5h: pctToRatio(limits.used_5h_percent),
    utilization_7d: pctToRatio(limits.used_7d_percent),
    reset_5h: limits.reset_5h_at || null,
    reset_7d: limits.reset_7d_at || null,
    status_5h: statusFromPercent(limits.used_5h_percent),
    status_7d: statusFromPercent(limits.used_7d_percent),
  }
}

function statusFromPercent(percent) {
  if (percent == null) return null
  if (percent >= 100) return 'limited'
  if (percent >= 90) return 'warn'
  if (percent >= 75) return 'caution'
  return 'ok'
}

/**
 * 从三种输入里认出 snapshot：
 *   1. 标准 snapshot（primary/secondary_*）
 *   2. extra 映射（codex_5h_used_percent / codex_7d_used_percent …）
 *   3. 已经算好的 view（{ snapshot, limits, quota, windows }）
 *
 * 第 3 种必须显式支持：`summarizeCodexSlot` 会把落盘的 `codex.usage` 再喂回本
 * 函数。老实现只看顶层 `primary_used_percent`，于是把 view 当 extra 解析 ——
 * 每个字段都变成 null，表现就是"上游明明回了 62%，面板永远 0% / —"。
 */
function hasSnapshotKeys(value = {}) {
  if (!value || typeof value !== 'object') return false
  return [
    'primary_used_percent',
    'secondary_used_percent',
    'primary_window_minutes',
    'secondary_window_minutes',
    'primary_reset_at',
    'secondary_reset_at',
    'updated_at',
  ].some((key) => value[key] != null)
}

function snapshotOf(input = {}) {
  if (!input || typeof input !== 'object') return emptySnapshot()
  const nested = input.snapshot
  if (nested && typeof nested === 'object') {
    return hasSnapshotKeys(nested) ? { ...emptySnapshot(), ...nested } : extraToCodexSnapshot(nested)
  }
  if (hasSnapshotKeys(input)) return input
  return extraToCodexSnapshot(input)
}

export function buildCodexUsageView(extraOrSnapshot = {}) {
  const snapshot = snapshotOf(extraOrSnapshot)
  const limits = normalizeCodexLimits(snapshot)
  const quota = codexLimitsToQuota(limits)
  return {
    snapshot,
    limits,
    quota,
    unit: 'percent_used',
    windows: [
      {
        id: '5h',
        label: '5h',
        used_percent: limits.used_5h_percent,
        reset_at: limits.reset_5h_at,
        reset_after_seconds: limits.reset_5h_seconds,
        window_minutes: limits.window_5h_minutes,
      },
      {
        id: '7d',
        label: '7d',
        used_percent: limits.used_7d_percent,
        reset_at: limits.reset_7d_at,
        reset_after_seconds: limits.reset_7d_seconds,
        window_minutes: limits.window_7d_minutes,
      },
    ],
  }
}
