/**
 * Slot data-plane engine + unofficial persona override.
 *
 * inference_engine: 公开仓只认 `rust` = cli-hop（kernel → Claude Code）。
 * 历史 `go` / worker 取值一律收成 rust，不再启用 Go HTTP 转发。
 * rust 下 official_cc inference 强制 cli-hop。
 * Setup Token 换票走 sessionKey/PKCE 脚本，不启 claude setup-token PTY；
 * 推理仍跟槽位 engine：配 rust 就 cli-hop。
 * persona_preset official|official_full|zero on a VM overrides the global protocol;
 * empty inherits routing.compatibility.persona_preset.
 */
import { normalizePersonaPreset, personaPresetFromLegacyMode } from '../identity/persona-template.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { isCrsMock } from '../transport/crs-mock.mjs'

export const INFERENCE_ENGINES = Object.freeze(['rust'])
export const SLOT_PERSONA_PRESETS = Object.freeze(['official', 'official_full', 'zero'])
export const OFFICIAL_CC_INFERENCES = Object.freeze(['http', 'cli-hop'])

export function normalizeInferenceEngine(value, { inherit = false } = {}) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!raw) return inherit ? '' : 'rust'
  if (
    raw === 'rust' ||
    raw === 'kernel' ||
    raw === 'kin-kernel' ||
    raw === 'go' ||
    raw === 'worker' ||
    raw === 'go-worker'
  ) {
    return 'rust'
  }
  return inherit ? '' : 'rust'
}

export function normalizeSlotPersonaPreset(value, { inherit = false } = {}) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!raw || raw === 'inherit' || raw === 'global' || raw === 'default') {
    return inherit ? '' : null
  }
  if (raw === 'official_full' || raw === 'full' || raw === 'agent_official') return 'official_full'
  if (
    raw === 'official' ||
    raw === 'official_prompt' ||
    raw === 'prompt' ||
    raw === 'agent_prompt' ||
    raw === 'cc_prompt'
  )
    return 'official'
  if (raw === 'zero' || raw === 'zero_inject' || raw === '0inject' || raw === '0-inject') return 'zero'
  return inherit ? '' : null
}

function optionalBool(value, fallback) {
  if (value == null || value === '') return fallback
  return value === true
}

function optionalTtlMs(value, fallback = 2000) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

export function normalizeInferenceConfig(raw = {}) {
  return {
    engine: normalizeInferenceEngine(raw.engine),
    fallback_to_go: false,
    strict: raw.strict === true,
    eager_start: optionalBool(raw.eager_start, true),
    health_ttl_ms: optionalTtlMs(raw.health_ttl_ms, 2000),
    tcp_nodelay: optionalBool(raw.tcp_nodelay, true),
  }
}

export function resolveInferenceEngine(vm, routing = {}) {
  if (isCodexVm(vm)) return null
  const fromVm = normalizeInferenceEngine(vm?.inference_engine, { inherit: true })
  if (fromVm) return fromVm
  return normalizeInferenceEngine(routing?.inference?.engine)
}

export function normalizeOfficialCcInference(value, { inherit = false } = {}) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('_', '-')
  if (!raw || raw === 'inherit' || raw === 'global' || raw === 'default') {
    return inherit ? '' : 'http'
  }
  if (raw === 'http' || raw === 'hop' || raw === 'anthropic-api' || raw === 'anthropic_api') return 'http'
  if (raw === 'cli-hop' || raw === 'clihop' || raw === 'local-cli' || raw === 'local_cli') return 'cli-hop'
  return inherit ? '' : 'http'
}

