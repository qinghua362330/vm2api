import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildCodexAuth,
  buildCodexConfigToml,
  codexHomeStatus,
  materializeCodexHome,
  proxyEnvFor,
} from '../../src/lib/vm/codex-home.mjs'
import {
  codexEventsToSse,
  codexExecArgs,
  deltaFromCumulative,
  newCodexStreamState,
  parseCodexJsonlLine,
  promptFromResponsesBody,
  streamCodexCli,
} from '../../src/lib/transport/codex-cli-client.mjs'

/**
 * Codex CLI 驱动：先测纯翻译，再拿一个"假 CLI"（脚本回放真实 JSONL）测整条流。
 * 桩的意义在于事件形状是从真二进制里读出来的（thread.started / turn.completed /
 * item.updated 累计文本），不依赖真凭证也能锁住回归。
 */

// 每个元素是一整段 SSE（`event: …\ndata: …\n\n`），先摊平成行再取 data。
function sseEvents(chunks) {
  return String(Array.isArray(chunks) ? chunks.join('') : chunks)
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-cli-'))
}

// ── CODEX_HOME ──────────────────────────────────────────────────────────────

test('auth.json 按 CLI 认的形状写：tokens 三件套 + account_id', () => {
  const built = buildCodexAuth({
    account: { access_token: 'at', refresh_token: 'rt', id_token: 'jwt', chatgpt_account_id: 'acc-1' },
    now: Date.parse('2026-01-01T00:00:00Z'),
  })
  assert.equal(built.ok, true)
  assert.equal(built.mode, 'chatgpt')
  assert.deepEqual(Object.keys(built.auth.tokens).sort(), ['access_token', 'account_id', 'id_token', 'refresh_token'])
  assert.equal(built.auth.tokens.account_id, 'acc-1')
  assert.equal(built.auth.OPENAI_API_KEY, null)
})

test('只有 refresh_token 不算可用凭证 —— 写半残文件只会让人在上游 401 里猜', () => {
  assert.equal(buildCodexAuth({ account: { refresh_token: 'rt' } }).reason, 'access_token_required')
  assert.equal(buildCodexAuth({}).reason, 'no_credential')
})

test('API key 模式走 OPENAI_API_KEY，不伪造 tokens', () => {
  const built = buildCodexAuth({ apiKey: 'sk-test' })
  assert.equal(built.mode, 'api_key')
  assert.equal(built.auth.OPENAI_API_KEY, 'sk-test')
  assert.equal(built.auth.tokens, null)
})

test('socks5 代理只认 ALL_PROXY，http 代理才写 HTTPS_PROXY', () => {
  const socks = proxyEnvFor('socks5h://127.0.0.1:1080')
  assert.equal(socks.ALL_PROXY, 'socks5h://127.0.0.1:1080')
  assert.equal(socks.HTTPS_PROXY, undefined)
  const http = proxyEnvFor('http://127.0.0.1:8080')
  assert.equal(http.HTTPS_PROXY, 'http://127.0.0.1:8080')
  assert.equal(http.ALL_PROXY, undefined)
  assert.match(proxyEnvFor(null).NO_PROXY, /127\.0\.0\.1/)
})

test('config.toml 只写显式给的键（CLI 的 --strict-config 会拒绝未知字段）', () => {
  assert.equal(buildCodexConfigToml({}), '')
  const toml = buildCodexConfigToml({ model: 'gpt-5.1-codex', sandboxMode: 'read-only' })
  assert.match(toml, /^model = "gpt-5\.1-codex"$/m)
  assert.match(toml, /^sandbox_mode = "read-only"$/m)
})

