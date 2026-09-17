/**
 * Codex hop from handle-protocol. Claude convert/pool/CRS never runs here.
 */
import path from 'node:path'
import { getVm, listVms } from '../vm/vm-registry.mjs'
import { isCodexProtocolAllowed, isCodexVm, normalizeCodexRouting } from './codex-route.mjs'
import { restrictCodexClient } from './codex-restriction.mjs'
import { responsesSseToChatChunk, toCodexResponses } from './codex-convert.mjs'
import { streamCodexKernel } from '../transport/codex-kernel-client.mjs'
import { ensureCodexKernel, writeCodexKernelConfig } from '../transport/codex-kernel-supervisor.mjs'
import { codexBinPath, streamCodexCli } from '../transport/codex-cli-client.mjs'
import { materializeCodexHome } from '../vm/codex-home.mjs'
import { CODEX_BIN_IN_CONTAINER, codexContainerName, inspectCodexContainer } from '../vm/codex-runtime.mjs'
import { readCodexAccounts } from '../vm/codex-slot.mjs'
import { boundProxyUrl } from '../vm/egress.mjs'
import { pickLeastLoadedEgress, resolveUserDispatch, slotVerdict } from '../pool/egress-binding.mjs'
import { ownerScopeFromRequest } from '../admin/resource-owner.mjs'
import fs from 'node:fs'

function sessionFrom(req, body) {
  const headers = req.headers || {}
  return {
    session_id:
      headers['x-session-id'] ||
      headers['session-id'] ||
      headers['x-conversation-id'] ||
      body?.conversation_id ||
      body?.session_id ||
      null,
    previous_response_id: body?.previous_response_id || null,
  }
}

function pinnedVmId(req) {
  const pinVmRaw = String(req?.headers?.['x-kin-vm'] || '').trim()
  if (req?.apiKeyKind !== 'master') return null
  return /^vm-[a-z0-9-]+$/i.test(pinVmRaw) ? pinVmRaw : null
}

/**
 * 选一个 codex 槽。
 *
 * 以前这里是"列表里第一个 codex 槽"—— 一个槽挂了就全挂，也没有"用户落在哪个槽"的
 * 概念。现在复用 egress 那套：用户绑定 → 桶 → 负载，只是把凭证类型换成 codex。
 *
 * 两条硬规则：
 *   1. 只挑 codex 槽（闸门按 kind 分派），Claude 池与 Codex 池互不越界；
 *   2. 不允许回退到本机共享 IP —— 真 CLI 从宿主机直连等于换掉槽的身份。
 *
 * 绑定按 kind 存（028 迁移），所以 codex 的落点不会污染同一个用户的 Claude 出口。
 */
