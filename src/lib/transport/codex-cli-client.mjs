/**
 * 真 Codex CLI 驱动。
 *
 * 取代 `crates/codex-kernel` 里手写 HTTP 冒充 `codex_cli_rs/0.153.4` 的做法：这里
 * 直接跑官方 CLI（`codex exec --json`），把它 stdout 的 JSONL 事件翻译成网关一直在
 * 用的 Responses SSE 序列，所以 `handle-codex.mjs` 的流式契约不用改。
 *
 * CLI 的事件词汇（0.154.0 二进制里读出来的）：
 *   thread.started / turn.started / turn.completed / turn.failed
 *   item.started / item.updated / item.completed   （item.type: agent_message /
 *   reasoning / command_execution / file_change / mcp_tool_call / web_search /
 *   todo_list / error …）
 *   turn.completed.usage: input_tokens / cached_input_tokens /
 *   cache_write_input_tokens / output_tokens / reasoning_output_tokens
 *
 * 两个容易踩的点：
 *   1. `item.updated` 给的是**累计文本**，不是增量 —— 直接当 delta 发会把整段重复 N 遍；
 *   2. `agent_message` 之外还有 `item.completed{type:error}` 这种非致命提示（例如
 *      "Skill descriptions were shortened…"），把它当请求失败就错了。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'

/** 网关内部的 Responses SSE 事件名，与 convert.mjs 的 Claude→Responses 路径保持一致。 */
export const RESPONSES_EVENT_NAMES = Object.freeze([
  'response.created',
  'response.in_progress',
  'response.output_item.added',
  'response.content_part.added',
  'response.output_text.delta',
  'response.output_text.done',
  'response.content_part.done',
  'response.output_item.done',
  'response.completed',
  'response.failed',
  'response.incomplete',
])

export function codexBinPath({ env = process.env, projectRoot = null } = {}) {
  const explicit = String(env.KIN_CODEX_BIN || '').trim()
  if (explicit) return explicit
  if (projectRoot) {
    const local = path.join(projectRoot, 'bin', 'codex')
    return local
  }
  return 'codex'
}

/** 一行 JSONL → 事件对象；空行/非 JSON/无 type 一律返回 null（stdout 上会有杂音）。 */
export function parseCodexJsonlLine(line) {
  const text = String(line || '').trim()
  if (!text || text[0] !== '{') return null
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  if (!parsed.type) return null
  return parsed
}

/**
 * 累计文本 → 增量。
 *
 * CLI 的 `item.updated` 带的是到目前为止的完整文本；HTTP 客户端那边断线重连后也可能
 * 重发整段。三种情况都要处理：正常追加、服务端回退（重发同一段）、以及内容被替换
 * （不是前缀关系）—— 最后一种只能把整段当新内容发出去。
 */
export function deltaFromCumulative(cumulative, previous) {
  const next = String(cumulative ?? '')
  const prev = String(previous ?? '')
  if (!next) return ''
  if (!prev) return next
  if (next.startsWith(prev)) return next.slice(prev.length)
  if (prev.startsWith(next)) return ''
  return next
}

export function newCodexStreamState({ id, model, itemId = null } = {}) {
  return {
    id: id || `resp_${Math.random().toString(36).slice(2, 12)}`,
    model: model || null,
    itemId: itemId || `msg_${Math.random().toString(36).slice(2, 10)}`,
    threadId: null,
    outputIndex: 0,
    contentIndex: 0,
    text: '',
    started: false,
    messageOpen: false,
    usage: null,
    failed: false,
    error: null,
    toolItems: 0,
  }
}

