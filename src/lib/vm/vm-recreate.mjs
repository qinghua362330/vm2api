/**
 * Factory-reset a slot: keep the registry identity (id / name / kernel /
 * timezone / proxy / seed / concurrency), wipe guest home + credentials,
 * then the caller destroys the container and starts a new one.
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from './vm-file.mjs'
import { defaultSeedPolicy } from '../protocol/seed-policy.mjs'
import { writeSlotSeedFiles } from './slot-seed.mjs'
import { manualScheduleLevelOf } from '../pool/credential-weight.mjs'
import { isCodexVm, stampVmKind } from './vm-kind.mjs'
import { materializeWrapCli } from './wrap-cli-runtime.mjs'
import { listVms } from './vm-registry.mjs'
import {
  applyGeneratedFingerprint,
  generateWorkstationFingerprint,
  takenFingerprintKeys,
  writeGuestMachineIdFile,
} from '../identity/workstation-fingerprint.mjs'

export function wipeSlotHome(projectRoot, id) {
  if (!projectRoot || !id) return
  const home = path.join(projectRoot, 'vms', id)
  try {
    fs.rmSync(home, { recursive: true, force: true })
  } catch {}
  const chat = path.join(projectRoot, 'vms', `${id}-chat.json`)
  try {
    if (fs.existsSync(chat)) fs.unlinkSync(chat)
  } catch {}
}

export function seedFreshCliHome(projectRoot, vm) {
  const written = writeSlotSeedFiles(projectRoot, vm)
  try {
    materializeWrapCli(projectRoot, vm)
  } catch {}
  return { homeDir: written.homeDir, seed_policy: written.seed_policy || defaultSeedPolicy(vm.seed_policy || {}) }
}

/**
 * codex 槽的"落户"：与 `seedFreshCliHome` 平级，只是槽里是 codex 的世界。
 *
 * 只建一槽一份的 CODEX_HOME（凭证、会话、app-server 控制 socket 都住这儿），不写
 * `auth.json` —— 那要等凭证导入或槽启动时由宿主写（`ensureCodexSlotHome`），跟 Claude
 * 侧"先建空 home、再导凭证"是同一个顺序。配置也不预写：CLI 有 `--strict-config`，
 * 猜 TOML 键会把一个能跑的槽变成起不来的槽。
 */
export function seedCodexSlotHome(projectRoot, vm) {
  const id = String(vm?.id || '').trim()
  if (!projectRoot || !id) return { ok: false, reason: 'project_and_vm_required' }
  const home = path.join(projectRoot, 'vms', id, 'codex-home')
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  return { ok: true, homeDir: home }
}

/** 按槽的类型落户：Claude 走 cli-home，codex 走 codex-home。 */
export function seedSlotHome(projectRoot, vm) {
  return isCodexVm(vm) ? seedCodexSlotHome(projectRoot, vm) : seedFreshCliHome(projectRoot, vm)
}

export function buildRecreatedVmRecord(prev, generated) {
  const pack = generated?.device_id ? generated : generateWorkstationFingerprint(prev)
  const now = pack.reset_at || new Date().toISOString()
  const policy = prev?.policy && typeof prev.policy === 'object' ? prev.policy : {}
  const maxConcurrency = Number.isFinite(Number(policy.maxConcurrency))
    ? Math.max(0, Math.min(128, Number(policy.maxConcurrency)))
    : 20
  const maxRpm = Number.isFinite(Number(policy.maxRpm)) ? Math.max(0, Math.min(1e6, Number(policy.maxRpm))) : 0
  const rpmOverride = policy.rpmOverride === true
  const weight = Number.isFinite(Number(policy.weight)) ? Math.max(1, Math.min(100, Number(policy.weight))) : 1
  const priority = manualScheduleLevelOf(prev)
  const allowed = Array.isArray(policy.allowed_models)
    ? [...new Set(policy.allowed_models.map((id) => String(id || '').trim()).filter(Boolean))]
    : []
  const timezone = prev.timezone || pack.timezone
  const locale = prev.locale || pack.locale
  const next = {
    id: prev.id,
    name: prev.name,
    status: 'stopped',
    kernel: prev.kernel || 'ubuntu-24.04',
    timezone,
    locale,
    region: prev.region || null,
    note: prev.note || null,
    proxy: prev.proxy || null,
    policy: {
      maxConcurrency,
      maxRpm,
      ...(rpmOverride ? { rpmOverride: true } : {}),
      weight,
      ...(priority == null ? {} : { priority }),
      inflight: 0,
      ...(allowed.length ? { allowed_models: allowed } : {}),
    },
    claude: {},
    fingerprint: applyGeneratedFingerprint({}, { ...pack, timezone, locale, reset_at: now }),
    stats: {},
    created_at: prev.created_at || now,
    updated_at: now,
    schedulable: false,
    schedule_disabled_reason: 'no_credential',
    proxy_cli_enabled: prev.proxy_cli_enabled !== false,
    seed_policy: defaultSeedPolicy(prev.seed_policy || {}),
    runtime: { type: prev.runtime?.type === 'kvm' ? 'kvm' : 'docker' },
    proxy_required: prev.proxy_required,
    ...(prev.inference_engine ? { inference_engine: prev.inference_engine } : {}),
    ...(prev.persona_preset ? { persona_preset: prev.persona_preset } : {}),
  }
  stampVmKind(next, prev)
  return next
}

/**
 * 重建槽的文件。codex 槽同一套语义：清空槽目录 → 重生成指纹 → 重新落户。
 * codex 的凭证不在槽 home 里（`vms/<id>/codex-credentials.json` 在 home 之外，
 * `wipeSlotHome` 删的是 `vms/<id>/` 整个目录 —— 所以凭证需要调用方在重建后重新导入，
 * 与 Claude 的 cli-home 被清掉后要重导凭证完全一致）。
 */
export function recreateVmFiles(projectRoot, prev) {
  if (!projectRoot || !prev?.id) throw new Error('projectRoot and vm id required')
  wipeSlotHome(projectRoot, prev.id)
  const generated = generateWorkstationFingerprint(prev, {
    taken: takenFingerprintKeys(listVms(projectRoot), { exceptId: prev.id }),
  })
  const vm = buildRecreatedVmRecord(prev, generated)
  const vmPath = path.join(projectRoot, 'vms', `${prev.id}.json`)
  atomicWriteJson(vmPath, vm, { mode: 0o600 })
  writeGuestMachineIdFile(projectRoot, vm.id, vm.fingerprint.guest_machine_id)
  seedSlotHome(projectRoot, vm)
  return { vm, vmPath }
}