export function pickCodexVm(projectRoot, req, { gates = {}, ownerScope = null, vms = null } = {}) {
  const pin = pinnedVmId(req)
  if (pin) {
    const vm = getVm(projectRoot, pin)
    if (!vm || !isCodexVm(vm)) return { error: 'platform_mismatch', pin }
    return { vm, scope: 'pin' }
  }

  const all = Array.isArray(vms)
    ? vms
    : listVms(projectRoot)
        .map((summary) => getVm(projectRoot, summary.id))
        .filter(Boolean)
  const codexVms = all.filter((vm) => isCodexVm(vm))
  if (!codexVms.length) return { error: 'no_codex_vm' }

  const hasCodexCredential = (vm) => readCodexAccounts(projectRoot, vm.id).some((account) => account?.access_token)
  const scope = ownerScope || ownerScopeFromRequest(req, null)
  const userId = scope?.type === 'user' ? String(scope.userId || '').trim() : ''

  // 绑定层的问题（数据库没打开、绑定表坏了）不能把这一跳打死 —— Claude 侧对
  // userBinding 也是这个态度：降级到"全池挑一个能用的槽"，而不是让请求失败。
  const degraded = (error) => {
    const vm = firstUsableCodexSlot(codexVms, { gates, hasCodexCredential })
    if (!vm) {
      return {
        error: 'no_codex_slot',
        reason: codexSlotRejection(codexVms, { gates, hasCodexCredential }),
        // 绑定层为什么不可用也留下来，方便排查（不覆盖闸门原因）。
        binding_error: String(error?.message || error),
      }
    }
    return { vm, scope: 'degraded', binding_error: String(error?.message || error) }
  }

  if (!userId) {
    // 平台级调用（master key 且没 pin）：全池最空的 codex 槽。
    try {
      const picked = pickLeastLoadedEgress({ vms: codexVms, gates, kind: 'codex', hasCodexCredential })
      if (!picked.ok) {
        return { error: 'no_codex_slot', reason: codexSlotRejection(codexVms, { gates, hasCodexCredential }) }
      }
      return { vm: picked.slot.vm, egressId: picked.egressId, scope: 'platform' }
    } catch (error) {
      return degraded(error)
    }
  }

  let resolved = null
  try {
    resolved = resolveUserDispatch(
      {
        userId,
        vms: codexVms,
        loadVm: (id) => getVm(projectRoot, id),
        gates,
        kind: 'codex',
        hasCodexCredential,
        allowFailover: true,
        allowDirect: false,
        reason: 'credential_dead',
      },
      {},
    )
  } catch (error) {
    return degraded(error)
  }
  if (!resolved.ok) {
    return {
      error: 'no_codex_slot',
      reason:
        resolved.reason === 'no_slot_in_egress' || resolved.reason === 'no_egress_with_capacity'
          ? codexSlotRejection(codexVms, { gates, hasCodexCredential })
          : resolved.reason,
      transient: resolved.transient === true,
      userId,
      egressId: resolved.egressId || null,
    }
  }
  return {
    vm: resolved.vm,
    egressId: resolved.egressId,
    slotId: resolved.slotId,
    userId,
    scope: resolved.migrated ? 'user-migrated' : resolved.created || resolved.assigned ? 'user-assigned' : 'user',
  }
}

/** 槽容器在不在跑：在跑就把 CLI 放进容器执行。 */
export function codexSlotContainer(vm, { inspect = inspectCodexContainer } = {}) {
  const name = vm?.runtime?.container || codexContainerName(vm?.id)
  if (!name) return null
  try {
    const info = inspect(name)
    return info?.running ? name : null
  } catch {
    return null
  }
}

/** 不碰数据库的最小挑选：绑定层不可用时的兜底。 */
export function firstUsableCodexSlot(codexVms = [], { gates = {}, hasCodexCredential = null } = {}) {
  return (
    [...codexVms]
      .filter((vm) => slotVerdict(vm, gates, { kind: 'codex', hasCodexCredential }).ok)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] || null
  )
}

/** 兜底挑选失败时，把最相关的闸门原因报出来（没有槽 = no_codex_vm）。 */
export function codexSlotRejection(codexVms = [], { gates = {}, hasCodexCredential = null } = {}) {
  if (!codexVms.length) return 'no_codex_vm'
  const reasons = codexVms.map((vm) => slotVerdict(vm, gates, { kind: 'codex', hasCodexCredential }).reason)
  // 优先级：出口 > 凭证 > 其它。"槽还在跑但没绑代理"比"没凭证"更值得先说。
  for (const wanted of ['proxy_required', 'no_codex_credential', 'vm_unschedulable']) {
    if (reasons.includes(wanted)) return wanted
  }
  return reasons.find(Boolean) || 'no_codex_slot'
}

function execFor(projectRoot, vm) {
  return {
    vmId: vm.id,
    homeDir: path.join(projectRoot, 'vms', vm.id, 'cli-home'),
    vm,
  }
}