test('materializeCodexHome 落盘 0600，且状态查询不回传 token', () => {
  const project = tmp()
  try {
    const home = materializeCodexHome({
      projectRoot: project,
      vm: { id: 'vm-codex-01' },
      account: { access_token: 'at-secret', refresh_token: 'rt-secret', chatgpt_account_id: 'acc-9' },
      proxyUrl: 'socks5h://127.0.0.1:1080',
    })
    assert.equal(home.ok, true)
    assert.equal(home.env.CODEX_HOME, path.join(project, 'vms', 'vm-codex-01', 'codex-home'))
    assert.equal(fs.statSync(home.authPath).mode & 0o777, 0o600)
    assert.equal(home.env.ALL_PROXY, 'socks5h://127.0.0.1:1080')

    const status = codexHomeStatus({ projectRoot: project, vm: { id: 'vm-codex-01' } })
    assert.equal(status.ok, true)
    assert.equal(status.mode, 'chatgpt')
    assert.equal(status.account_id, 'acc-9')
    assert.equal(JSON.stringify(status).includes('at-secret'), false, 'status must not leak tokens')
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

// ── 事件翻译 ────────────────────────────────────────────────────────────────

test('JSONL 解析容错：杂音、半截 JSON、无 type 都不算事件', () => {
  assert.equal(parseCodexJsonlLine(''), null)
  assert.equal(parseCodexJsonlLine('Reading additional input from stdin...'), null)
  assert.equal(parseCodexJsonlLine('{"type":'), null)
  assert.equal(parseCodexJsonlLine('{"no_type":1}'), null)
  assert.deepEqual(parseCodexJsonlLine('{"type":"turn.started"}'), { type: 'turn.started' })
})

test('累计文本 → 增量：追加、重发、替换三种情况', () => {
  assert.equal(deltaFromCumulative('hello', ''), 'hello')
  assert.equal(deltaFromCumulative('hello world', 'hello '), 'world')
  assert.equal(deltaFromCumulative('hello', 'hello world'), '', 'a replayed prefix must not re-emit')
  assert.equal(deltaFromCumulative('totally different', 'hello'), 'totally different')
})

test('一次完整回合翻译成 Responses SSE 序列', () => {
  const state = newCodexStreamState({ id: 'resp_1', model: 'gpt-5.1-codex' })
  const lines = codexEventsToSse(
    [
      { type: 'thread.started', thread_id: 'th_1' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'skills budget note' } },
      { type: 'item.updated', item: { id: 'item_1', type: 'agent_message', text: 'Hel' } },
      { type: 'item.updated', item: { id: 'item_1', type: 'agent_message', text: 'Hello' } },
      {
        type: 'turn.completed',
        usage: { input_tokens: 11, cached_input_tokens: 3, output_tokens: 7, reasoning_output_tokens: 2 },
      },
    ],
    state,
  )
  const events = sseEvents(lines)
  const types = events.map((event) => event.type)
  assert.deepEqual(types.slice(0, 2), ['response.created', 'response.in_progress'])
  assert.equal(state.threadId, 'th_1', 'thread id is the resume handle')
  // 累计文本不能重复发：'Hel' + 'lo'，不是 'Hel' + 'Hello'
  const deltas = events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta)
  assert.deepEqual(deltas, ['Hel', 'lo'])
  const completed = events.at(-1)
  assert.equal(completed.type, 'response.completed')
  assert.equal(completed.response.output_text, 'Hello')
  assert.equal(completed.response.usage.input_tokens, 11)
  assert.equal(completed.response.usage.input_tokens_details.cached_tokens, 3)
  assert.equal(completed.response.usage.output_tokens_details.reasoning_tokens, 2)
  // 非致命的 item.error 不能被当成请求失败
  assert.equal(types.includes('response.failed'), false)
})

test('turn.failed 翻译成 response.failed 并带上原因', () => {
  const state = newCodexStreamState({ id: 'resp_2' })
  const events = sseEvents(
    codexEventsToSse(
      [{ type: 'turn.started' }, { type: 'turn.failed', message: 'unexpected status 401 Unauthorized' }],
      state,
    ),
  )
  const failed = events.find((event) => event.type === 'response.failed')
  assert.ok(failed, 'a failed turn must surface as response.failed')
  assert.match(failed.response.error.message, /401/)
  assert.equal(state.failed, true)
})

test('exec 参数：stdin 必须用 - 收尾，resume 才带 thread id', () => {
  const fresh = codexExecArgs({ model: 'gpt-5.1-codex' })
  assert.deepEqual(fresh.slice(0, 2), ['exec', '--json'])
  assert.ok(fresh.includes('--skip-git-repo-check'))
  assert.ok(fresh.includes('--ephemeral'))
  assert.equal(fresh.at(-1), '-')
  const resume = codexExecArgs({ resume: true, threadId: 'th_9' })
  assert.deepEqual(resume.slice(0, 3), ['exec', 'resume', 'th_9'])
})

test('Responses 请求体 → 提示词', () => {
  const prompt = promptFromResponsesBody({
    instructions: 'be terse',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'again' }] },
    ],
  })
  assert.match(prompt, /^be terse/)
  assert.match(prompt, /\[assistant\]\nhello/)
  assert.match(prompt, /again$/)
})

