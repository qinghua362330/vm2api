/**
 * 每个 codex 槽一份 CODEX_HOME。
 *
 * 真 Codex CLI 把「我是谁」放在 `$CODEX_HOME` 下：`auth.json` 是凭证，会话/历史、
 * app-server 控制 socket 也都在里面。所以「一槽一份凭证、槽之间互不串味」这件事，
 * 对 CLI 来说就等于「一槽一个 CODEX_HOME」—— 和 Claude 侧 `cli-home` 是同一个套路。
 *
 * 实证（codex-cli 0.154.0，写这份代码时逐条验过）：
 *   - `$CODEX_HOME/auth.json` 写成 `{OPENAI_API_KEY, tokens:{id_token,access_token,
 *     refresh_token,account_id}, last_refresh}` 后，`codex login status` 报
 *     "Logged in using ChatGPT"，`codex doctor` 报 "auth is configured"；
 *   - `HTTPS_PROXY` / `ALL_PROXY=socks5h://…` 都生效（含其 WSS 上游），所以槽绑定的
 *     SOCKS5 出口可以直接喂给它；
 *   - `codex doctor --json` 是现成的槽健康探针。
 *
 * 凭证只写不读：本模块不回传 token，只有 `codexHomeStatus()` 报"有没有、是谁"。
 */

import fs from 'node:fs'
import path from 'node:path'

export const CODEX_HOME_DIRNAME = 'codex-home'

export function codexHomeDir(projectRoot, vmId) {
  const id = String(vmId || '').trim()
  if (!projectRoot || !id) return ''
  return path.join(projectRoot, 'vms', id, CODEX_HOME_DIRNAME)
}

export function codexAuthPath(projectRoot, vmId) {
  const home = codexHomeDir(projectRoot, vmId)
  return home ? path.join(home, 'auth.json') : ''
}

export function codexConfigPath(projectRoot, vmId) {
  const home = codexHomeDir(projectRoot, vmId)
  return home ? path.join(home, 'config.toml') : ''
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}

/**
 * 槽里存的那条 codex 账号 → CLI 的 auth.json。
 *
 * 字段名必须完全对上：CLI 会解析 id_token（要求是 JWT，格式不对会直接报
 * "invalid ID token format"），并从中取 account_id —— 所以缺失字段时报错比写一个
 * 半残的文件好，后者只会让人在上游 401 里猜半天。
 */
export function buildCodexAuth({ account = null, apiKey = null, now = Date.now() } = {}) {
  const key = firstString(apiKey, account?.api_key, account?.OPENAI_API_KEY)
  const access = firstString(account?.access_token, account?.accessToken)
  const refresh = firstString(account?.refresh_token, account?.refreshToken)
  const idToken = firstString(account?.id_token, account?.idToken)
  const accountId = firstString(account?.chatgpt_account_id, account?.account_id, account?.chatgptAccountId)

  if (!key && !access && !refresh) return { ok: false, reason: 'no_credential' }
  if (key && !access) {
    // API key 模式：CLI 用 OPENAI_API_KEY，走 api.openai.com，不是 ChatGPT 套餐。
    return {
      ok: true,
      mode: 'api_key',
      auth: { OPENAI_API_KEY: key, tokens: null, last_refresh: new Date(now).toISOString() },
    }
  }
  if (!access) return { ok: false, reason: 'access_token_required' }
  return {
    ok: true,
    mode: 'chatgpt',
    auth: {
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken,
        access_token: access,
        refresh_token: refresh,
        account_id: accountId,
      },
      last_refresh: new Date(now).toISOString(),
    },
  }
}

/**
 * 代理 → CLI 的环境变量。
 *
 * socks5/socks5h 只有 `ALL_PROXY` 认（reqwest 的约定），所以两种都设上：HTTP 代理
 * 走 HTTPS_PROXY，SOCKS 走 ALL_PROXY。NO_PROXY 固定放行本机，免得槽内部的健康检查
 * 被绕一圈出去。
 */