function sseEvent(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...payload })}\n\n`
}

/** 翻译一批事件，返回要写给客户端的 SSE 行（已含 `event:`/`data:` 与空行）。 */
export function codexEventsToSse(events, state) {
  const out = []
  const push = (name, payload) => out.push(sseEvent(name, payload))
  const ensureCreated = () => {
    if (state.started) return
    state.started = true
    push('response.created', {
      response: { id: state.id, object: 'response', model: state.model, status: 'in_progress' },
    })
    push('response.in_progress', { response: { id: state.id, status: 'in_progress' } })
  }
  const openMessage = () => {
    if (state.messageOpen) return
    state.messageOpen = true
    push('response.output_item.added', {
      output_index: state.outputIndex,
      item: { type: 'message', id: state.itemId, role: 'assistant', content: [], status: 'in_progress' },
    })
    push('response.content_part.added', {
      output_index: state.outputIndex,
      content_index: state.contentIndex,
      part: { type: 'output_text', text: '' },
    })
  }
  const closeMessage = () => {
    if (!state.messageOpen) return
    state.messageOpen = false
    push('response.output_text.done', {
      output_index: state.outputIndex,
      content_index: state.contentIndex,
      text: state.text,
    })
    push('response.content_part.done', {
      output_index: state.outputIndex,
      content_index: state.contentIndex,
      part: { type: 'output_text', text: state.text },
    })
    push('response.output_item.done', {
      output_index: state.outputIndex,
      item: {
        type: 'message',
        id: state.itemId,
        role: 'assistant',
        content: [{ type: 'output_text', text: state.text }],
        status: 'completed',
      },
    })
  }

  for (const event of events) {
    const type = String(event?.type || '')
    if (type === 'thread.started') {
      // 会话续接的把手：下一次请求用 `codex exec resume <thread_id>`。
      state.threadId = String(event.thread_id || event.threadId || '') || null
      continue
    }
    if (type === 'turn.started') {
      ensureCreated()
      continue
    }
    if (type === 'item.started') {
      const kind = String(event.item?.type || '')
      if (kind === 'agent_message') ensureCreated()
      continue
    }
    if (type === 'item.updated' || type === 'item.completed') {
      const item = event.item || {}
      const kind = String(item.type || '')
      if (kind === 'agent_message') {
        ensureCreated()
        openMessage()
        const nextText = String(item.text ?? item.message ?? '')
        const delta = deltaFromCumulative(nextText, state.text)
        if (delta) {
          state.text = nextText
          push('response.output_text.delta', {
            output_index: state.outputIndex,
            content_index: state.contentIndex,
            delta,
          })
        } else if (nextText.length >= state.text.length) {
          state.text = nextText
        }
        if (type === 'item.completed') closeMessage()
        continue
      }
      if (kind === 'reasoning') {
        // 推理摘要不进客户端的正文；保留 token 计数即可。
        continue
      }
      if (kind === 'error') {
        // 非致命提示（skills 预算、沙箱警告…）。真正的失败走 turn.failed / error 事件。
        continue
      }
      if (kind) {
        // 工具类 item：作为 function_call 输出项透出，浏览器/客户端可以自己决定要不要展示。
        if (type === 'item.started') {
          ensureCreated()
          state.toolItems += 1
          push('response.output_item.added', {
            output_index: state.outputIndex + state.toolItems,
            item: {
              type: 'function_call',
              id: String(item.id || `tool_${state.toolItems}`),
              name: kind,
              status: 'in_progress',
            },
          })
        } else if (type === 'item.completed') {
          push('response.output_item.done', {
            output_index: state.outputIndex + state.toolItems,
            item: {
              type: 'function_call',
              id: String(item.id || `tool_${state.toolItems}`),
              name: kind,
              status: String(item.status || 'completed'),
            },
          })
        }
        continue
      }
      continue
    }
    if (type === 'turn.completed') {
      ensureCreated()
      closeMessage()
      const usage = event.usage && typeof event.usage === 'object' ? event.usage : null
      if (usage) {
        state.usage = {
          input_tokens: Number(usage.input_tokens) || 0,
          output_tokens: Number(usage.output_tokens) || 0,
          input_tokens_details: {
            cached_tokens: Number(usage.cached_input_tokens) || 0,
            cache_write_tokens: Number(usage.cache_write_input_tokens) || 0,
          },
          output_tokens_details: { reasoning_tokens: Number(usage.reasoning_output_tokens) || 0 },
        }
      }
      push('response.completed', {
        response: {
          id: state.id,
          object: 'response',
          model: state.model,
          status: 'completed',
          output: [
            {
              type: 'message',
              id: state.itemId,
              role: 'assistant',
              content: [{ type: 'output_text', text: state.text }],
            },
          ],
          output_text: state.text,
          usage: state.usage || undefined,
        },
      })
      continue
    }
    if (type === 'turn.failed' || type === 'error') {
      // CLI 一次失败会同时给 `error` 和 `turn.failed`：只发一次 response.failed，
      // 否则客户端收到两个失败事件（实测流里就是两条一样的帧）。
      if (state.failed) {
        state.error = state.error || String(event.message || event.error?.message || 'codex turn failed')
        continue
      }
      ensureCreated()
      closeMessage()
      state.failed = true
      state.error = String(event.message || event.error?.message || 'codex turn failed')
      push('response.failed', {
        response: {
          id: state.id,
          object: 'response',
          model: state.model,
          status: 'failed',
          error: { code: 'codex_cli_failed', message: state.error },
        },
      })
      continue
    }
  }
  return out
}

/**
 * `codex exec` 的参数。
 *
 * `--ephemeral` 默认开：网关是无状态的，槽里的会话文件只会随时间堆积；要续接会话时
 * 由调用方显式关掉并给 thread id。`--skip-git-repo-check` 必须有 —— 槽的 home 目录
 * 不是 git 仓库。stdin 一定要关（否则 CLI 会等 stdin，表现为"卡住"）。
 */
export function codexExecArgs({
  prompt = '',
  model = null,
  threadId = null,
  resume = false,
  ephemeral = true,
  sandbox = null,
  cd = null,
} = {}) {
  const args = ['exec']
  if (resume && threadId) args.push('resume', String(threadId))
  args.push('--json', '--skip-git-repo-check')
  if (ephemeral) args.push('--ephemeral')
  if (model) args.push('-m', String(model))
  if (sandbox) args.push('-s', String(sandbox))
  if (cd) args.push('-C', String(cd))
  args.push('-')
  return args
}

/** Responses 请求体 → 单轮提示词。多轮历史由 `resume <thread_id>` 承担。 */
export function promptFromResponsesBody(body = {}) {
  const parts = []
  const instructions = String(body.instructions || '').trim()
  if (instructions) parts.push(instructions)
  const input = Array.isArray(body.input) ? body.input : []
  for (const item of input) {
    const role = String(item?.role || item?.type || 'user')
    const content = item?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content
        .map((part) => (typeof part === 'string' ? part : part?.text || ''))
        .filter(Boolean)
        .join('\n')
    } else if (typeof item?.text === 'string') {
      text = item.text
    }
    if (!text.trim()) continue
    parts.push(role === 'assistant' || role === 'system' || role === 'developer' ? `[${role}]\n${text}` : text)
  }
  return parts.join('\n\n').trim()
}

/**
 * 跑一次 CLI，按 SSE 行回调。
 *
 * 与 `streamCodexKernel` 同签名，可以直接替换：返回 `{ok, status, body, usage, ttftMs,
 * via, thread_id}`，事件通过 `onEvent(line)` 逐行给出（已格式化好的 SSE）。
 */
export async function streamCodexCli({
  exec = {},
  body = {},
  codexHome = null,
  bin = null,
  env = {},
  model = null,
  prompt = null,
  resume = false,
  threadId = null,
  ephemeral = true,
  sandbox = null,
  timeoutMs = 600000,
  signal = null,
  onEvent = null,
  spawnImpl = spawn,
  now = () => Date.now(),
  /**
   * 在哪个环境里执行 CLI。
   *   省略            → 宿主进程
   *   { container }   → `docker exec -i <container> <bin> …`（对照 Claude 的槽内执行）
   */
  runner = null,
} = {}) {
  const startedAt = now()
  const binPath = bin || codexBinPath({ projectRoot: exec?.projectRoot })
  const home = codexHome || exec?.codexHome || null
  const childEnv = {
    ...process.env,
    ...env,
    ...(home ? { CODEX_HOME: home } : {}),
    // 槽里的 CLI 不需要交互，任何提示都应视为错误而不是等待。
    CI: '1',
  }
  const promptText = prompt == null ? promptFromResponsesBody(body) : String(prompt)
  const args = codexExecArgs({
    prompt: promptText,
    model: model || body.model || null,
    threadId,
    resume,
    ephemeral,
    sandbox,
  })

  // 在哪跑 CLI：宿主进程，或 exec 进槽容器。对照 Claude 的做法 —— 推理在槽里跑，
  // 槽外的宿主只负责搬运。容器模式下 env 由容器自己持有（CODEX_HOME 已挂载），
  // 包装进程只需要 docker 本身的环境。
  const inContainer = !!runner?.container
  const command = inContainer ? runner.docker || 'docker' : binPath
  const commandArgs = inContainer ? ['exec', '-i', runner.container, runner.bin || binPath, ...args] : args
  const commandEnv = inContainer ? { ...process.env } : childEnv

  const state = newCodexStreamState({ model: model || body.model || null })
  let stderr = ''
  let buffer = ''
  let ttftMs = null
  const emit = async (events) => {
    const lines = codexEventsToSse(events, state)
    if (!lines.length) return
    if (ttftMs == null) ttftMs = now() - startedAt
    if (onEvent) for (const line of lines) await onEvent(line)
  }

  const result = await new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child = null
    try {
      child = spawnImpl(command, commandArgs, {
        env: commandEnv,
        // stdin 必须是管道：`codex exec … -` 是"从 stdin 读提示词"（长对话塞 argv 会
        // 撞参数上限），所以提示词要写进去再关掉。用 'ignore' 会让 CLI 直接报
        // "No prompt provided via stdin." —— 线上就是这么撞出来的。
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: exec?.cwd || undefined,
      })
      try {
        child.stdin?.end?.(promptText)
      } catch {}
    } catch (error) {
      finish({
        ok: false,
        status: 502,
        body: {
          error: { type: 'api_error', code: 'codex_cli_spawn_failed', message: String(error?.message || error) },
        },
      })
      return
    }
    const timer = setTimeout(
      () => {
        try {
          child.kill('SIGKILL')
        } catch {}
        finish({
          ok: false,
          status: 504,
          body: {
            error: {
              type: 'api_error',
              code: 'codex_cli_timeout',
              message: `codex exec exceeded ${timeoutMs}ms`,
              stderr: stderr.slice(-2000),
            },
          },
        })
      },
      Math.max(1000, Number(timeoutMs) || 600000),
    )
    const onAbort = () => {
      try {
        child.kill('SIGKILL')
      } catch {}
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener?.('abort', onAbort, { once: true })
    }

    const pump = async () => {
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      const events = []
      for (const line of lines) {
        const event = parseCodexJsonlLine(line)
        if (event) events.push(event)
      }
      if (events.length) await emit(events)
    }

    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk)
      // 事件必须在同一次 tick 内按顺序处理，否则两个 chunk 之间的事件会乱序。
      pump().catch(() => {})
    })
    child.stderr?.setEncoding?.('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 20000) stderr = stderr.slice(-20000)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({
        ok: false,
        status: 502,
        body: {
          error: { type: 'api_error', code: 'codex_cli_spawn_failed', message: String(error?.message || error) },
        },
      })
    })
    child.on('close', async (code) => {
      clearTimeout(timer)
      try {
        const tail = parseCodexJsonlLine(buffer)
        buffer = ''
        if (tail) await emit([tail])
      } catch {}
      finish({ code: Number(code) || 0 })
    })
  })

  if (result && typeof result.code === 'number') {
    const ok = result.code === 0 && !state.failed
    return {
      ok,
      status: ok ? 200 : 502,
      // 只有失败且一个字都没发出去时，调用方才能安全地改写成 JSON 错误。
      body: ok
        ? { response: { id: state.id, output_text: state.text } }
        : {
            error: {
              type: 'api_error',
              code: 'codex_cli_failed',
              message: state.error || stderr.trim().slice(-500) || 'codex exec failed',
              exit_code: result.code,
            },
          },
      usage: state.usage,
      ttftMs,
      via: 'codex-cli',
      thread_id: state.threadId,
      emitted: ttftMs != null,
      text: state.text,
    }
  }
  return {
    ...result,
    via: 'codex-cli',
    ttftMs,
    thread_id: state.threadId,
    usage: state.usage,
    text: state.text,
    emitted: ttftMs != null,
  }
}

/** `codex doctor --json` → 槽健康（版本 / auth / 配置 / 网络）。 */
export async function codexDoctorStatus({
  bin = null,
  codexHome = null,
  env = {},
  // doctor 会做网络探测：机器忙的时候十几秒很正常，给 20s 会把"机器慢"变成"槽坏了"。
  timeoutMs = 60000,
  spawnImpl = spawn,
} = {}) {
  const binPath = bin || codexBinPath({})
  const childEnv = { ...process.env, ...env, ...(codexHome ? { CODEX_HOME: codexHome } : {}), CI: '1' }
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child = null
    try {
      child = spawnImpl(binPath, ['doctor', '--json'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, reason: 'spawn_failed', error: String(error?.message || error) })
      return
    }
    const timer = setTimeout(
      () => {
        try {
          child.kill('SIGKILL')
        } catch {}
        resolve({ ok: false, reason: 'timeout' })
      },
      Math.max(1000, timeoutMs),
    )
    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk) => {
      out += String(chunk)
    })
    child.stderr?.setEncoding?.('utf8')
    child.stderr?.on('data', (chunk) => {
      err += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, reason: 'spawn_failed', error: String(error?.message || error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let parsed = null
      try {
        parsed = JSON.parse(out)
      } catch {}
      if (!parsed) {
        resolve({ ok: false, reason: 'unparsable', exit_code: Number(code) || 0, stderr: err.slice(-500) })
        return
      }
      const checks = parsed.checks && typeof parsed.checks === 'object' ? parsed.checks : {}
      const auth = checks['auth.credentials'] || null
      resolve({
        ok: String(parsed.overallStatus || '') !== 'fail',
        overall: parsed.overallStatus || null,
        version: parsed.codexVersion || null,
        auth_status: auth?.status || null,
        auth_summary: auth?.summary || null,
        checks,
        raw_status: Number(code) || 0,
      })
    })
  })
}