// ── 整条流（假 CLI 回放真实事件形状） ───────────────────────────────────────

function stubCliProject(script) {
  const dir = tmp()
  const bin = path.join(dir, 'fake-codex.mjs')
  fs.writeFileSync(bin, `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 })
  return { dir, bin }
}

test('streamCodexCli 把 CLI 的 stdout 变成 SSE 行，并回报 usage 与 thread id', async () => {
  const { dir, bin } = stubCliProject(`
const events = [
  { type: 'thread.started', thread_id: 'th_live' },
  { type: 'turn.started' },
  { type: 'item.updated', item: { id: 'i1', type: 'agent_message', text: 'po' } },
  { type: 'item.updated', item: { id: 'i1', type: 'agent_message', text: 'pong' } },
  { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'pong' } },
  { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } },
]
for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n')
process.stderr.write('noise on stderr\\n')
`)
  try {
    const seen = []
    const result = await streamCodexCli({
      exec: { projectRoot: dir },
      body: {
        model: 'gpt-5.1-codex',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
      },
      bin,
      codexHome: path.join(dir, 'codex-home'),
      env: { CODEX_HOME: path.join(dir, 'codex-home') },
      onEvent: async (line) => seen.push(line),
    })
    assert.equal(result.ok, true, JSON.stringify(result.body))
    assert.equal(result.via, 'codex-cli')
    assert.equal(result.thread_id, 'th_live')
    assert.equal(result.text, 'pong')
    assert.equal(result.usage.output_tokens, 2)
    const types = sseEvents(seen).map((event) => event.type)
    assert.deepEqual(types.filter((type) => type === 'response.output_text.delta').length, 2)
    assert.equal(types.at(-1), 'response.completed')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI 退出码非 0 时是失败，且失败原因带回来', async () => {
  const { dir, bin } = stubCliProject(`