export function isRetryableCodexTransport(result) {
  if (!result || result.ok === true) return false
  if (result.committed === true) return false
  const code = String(result.body?.error?.code || result.error_code || '')
  const msg = String(result.body?.error?.message || result.error || '')
  const status = Number(result.status) || 0
  if (result.transportError === true) return true
  if (status === 0) return true
  if (status === 502 && /upstream_transport|worker_transport|transport/i.test(`${code} ${msg}`)) return true
  return /upstream_transport|worker_transport_error/i.test(code)
}

/**
 * 这一跳由谁执行：真 CLI 还是手写 HTTP 内核。
 *
 * `auto`（默认）= 机器上找得到 codex 可执行文件就用 CLI —— 因为"真 CLI"才是这个仓
 * 想要的形态（真 UA、真请求序列、真版本），手写内核只在没有二进制时兜底。
 * 显式配 `cli` / `http` 可以钉死，方便回滚。
 */
/** 二进制在不在：CLI 与 HTTP 兜底之间的唯一开关。 */
export function codexBinaryPresent(binPath) {
  const candidate = String(binPath || '').trim()
  if (!candidate) return false
  if (!candidate.includes('/')) return true // PATH 上的裸命令，交给 spawn 判断
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function codexEngineFor({ routing = {}, hasBin = null, env = process.env } = {}) {
  const configured = String(routing.engine || routing.hop || 'auto')
    .trim()
    .toLowerCase()
  // 显式配置（routing.json）优先；`auto` 视为"没钉死"，于是环境变量还能覆盖它 ——
  // e2e 要可重复就必须能强制某一条引擎，而不必改配置文件。
  if (configured === 'cli' || configured === 'http') return configured
  const fromEnv = String(env?.KIN_CODEX_ENGINE || '')
    .trim()
    .toLowerCase()
  if (fromEnv === 'cli' || fromEnv === 'http') return fromEnv
  return hasBin === false ? 'http' : 'cli'
}

/** 选槽里哪条账号给 CLI 用：优先有 access_token 的，其次第一条。 */
export function pickCodexAccount(accounts = []) {
  const list = Array.isArray(accounts) ? accounts.filter(Boolean) : []
  if (!list.length) return null
  return list.find((account) => String(account.access_token || account.accessToken || '').trim()) || list[0] || null
}

/** Idle SOCKS / first hop 502 is retryable only before any SSE byte is committed. */
export async function runCodexKernelHop({ hop, args = {}, onEvent } = {}) {
  let emitted = false
  const wrapped = async (line) => {
    emitted = true
    if (onEvent) await onEvent(line)
  }
  let result = await hop({ ...args, onEvent: wrapped })
  if (!result?.ok && !emitted && isRetryableCodexTransport(result)) {
    result = { ...(await hop({ ...args, onEvent: wrapped })), transport_retried: true }
  }
  return result
}

export async function handleCodexProtocol({
  req,
  res,
  protocol,
  ctx,
  inbound,
  logBag,
  stats,
  json,
  writeSSEHeaders,
  routing = {},
  projectRoot,
  ops = {},
}) {
  const codex = normalizeCodexRouting(routing.codex)
  const allowed = isCodexProtocolAllowed(protocol, { codex })
  if (!allowed.ok) {
    stats.errors++
    logBag.via = 'codex-kernel'
    logBag.error_code = allowed.code
    return json(res, 400, {
      error: {
        type: 'invalid_request_error',
        code: allowed.code,
        message: `protocol '${protocol}' is not allowed on the Codex hop`,
      },
    })
  }
  const restriction = restrictCodexClient(req.headers, ctx.body || inbound, { codex }, protocol)
  if (!restriction.ok) {
    stats.errors++
    logBag.via = 'codex-kernel'
    logBag.error_code = restriction.code
    return json(res, 403, {
      error: { type: 'permission_error', code: restriction.code, message: restriction.message },
    })
  }
  const converted = toCodexResponses(protocol, ctx.body, codex.convert)
  if (!converted.ok) {
    stats.errors++
    logBag.via = 'codex-kernel'
    logBag.error_code = converted.code
    return json(res, 400, {
      error: {
        type: 'invalid_request_error',
        code: converted.code,
        message: 'request could not be converted to Codex Responses',
      },
    })
  }
  const picked = pickCodexVm(projectRoot, req)
  if (picked.error === 'platform_mismatch') {
    stats.errors++
    logBag.via = 'codex-kernel'
    logBag.error_code = 'platform_mismatch'
    return json(res, 400, {
      error: {
        type: 'invalid_request_error',
        code: 'platform_mismatch',
        message: `vm '${picked.pin}' is not a GPT slot`,
      },
    })
  }
  const vm = picked.vm
  if (!vm) {
    // 分清"一个 codex 槽都没有"和"有槽但都不能用"：后者要把闸门的原因原样带出去
    // （proxy_required / no_codex_credential …），否则运维只能靠猜。
    const noneAtAll = picked.error === 'no_codex_vm'
    stats.errors++
    logBag.via = 'codex-kernel'
    logBag.error_code = noneAtAll ? 'no_codex_vm' : 'no_codex_slot'
    if (picked.reason) logBag.codex_slot_reason = picked.reason
    return json(res, 503, {
      error: {
        type: 'api_error',
        code: logBag.error_code,
        message: noneAtAll ? 'no Codex slot is configured' : `no usable Codex slot (${picked.reason || 'unknown'})`,
      },
    })
  }
  const proxyUrl = boundProxyUrl(vm.proxy)
  const binPath = codexBinPath({ projectRoot })
  const hasBin = codexBinaryPresent(binPath)
  const engine = codexEngineFor({ routing: codex, hasBin })
  logBag.via = engine === 'cli' ? 'codex-cli' : 'codex-kernel'
  logBag.vm_id = vm.id
  logBag.codex_engine = engine

  // CLI 形态下凭证/出口落在槽自己的 CODEX_HOME 里（一槽一份，互不串味）；这条链
  // 同样不允许"没绑代理就直连"—— 那会让槽从宿主机 IP 出去，等于把身份换了。
  let cliEnv = null
  let cliRunner = null
  if (engine === 'cli') {
    if (!proxyUrl) {
      stats.errors++
      logBag.error_code = 'proxy_required'
      return json(res, 503, {
        error: { type: 'api_error', code: 'proxy_required', message: 'Codex 槽未绑定代理，拒绝直连' },
      })
    }
    // 槽容器在跑就用容器内的 CLI（对照 Claude：推理在槽里）；否则退回宿主进程。
    // 这一步只决定"在哪跑"，凭证与出口两者一致 —— 都在槽自己的 CODEX_HOME 与代理里。
    const container = codexSlotContainer(vm)
    const prepared = materializeCodexHome({
      projectRoot,
      vm,
      account: pickCodexAccount(readCodexAccounts(projectRoot, vm.id)),
      proxyUrl,
    })
    if (!prepared.ok) {
      stats.errors++
      logBag.error_code = 'codex_cli_credential_missing'
      return json(res, 503, {
        error: {
          type: 'api_error',
          code: 'codex_cli_credential_missing',
          message: `Codex 槽没有可用的 CLI 凭证（${prepared.reason}）。导入 access_token 后重试。`,
        },
      })
    }
    // CLI 必须跑在槽容器里 —— 这是 codex 槽与 Claude 槽对齐的核心：推理在槽内，
    // hostname/device/文件系统都随槽走。容器没起来时**不静默降级到宿主**：那会让请求
    // 带着宿主的身份出去，而这正是容器化要消灭的东西。要临时用宿主执行（开发/兼容旧
    // 部署）必须显式开 routing.codex.allow_host_cli。
    if (container) {
      cliRunner = { container, bin: CODEX_BIN_IN_CONTAINER, docker: 'docker' }
    } else if (codex.allow_host_cli !== true) {
      stats.errors++
      logBag.error_code = 'codex_slot_not_running'
      return json(res, 503, {
        error: {
          type: 'api_error',
          code: 'codex_slot_not_running',
          message: `Codex 槽容器未运行（${vm.runtime?.container || codexContainerName(vm.id)}）。先启动槽，或显式开启 routing.codex.allow_host_cli 用宿主执行。`,
        },
      })
    }
    cliEnv = prepared.env
  } else {
    writeCodexKernelConfig(projectRoot, vm, { proxyUrl, proxyRequired: true })
    const ready = await ensureCodexKernel(execFor(projectRoot, vm))
    if (!ready?.ok) {
      stats.errors++
      logBag.error_code = 'codex_kernel_unavailable'
      return json(res, 503, {
        error: {
          type: 'api_error',
          code: 'codex_kernel_unavailable',
          message: `Codex kernel 未就绪（${ready?.reason || 'not_ready'}）。GPT 槽走独立 kernel，不是 wrap cli-hop。`,
        },
      })
    }
  }
  stats.requests++
  stats.by_route[protocol] = (stats.by_route[protocol] || 0) + 1

  const stream = inbound?.stream !== false && ctx.body?.stream !== false
  const session = sessionFrom(req, converted.body)
  const outboundBody = { ...converted.body, stream: true }
  const chunks = []
  // 两条引擎同签名（都按 SSE 行回调），所以下游的协议映射完全不用分叉。
  const hop =
    engine === 'cli'
      ? ops.streamCodexCli ||
        ((args) =>
          streamCodexCli({
            ...args,
            bin: cliRunner ? CODEX_BIN_IN_CONTAINER : binPath,
            codexHome: cliEnv?.CODEX_HOME || null,
            env: cliEnv || {},
            // 容器模式下 CODEX_HOME 是容器内路径，宿主侧的 env 不外传
            runner: cliRunner,
            resume: !!session?.previous_response_id,
            threadId: session?.previous_response_id || null,
          }))
      : ops.streamCodexKernel || streamCodexKernel
  const result = await runCodexKernelHop({
    hop,
    args: {
      exec: execFor(projectRoot, vm),
      body: outboundBody,
      reqHeaders: req.headers,
      envelope: { body: outboundBody, stream: true, session },
    },
    onEvent: async (line) => {
      if (!stream) {
        chunks.push(line)
        return
      }
      if (!res.headersSent) writeSSEHeaders(res)
      if (protocol === 'openai.chat' || protocol === 'openai.completions') {
        const mapped = responsesSseToChatChunk(line)
        if (mapped) res.write(mapped)
        return
      }
      res.write(line.endsWith('\n') ? `${line}\n` : `${line}\n`)
    },
  })
  if (result?.transport_retried) logBag.transport_retried = true
  if (!result?.ok) {
    stats.errors++
    logBag.error_code = result?.body?.error?.code || 'codex_upstream'
    logBag.upstream_status = result?.status || 0
    if (!res.headersSent) {
      return json(res, result?.status || 502, result?.body || { error: { type: 'api_error', code: 'codex_upstream' } })
    }
    return res.end()
  }
  if (result?.thread_id) logBag.codex_thread_id = result.thread_id
  const usage = result.usage || result.body?.usage || result.body?.response?.usage || null
  logBag.usage = usage
  logBag.input_tokens = usage?.input_tokens ?? usage?.prompt_tokens ?? null
  logBag.output_tokens = usage?.output_tokens ?? usage?.completion_tokens ?? null
  logBag.cache_read_tokens = usage?.input_tokens_details?.cached_tokens ?? usage?.cache_read_tokens ?? null
  logBag.first_token_ms = result.ttftMs ?? null
  logBag.final_state = result.terminalState || 'verified'
  logBag.upstream_model = converted.body.model
  if (!stream) {
    return json(res, 200, result.body)
  }
  if (!res.headersSent) writeSSEHeaders(res)
  return res.end()
}