export function resolveOfficialCcInference(vm, routing = {}) {
  if (isCodexVm(vm)) return null
  // The e2e harness (KIN_CRS_MOCK=1) serves inference from the in-process
  // Anthropic stub on the Node HTTP path, and that is where persona, identity
  // and metadata are assembled. Under engine=rust those move into the wrapped
  // Claude Code, which the public snapshot does not ship — so a mock run that
  // claimed cli-hop would exercise nothing the harness asserts. Test-only.
  if (isCrsMock()) {
    const fromVmMock = normalizeOfficialCcInference(vm?.official_cc_inference, { inherit: true })
    if (fromVmMock && fromVmMock !== 'cli-hop') return fromVmMock
    const fromRoutingMock = normalizeOfficialCcInference(routing?.official_cc?.inference)
    return fromRoutingMock === 'cli-hop' ? 'http' : fromRoutingMock
  }
  if (resolveInferenceEngine(vm, routing) === 'rust') return 'cli-hop'
  const fromVm = normalizeOfficialCcInference(vm?.official_cc_inference, { inherit: true })
  if (fromVm) return fromVm
  return normalizeOfficialCcInference(routing?.official_cc?.inference)
}

export function assertCliHopAllowed(vm, routing = {}) {
  if (resolveOfficialCcInference(vm, routing) !== 'cli-hop') return { ok: true }
  if (resolveInferenceEngine(vm, routing) !== 'rust') {
    return { ok: false, error: 'official_cc.inference=cli-hop requires inference.engine=rust' }
  }
  return { ok: true }
}

export function parseOfficialCcInferencePatch(value) {
  if (value == null) return { ok: true, value: '' }
  const raw = String(value).trim().toLowerCase().replaceAll('_', '-')
  if (!raw || raw === 'inherit' || raw === 'global' || raw === 'default') {
    return { ok: true, value: '' }
  }
  if (raw === 'http' || raw === 'cli-hop') return { ok: true, value: raw }
  return { ok: false, error: 'official_cc.inference must be http, cli-hop, or empty' }
}

export function resolveSlotPersonaPreset(vm, routing = {}) {
  const fromVm = normalizeSlotPersonaPreset(vm?.persona_preset, { inherit: true })
  if (fromVm) return fromVm
  const compat = routing?.compatibility || {}
  if (compat.persona_preset != null && String(compat.persona_preset).trim() !== '') {
    return normalizePersonaPreset(compat.persona_preset)
  }
  return personaPresetFromLegacyMode(compat.persona_inject)
}

export function personaModeFromPreset(preset) {
  if (preset === 'zero') return 'zero'
  if (preset === 'official') return 'official_prompt'
  if (preset === 'official_full') return 'official_full'
  return null
}

/** Wrap CLI layout. ccmax (no persona_inject) stays zero; fkcodex rewrite → identity. */
export function resolveCliSystemLayout(vm, routing = {}) {
  const slot = normalizeSlotPersonaPreset(vm?.persona_preset, { inherit: true })
  if (slot === 'zero') return 'zero'
  const inject = String(routing?.compatibility?.persona_inject ?? '')
    .trim()
    .toLowerCase()
  if (!inject || inject === 'none' || inject === 'off' || inject === 'false' || inject === 'zero') return 'zero'
  return 'identity'
}

/** Explicit hop mode when the VM overrides global protocol. Null = inherit. */
export function slotPersonaModeOverride(vm) {
  return personaModeFromPreset(normalizeSlotPersonaPreset(vm?.persona_preset, { inherit: true }))
}

export function parseInferenceEnginePatch(value) {
  if (value == null) return { ok: true, value: '' }
  const raw = String(value).trim().toLowerCase()
  if (!raw || raw === 'inherit' || raw === 'global' || raw === 'default') {
    return { ok: true, value: '' }
  }
  if (
    raw === 'rust' ||
    raw === 'go' ||
    raw === 'worker' ||
    raw === 'go-worker' ||
    raw === 'kernel' ||
    raw === 'kin-kernel'
  ) {
    return { ok: true, value: 'rust' }
  }
  return { ok: false, error: 'inference_engine must be rust or empty' }
}