process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'turn.failed', message: 'no credential' }) + '\\n')
process.exit(1)
`)
  try {
    const result = await streamCodexCli({ exec: { projectRoot: dir }, body: {}, bin, onEvent: async () => {} })
    assert.equal(result.ok, false)
    assert.equal(result.status, 502)
    assert.match(String(result.body.error.message), /no credential/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('真 CLI 冒烟：存在就用 codex doctor 报出可用性（没有就跳过）', async (t) => {
  const candidates = [
    process.env.KIN_CODEX_BIN,
    '/tmp/codexcli/node_modules/.bin/codex',
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/codex'),
  ].filter(Boolean)
  const bin = candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })
  if (!bin) {
    t.skip('真 Codex CLI 不存在（KIN_CODEX_BIN 未设置且没有本地安装）')
    return
  }
  const { codexDoctorStatus } = await import('../../src/lib/transport/codex-cli-client.mjs')
  const home = tmp()
  try {
    const status = await codexDoctorStatus({ bin, codexHome: home, timeoutMs: 90000 })
    if (status.reason === 'timeout') {
      // 整仓 152 个测试文件并发跑时机器可能忙到超时：这是环境问题，不是驱动问题，
      // 如实跳过，别把它伪装成通过。
      t.skip('codex doctor 在并发测试负载下超时')
      return
    }
    assert.equal(typeof status.version, 'string', JSON.stringify(status).slice(0, 300))
    assert.match(status.version, /^\d+\.\d+\.\d+$/)
    // 空 CODEX_HOME 必须是"没凭证"，这正是 materializeCodexHome 要补的洞。
    assert.equal(status.auth_status, 'fail')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// ── 接线：这一跳真的走 CLI ──────────────────────────────────────────────────

test('codexEngineFor：auto 有二进制走 cli，没有则退回 http，显式配置优先', async () => {
  const { codexEngineFor } = await import('../../src/lib/protocol/handle-codex.mjs')
  assert.equal(codexEngineFor({ routing: {}, hasBin: true }), 'cli')
  assert.equal(codexEngineFor({ routing: {}, hasBin: false }), 'http')
  assert.equal(codexEngineFor({ routing: { engine: 'http' }, hasBin: true }), 'http')
  assert.equal(codexEngineFor({ routing: { engine: 'cli' }, hasBin: false }), 'cli')
  assert.equal(codexEngineFor({ routing: { hop: 'HTTP' }, hasBin: true }), 'http')
  // auto + 环境变量：测试/部署要能不改配置文件就钉死引擎
  assert.equal(codexEngineFor({ routing: {}, hasBin: true, env: { KIN_CODEX_ENGINE: 'http' } }), 'http')
  assert.equal(codexEngineFor({ routing: {}, hasBin: false, env: { KIN_CODEX_ENGINE: 'cli' } }), 'cli')
  // 显式配置压过环境变量
  assert.equal(codexEngineFor({ routing: { engine: 'cli' }, hasBin: false, env: { KIN_CODEX_ENGINE: 'http' } }), 'cli')
})

test('handleCodexProtocol 用 CLI 跑完一跳，并把 SSE 写给客户端', async () => {
  const { handleCodexProtocol } = await import('../../src/lib/protocol/handle-codex.mjs')
  const project = tmp()
  const bin = path.join(project, 'fake-codex.mjs')
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'th_wire' }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'item.updated', item: { id: 'i', type: 'agent_message', text: 'pong' } }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n')
`,
    { mode: 0o755 },
  )
  // 一个带代理的 codex 槽 + 一份凭证，和真实槽同形状。
  // listVms 只认 vms/vm-*.json；凭证在 vms/<id>/codex-credentials.json。
  fs.mkdirSync(path.join(project, 'vms', 'vm-codex-01'), { recursive: true })
  fs.writeFileSync(
    path.join(project, 'vms', 'vm-codex-01.json'),
    JSON.stringify({
      id: 'vm-codex-01',
      name: 'vm-codex-01',
      status: 'running',
      schedulable: true,
      platform: 'openai',
      family: 'codex',
      codex_kernel: true,
      proxy_cli_enabled: true,
      proxy: { id: 'proxy-codex-01', url: 'socks5h://127.0.0.1:1080' },
    }),
  )
  fs.writeFileSync(path.join(project, 'vms', 'active.json'), JSON.stringify({ active_vm: 'vm-codex-01' }))
  fs.writeFileSync(
    path.join(project, 'vms', 'vm-codex-01', 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ id: 'a1', access_token: 'at', refresh_token: 'rt', id_token: 'jwt', chatgpt_account_id: 'acc' }],
    }),
  )

  try {
    const written = []
    const headers = []
    const logBag = {}
    const res = {
      headersSent: false,
      write: (line) => written.push(line),
      end: () => {},
    }
    const result = await handleCodexProtocol({
      req: { method: 'POST', headers: {}, apiKeyKind: 'master' },
      res,
      protocol: 'openai.responses',
      ctx: { body: { model: 'gpt-5.1-codex', input: 'ping', stream: true } },
      inbound: { stream: true },
      logBag,
      stats: { requests: 0, errors: 0, by_route: {} },
      json: (_res, status, payload) => ({ ok: false, status, body: payload }),
      writeSSEHeaders: () => {
        res.headersSent = true
        headers.push(1)
      },
      // 这条用例走"宿主执行"这条兼容路径（allow_host_cli）：测试环境没有容器。
      // 不显式打开会 503 codex_slot_not_running —— 那正是默认该有的行为。
      routing: { codex: { enabled: true, engine: 'cli', allow_host_cli: true } },
      projectRoot: project,
      ops: {
        // 真 CLI 的二进制由测试提供：既验证接线，又不依赖机器上装没装。
        streamCodexCli: (args) =>
          streamCodexCli({ ...args, bin, codexHome: path.join(project, 'vms', 'codex-01', 'codex-home') }),
      },
    })
    assert.equal(result?.ok !== false, true, JSON.stringify(result))
    assert.equal(logBag.via, 'codex-cli')
    assert.equal(logBag.codex_engine, 'cli')
    assert.equal(logBag.codex_thread_id, 'th_wire')
    assert.equal(logBag.output_tokens, 1)
    const types = sseEvents(written).map((event) => event.type)
    assert.ok(types.includes('response.output_text.delta'), types.join(','))
    assert.equal(types.at(-1), 'response.completed')
    // 凭证落到了槽自己的 CODEX_HOME
    const status = codexHomeStatus({ projectRoot: project, vm: { id: 'vm-codex-01' } })
    assert.equal(status.ok, true)
    assert.equal(status.account_id, 'acc')
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('没绑代理的 codex 槽在 CLI 形态下被拒绝，不会从宿主机 IP 出去', async () => {
  const { handleCodexProtocol } = await import('../../src/lib/protocol/handle-codex.mjs')
  const project = tmp()
  fs.mkdirSync(path.join(project, 'vms', 'vm-codex-01'), { recursive: true })
  fs.writeFileSync(
    path.join(project, 'vms', 'vm-codex-01.json'),
    JSON.stringify({
      id: 'vm-codex-01',
      status: 'running',
      schedulable: true,
      platform: 'openai',
      family: 'codex',
      codex_kernel: true,
      proxy_cli_enabled: false,
    }),
  )
  fs.writeFileSync(path.join(project, 'vms', 'active.json'), JSON.stringify({ active_vm: 'vm-codex-01' }))
  try {
    const response = await handleCodexProtocol({
      req: { method: 'POST', headers: {}, apiKeyKind: 'master' },
      res: { headersSent: false, write: () => {}, end: () => {} },
      protocol: 'openai.responses',
      ctx: { body: { model: 'gpt-5.1-codex', input: 'ping' } },
      inbound: { stream: true },
      logBag: {},
      stats: { requests: 0, errors: 0, by_route: {} },
      json: (_res, status, payload) => ({ status, body: payload }),
      writeSSEHeaders: () => {},
      routing: { codex: { enabled: true, engine: 'cli' } },
      projectRoot: project,
      ops: { streamCodexCli: () => assert.fail('must not reach the CLI without a proxy') },
    })
    assert.equal(response.status, 503)
    assert.equal(response.body.error.code, 'no_codex_slot')
    assert.match(response.body.error.message, /proxy_required/, '闸门原因要原样带出来')
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

// ── 槽选择：复用用户绑定 / 桶 / 负载，且不污染 Claude 的出口 ─────────────────

function codexFleet(project) {
  // 一个 Claude 槽（IP-A）+ 两个 codex 槽（IP-B / IP-C），和真实 fleet 同形状。
  const write = (id, patch) => {
    fs.mkdirSync(path.join(project, 'vms', id), { recursive: true })
    fs.writeFileSync(
      path.join(project, 'vms', `${id}.json`),
      JSON.stringify({ id, status: 'running', schedulable: true, proxy_cli_enabled: true, ...patch }),
    )
  }
  write('vm-claude', {
    proxy: { id: 'proxy-a', url: 'socks5h://127.0.0.1:1081' },
    claude: {
      account_uuid: 'acct-claude',
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
  })
  write('vm-codex-1', {
    platform: 'openai',
    family: 'codex',
    codex_kernel: true,
    proxy: { id: 'proxy-b', url: 'socks5h://127.0.0.1:1082' },
  })
  write('vm-codex-2', {
    platform: 'openai',
    family: 'codex',
    codex_kernel: true,
    proxy: { id: 'proxy-c', url: 'socks5h://127.0.0.1:1083' },
  })
  fs.writeFileSync(path.join(project, 'vms', 'active.json'), JSON.stringify({ active_vm: 'vm-claude' }))
  const creds = (id) =>
    fs.writeFileSync(
      path.join(project, 'vms', id, 'codex-credentials.json'),
      JSON.stringify({
        accounts: [{ id: `${id}-a`, access_token: 'at', refresh_token: 'rt', chatgpt_account_id: `acc-${id}` }],
      }),
    )
  creds('vm-codex-1')
  creds('vm-codex-2')
}

test('codex 槽选择走用户绑定与桶，且不动同一个用户的 Claude 出口', async () => {
  const { pickCodexVm } = await import('../../src/lib/protocol/handle-codex.mjs')
  const { EgressBindingsRepo } = await import('../../src/lib/db/repos/egress-bindings-repo.mjs')
  const { closeDatabase, getDb, openDatabase } = await import('../../src/lib/db/database.mjs')
  const project = tmp()
  const prev = process.env.KIN_DB_PATH
  process.env.KIN_DB_PATH = path.join(project, 'kin.db')
  try {
    codexFleet(project)
    openDatabase()
    const repo = new EgressBindingsRepo(getDb())
    // 这个用户本来就有 Claude 出口：IP-A 上的 claude 槽。
    repo.upsertEgressBinding({ userId: 'u1', egressId: 'proxy-a', kind: 'claude' })
    repo.upsertSlotBinding({ userId: 'u1', slotId: 'vm-claude', egressId: 'proxy-a', kind: 'claude' })

    const req = { headers: {}, apiKeyKind: 'key', apiKeyRecord: { user_id: 'u1' } }
    const picked = pickCodexVm(project, req)
    assert.ok(picked.vm, JSON.stringify(picked))
    assert.equal(isCodex(picked.vm), true, '必须挑 codex 槽')
    assert.equal(picked.userId, 'u1')
    assert.match(picked.egressId, /^proxy-[bc]$/)

    // Claude 那一套完全没动 —— 这是 kind 隔离的意义
    const claudeEgress = repo.getEgressBinding('u1')
    assert.equal(claudeEgress.egress_id, 'proxy-a', 'codex 的落点不能改写 Claude 的出口')
    assert.equal(repo.getSlotBinding('u1').slot_id, 'vm-claude')
    assert.deepEqual(
      repo.listBuckets('u1').map((bucket) => bucket.egress_id),
      ['proxy-a'],
      'codex 的桶不能混进 Claude 的桶集合',
    )
    // codex 自己那一套落了盘：一条绑定 + 一个槽 + 一个桶
    const codexEgress = repo.getEgressBinding('u1', 'codex')
    assert.ok(codexEgress?.egress_id, 'codex 也要有自己的绑定')
    assert.equal(repo.getSlotBinding('u1', 'codex').egress_id, codexEgress.egress_id)
    assert.deepEqual(
      repo.listBuckets('u1', 'codex').map((bucket) => bucket.egress_id),
      [codexEgress.egress_id],
    )

    // 第二次请求走快路径，落点稳定
    const again = pickCodexVm(project, req)
    assert.equal(again.vm.id, picked.vm.id, '同一个用户的 codex 落点要稳定')
  } finally {
    closeDatabase()
    if (prev === undefined) delete process.env.KIN_DB_PATH
    else process.env.KIN_DB_PATH = prev
    fs.rmSync(project, { recursive: true, force: true })
  }
})

function isCodex(vm) {
  return vm?.platform === 'openai' || vm?.codex_kernel === true
}

test('平台级调用（没有用户）挑最空的 codex 槽，且绝不挑 Claude 槽', async () => {
  const { pickCodexVm } = await import('../../src/lib/protocol/handle-codex.mjs')
  const project = tmp()
  try {
    codexFleet(project)
    // codex-1 上挂两个人，codex-2 没人 → 应挑 codex-2
    const { closeDatabase, getDb, openDatabase } = await import('../../src/lib/db/database.mjs')
    const prev = process.env.KIN_DB_PATH
    process.env.KIN_DB_PATH = path.join(project, 'kin.db')
    openDatabase()
    const { EgressBindingsRepo } = await import('../../src/lib/db/repos/egress-bindings-repo.mjs')
    const repo = new EgressBindingsRepo(getDb())
    repo.upsertSlotBinding({ userId: 'x1', slotId: 'vm-codex-1', egressId: 'proxy-b', kind: 'codex' })
    repo.upsertSlotBinding({ userId: 'x2', slotId: 'vm-codex-1', egressId: 'proxy-b', kind: 'codex' })

    const picked = pickCodexVm(project, { headers: {}, apiKeyKind: 'master' })
    assert.equal(picked.vm.id, 'vm-codex-2', JSON.stringify(picked))
    assert.equal(picked.scope, 'platform')

    // master 可以 pin，但 pin 到 Claude 槽必须被拒
    const mismatch = pickCodexVm(project, { headers: { 'x-kin-vm': 'vm-claude' }, apiKeyKind: 'master' })
    assert.equal(mismatch.error, 'platform_mismatch')

    closeDatabase()
    if (prev === undefined) delete process.env.KIN_DB_PATH
    else process.env.KIN_DB_PATH = prev
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('没有凭证的 codex 槽不参与选择', async () => {
  const { pickCodexVm } = await import('../../src/lib/protocol/handle-codex.mjs')
  const project = tmp()
  try {
    codexFleet(project)
    // 把两个 codex 槽的凭证都清掉
    for (const id of ['vm-codex-1', 'vm-codex-2']) {
      fs.writeFileSync(path.join(project, 'vms', id, 'codex-credentials.json'), JSON.stringify({ accounts: [] }))
    }
    const picked = pickCodexVm(project, { headers: {}, apiKeyKind: 'master' })
    assert.equal(picked.error, 'no_codex_slot', JSON.stringify(picked))
    assert.equal(picked.reason, 'no_codex_credential', '没凭证要说清楚是没凭证')
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('槽容器没起来时默认拒绝（不静默降级到宿主身份）', async () => {
  const { handleCodexProtocol } = await import('../../src/lib/protocol/handle-codex.mjs')
  const project = tmp()
  fs.mkdirSync(path.join(project, 'vms', 'vm-codex-01'), { recursive: true })
  fs.writeFileSync(
    path.join(project, 'vms', 'vm-codex-01.json'),
    JSON.stringify({
      id: 'vm-codex-01',
      status: 'running',
      schedulable: true,
      platform: 'openai',
      family: 'codex',
      codex_kernel: true,
      proxy_cli_enabled: true,
      proxy: { id: 'proxy-codex-01', url: 'socks5h://127.0.0.1:1082' },
    }),
  )
  fs.writeFileSync(path.join(project, 'vms', 'active.json'), JSON.stringify({ active_vm: 'vm-codex-01' }))
  fs.writeFileSync(
    path.join(project, 'vms', 'vm-codex-01', 'codex-credentials.json'),
    JSON.stringify({ accounts: [{ id: 'a', access_token: 'at', refresh_token: 'rt' }] }),
  )
  try {
    const response = await handleCodexProtocol({
      req: { method: 'POST', headers: {}, apiKeyKind: 'master' },
      res: { headersSent: false, write: () => {}, end: () => {} },
      protocol: 'openai.responses',
      ctx: { body: { model: 'gpt-5.1-codex', input: 'ping' } },
      inbound: { stream: true },
      logBag: {},
      stats: { requests: 0, errors: 0, by_route: {} },
      json: (_res, status, payload) => ({ status, body: payload }),
      writeSSEHeaders: () => {},
      routing: { codex: { enabled: true, engine: 'cli' } },
      projectRoot: project,
      ops: { streamCodexCli: () => assert.fail('must not run the CLI on the host by default') },
    })
    assert.equal(response.status, 503)
    assert.equal(response.body.error.code, 'codex_slot_not_running')
    assert.match(response.body.error.message, /allow_host_cli/)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('提示词写进 stdin（`codex exec … -` 是读 stdin，不是 argv）', async () => {
  const seen = { argv: null, stdin: null }
  const fakeChild = () => {
    const handlers = {}
    const child = {
      stdout: { setEncoding() {}, on: (ev, fn) => (handlers[`out:${ev}`] = fn) },
      stderr: { setEncoding() {}, on: (ev, fn) => (handlers[`err:${ev}`] = fn) },
      stdin: { end: (text) => (seen.stdin = text) },
      on: (ev, fn) => {
        handlers[ev] = fn
        if (ev === 'close') setTimeout(() => fn(0), 0)
        return child
      },
      kill() {},
    }
    return child
  }
  const result = await streamCodexCli({
    exec: { projectRoot: '/tmp' },
    body: {
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
    },
    bin: 'codex',
    spawnImpl: (cmd, args) => {
      seen.argv = args
      return fakeChild()
    },
    onEvent: async () => {},
  })
  assert.equal(result.ok, true, JSON.stringify(result.body))
  assert.equal(seen.argv.at(-1), '-', 'argv 结尾的 - 表示从 stdin 读')
  assert.equal(seen.stdin, 'ping', '提示词必须写进 stdin，否则 CLI 报 No prompt provided')
})