export function proxyEnvFor(proxyUrl) {
  const url = String(proxyUrl || '').trim()
  const base = { NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' }
  if (!url) return base
  if (/^socks/i.test(url)) return { ...base, ALL_PROXY: url, all_proxy: url }
  return { ...base, HTTPS_PROXY: url, https_proxy: url, HTTP_PROXY: url, http_proxy: url }
}

/**
 * 只写用户显式给的键：CLI 有 `--strict-config`（未知字段直接报错），猜 TOML 键
 * 会把一个能跑的槽变成起不来的槽。每请求变量（model / sandbox）由驱动用命令行参数传。
 */
export function buildCodexConfigToml(options = {}) {
  const lines = []
  const entries = [
    ['model', options.model],
    ['model_reasoning_effort', options.reasoningEffort],
    ['approval_policy', options.approvalPolicy],
    ['sandbox_mode', options.sandboxMode],
  ]
  for (const [key, value] of entries) {
    const text = String(value ?? '').trim()
    if (text) lines.push(`${key} = ${JSON.stringify(text)}`)
  }
  return lines.length ? `${lines.join('\n')}\n` : ''
}

function writeSecret(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, content, { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {}
}

/**
 * 把槽的凭证与出口落到 `$CODEX_HOME`。返回驱动需要的环境变量，不回传 token。
 *
 * @returns {{ok:boolean, reason?:string, home?:string, authPath?:string, configPath?:string,
 *   mode?:string, env?:Record<string,string>}}
 */
export function materializeCodexHome({
  projectRoot,
  vm,
  account = null,
  apiKey = null,
  proxyUrl = null,
  model = null,
  reasoningEffort = null,
  sandboxMode = null,
  approvalPolicy = null,
  writeConfig = false,
} = {}) {
  const vmId = String(vm?.id || '').trim()
  const home = codexHomeDir(projectRoot, vmId)
  if (!home) return { ok: false, reason: 'project_and_vm_required' }

  const built = buildCodexAuth({ account, apiKey })
  if (!built.ok) return built

  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const authPath = path.join(home, 'auth.json')
  writeSecret(authPath, `${JSON.stringify(built.auth, null, 2)}\n`)

  let configPath = null
  const toml = writeConfig ? buildCodexConfigToml({ model, reasoningEffort, sandboxMode, approvalPolicy }) : ''
  if (toml) {
    configPath = path.join(home, 'config.toml')
    writeSecret(configPath, toml)
  }

  return {
    ok: true,
    mode: built.mode,
    home,
    authPath,
    configPath,
    env: { CODEX_HOME: home, ...proxyEnvFor(proxyUrl) },
  }
}

/** 槽状态：有没有凭证、是哪种模式、account_id 是谁。不含任何 token 内容。 */
export function codexHomeStatus({ projectRoot, vm } = {}) {
  const vmId = String(vm?.id || '').trim()
  const home = codexHomeDir(projectRoot, vmId)
  if (!home) return { ok: false, reason: 'project_and_vm_required' }
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'))
  } catch {
    return { ok: false, reason: 'auth_missing', home }
  }
  const tokens = raw?.tokens && typeof raw.tokens === 'object' ? raw.tokens : null
  const hasApiKey = !!firstString(raw?.OPENAI_API_KEY)
  const hasAccess = !!firstString(tokens?.access_token)
  const hasRefresh = !!firstString(tokens?.refresh_token)
  return {
    ok: hasApiKey || hasAccess || hasRefresh,
    home,
    mode: hasApiKey && !hasAccess ? 'api_key' : 'chatgpt',
    account_id: firstString(tokens?.account_id) || null,
    has_access: hasAccess,
    has_refresh: hasRefresh,
    has_api_key: hasApiKey,
    last_refresh: raw?.last_refresh || null,
    config_present: fs.existsSync(path.join(home, 'config.toml')),
  }
}