export function parseSlotPersonaPresetPatch(value) {
  if (value == null) return { ok: true, value: '' }
  const raw = String(value).trim().toLowerCase()
  if (!raw || raw === 'inherit' || raw === 'global' || raw === 'default') {
    return { ok: true, value: '' }
  }
  if (raw === 'official_full' || raw === 'full' || raw === 'agent_official') {
    return { ok: true, value: 'official_full' }
  }
  if (
    raw === 'official' ||
    raw === 'official_prompt' ||
    raw === 'prompt' ||
    raw === 'agent_prompt' ||
    raw === 'cc_prompt'
  )
    return { ok: true, value: 'official' }
  if (raw === 'zero' || raw === 'zero_inject' || raw === '0inject' || raw === '0-inject') {
    return { ok: true, value: 'zero' }
  }
  return { ok: false, error: 'persona_preset must be official, official_full, zero, or empty' }
}

export function parseSlotEnginePolicyPatch(body = {}) {
  const hasEngine = Object.prototype.hasOwnProperty.call(body, 'inference_engine')
  const hasPersona = Object.prototype.hasOwnProperty.call(body, 'persona_preset')
  if (!hasEngine && !hasPersona) {
    return { ok: false, error: 'inference_engine or persona_preset required' }
  }
  const patch = {}
  if (hasEngine) {
    const parsed = parseInferenceEnginePatch(body.inference_engine)
    if (!parsed.ok) return parsed
    patch.inference_engine = parsed.value
  }
  if (hasPersona) {
    const parsed = parseSlotPersonaPresetPatch(body.persona_preset)
    if (!parsed.ok) return parsed
    patch.persona_preset = parsed.value
  }
  return { ok: true, patch }
}

export function parseSlotPolicyTargets(body = {}) {
  if (body.all === true) return { ok: true, all: true, ids: [] }
  if (!Array.isArray(body.ids)) {
    return { ok: false, error: 'ids or all required' }
  }
  const ids = [...new Set(body.ids.map((id) => String(id || '').trim()).filter(Boolean))]
  if (!ids.length) return { ok: false, error: 'ids required' }
  return { ok: true, all: false, ids }
}

export function validateInferenceRoutingPatch(body = {}) {
  if (!body || typeof body !== 'object' || body.inference == null) return []
  if (typeof body.inference !== 'object' || Array.isArray(body.inference)) {
    return ['inference 必须是对象']
  }
  const errors = []
  if (Object.prototype.hasOwnProperty.call(body.inference, 'engine')) {
    const parsed = parseInferenceEnginePatch(body.inference.engine)
    if (!parsed.ok) errors.push(parsed.error)
    else if (!parsed.value) errors.push('inference.engine 必须是 rust')
  }
  if (
    Object.prototype.hasOwnProperty.call(body.inference, 'fallback_to_go') &&
    typeof body.inference.fallback_to_go !== 'boolean'
  ) {
    errors.push('inference.fallback_to_go 必须是布尔值')
  }
  if (Object.prototype.hasOwnProperty.call(body.inference, 'strict') && typeof body.inference.strict !== 'boolean') {
    errors.push('inference.strict 必须是布尔值')
  }
  if (
    Object.prototype.hasOwnProperty.call(body.inference, 'eager_start') &&
    typeof body.inference.eager_start !== 'boolean'
  ) {
    errors.push('inference.eager_start 必须是布尔值')
  }
  if (
    Object.prototype.hasOwnProperty.call(body.inference, 'tcp_nodelay') &&
    typeof body.inference.tcp_nodelay !== 'boolean'
  ) {
    errors.push('inference.tcp_nodelay 必须是布尔值')
  }
  if (Object.prototype.hasOwnProperty.call(body.inference, 'health_ttl_ms')) {
    const n = Number(body.inference.health_ttl_ms)
    if (!Number.isFinite(n) || n < 0) errors.push('inference.health_ttl_ms 必须是 >= 0 的数字')
  }
  return errors
}
