import { describe, expect, it } from 'vitest'
import {
  egressLabel,
  isQuotaState,
  isTransientState,
  migrationReasonLabel,
  reasonCrossesEgress,
  slotStateClass,
  slotStateView,
} from './slot-state'

describe('slotStateView', () => {
  it('treats ready as usable', () => {
    const v = slotStateView('ready')
    expect(v.tone).toBe('ok')
    expect(v.migrates).toBe(false)
  })

  it('marks a spent window as moving the user', () => {
    const cli = slotStateView('quota_5h_cli')
    expect(cli.tone).toBe('warn')
    expect(cli.migrates).toBe(true)
    const safety = slotStateView('quota_7d_safety')
    expect(safety.migrates).toBe(true)
  })

  it('does not treat a busy slot as a migration', () => {
    const v = slotStateView('transient:concurrency_limit')
    expect(v.tone).toBe('busy')
    expect(v.migrates).toBe(false)
    expect(v.label).toContain('concurrency_limit')
  })

  it('marks a cooldown as a migration', () => {
    expect(slotStateView('cooldown')).toMatchObject({ tone: 'warn', migrates: true })
  })

  it('falls back to the raw string for unknown states', () => {
    const v = slotStateView('some_new_reason')
    expect(v.label).toBe('some_new_reason')
    expect(v.migrates).toBe(true)
  })

  it('handles missing state', () => {
    expect(slotStateView(null).tone).toBe('muted')
    expect(slotStateView('').label).toBe('未知')
  })
})

describe('state predicates', () => {
  it('recognises quota reasons but not concurrency', () => {
    expect(isQuotaState('quota_5h_cli')).toBe(true)
    expect(isQuotaState('account_quota_exhausted')).toBe(true)
    expect(isQuotaState('concurrency_limit')).toBe(false)
  })

  it('recognises the transient prefix', () => {
    expect(isTransientState('transient:session_limit')).toBe(true)
    expect(isTransientState('session_limit')).toBe(false)
  })
})

describe('tone classes', () => {
  it('maps every tone to a class the theme actually defines', () => {
    // These tokens exist in src/styles/theme.css; a typo here renders as
    // unstyled text rather than failing loudly, so assert the exact values.
    expect(slotStateClass('ok')).toBe('text-ok-3')
    expect(slotStateClass('warn')).toBe('text-warn-3')
    expect(slotStateClass('busy')).toBe('text-caution-3')
    expect(slotStateClass('bad')).toBe('text-destructive')
    expect(slotStateClass('muted')).toBe('text-muted-foreground')
  })
})

describe('labels', () => {
  it('explains that a failover changed the IP', () => {
    expect(migrationReasonLabel('egress_failover')).toContain('换 IP')
    expect(reasonCrossesEgress('egress_failover')).toBe(true)
    expect(reasonCrossesEgress('quota_exhausted')).toBe(false)
  })

  it('names the shared host egress', () => {
    expect(egressLabel({ egress_id: 'direct:203.0.113.9', egress_kind: 'direct' })).toBe(
      '本机共享 203.0.113.9'
    )
    expect(egressLabel({ egress_id: 'px-a3f1', egress_kind: 'proxy' })).toBe('px-a3f1')
  })
})
