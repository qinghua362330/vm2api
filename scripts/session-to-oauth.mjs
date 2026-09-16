/**
 * Session-key → OAuth conversion (Portunex CookieAuth chain).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PUBLIC SNAPSHOT NOTE
 * The live conversion chain is NOT distributed with this repository. It needs a
 * per-slot SOCKS5 exit plus a patched TLS stack, and it is deliberately kept out
 * of the open snapshot (see docs/OAUTH.md "导入门控").
 *
 * What this file provides:
 *   • the real, side-effect-free helpers every caller depends on
 *     (error classification, panel error envelopes, authorize-URL building,
 *     redirect parsing) — these were previously missing entirely, which made
 *     the whole module graph fail to import and the server unable to boot;
 *   • a deterministic offline path (`KIN_FAKE_SESSION_OAUTH=1`) for tests and
 *     local UI work;
 *   • a loud, typed failure for the live path instead of a crash at import.
 *
 * To restore the live chain, drop the upstream `session-to-oauth.mjs` and
 * `session-import-cffi.py` back into `scripts/` and delete the stub branch in
 * `sessionKeyToOAuth` / `exchangeTokenViaCffi`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Official Claude Code OAuth client id used by `claude setup-token`. */
export const SETUP_TOKEN_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const SETUP_TOKEN_SCOPE = 'user:inference'
export const COOKIE_AUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

export const IMPORT_HELPER_MISSING_CODES = Object.freeze([
  'no_cookie_auth_bin',
  'no_cffi_helper',
  'cloudflare_challenge',
])

const FAKE_ACCESS_PREFIX = 'sk-ant-oat01-FAKE'
const SESSION_KEY_RE = /^sk-ant-sid/i

export class SessionOAuthUnavailableError extends Error {
  constructor(message = 'session-to-oauth live chain is not included in the public snapshot') {
    super(message)
    this.name = 'SessionOAuthUnavailableError'
    this.code = 'no_cookie_auth_bin'
  }
}

function tail(text, n = 2000) {
  const s = String(text || '')
  return s.length > n ? s.slice(-n) : s
}

// ── helper-output classification ────────────────────────────────────────────

/**
 * Only a *missing* helper or a Cloudflare wall justifies retrying with the next
 * TLS stack. A rejected session or a permission error is terminal — retrying
 * burns the grant.
 */
export function shouldTryNextImportHelper(code) {
  return IMPORT_HELPER_MISSING_CODES.includes(String(code || ''))
}

/**
 * Map raw helper stdout/stderr to a stable import error code.
 * Ordered: the most specific signal first (`authorize_no_code` before the
 * freshness check, since both can appear in the same log tail).
 */
export function classifyImportHelperOutput(raw) {
  const text = tail(raw)
  if (!text) return 'cookie_auth_failed'
  if (/authorize_no_code|login_redirect/i.test(text)) return 'authorize_no_code'
  if (/session is not fresh enough|not fresh enough/i.test(text)) return 'session_stale_relogin'
  if (/cloudflare|just a moment|cf-chl/i.test(text)) return 'cloudflare_challenge'
  if (/permission_error|permission denied/i.test(text)) return 'permission_error'
  if (/no such file|not found|command not found|no_cookie_auth_bin|no_cffi_helper/i.test(text)) {
    return /cffi|python|\.py/i.test(text) ? 'no_cffi_helper' : 'no_cookie_auth_bin'
  }
  if (/invalid_grant|invalid grant/i.test(text)) return 'oauth_invalid_grant'
  if (/401|unauthorized/i.test(text)) return 'cookie_auth_failed'
  return 'cookie_auth_failed'
}

const PUBLIC_ERROR_MESSAGES = Object.freeze({
  session_stale_relogin: '登录会话不够新，请重新登录 claude.ai 后再试。',
  authorize_no_code: 'CAI 授权页没有返回授权码，请重新打开授权链接后重试。',
  cloudflare_challenge: '上游触发了 Cloudflare 校验，请更换出口代理后重试。',
  no_cookie_auth_bin: '本快照未包含 session-to-oauth 转换链，请补充 scripts/session-to-oauth.mjs 与 scripts/session-import-cffi.py。',
  no_cffi_helper: '本快照未包含 session-import-cffi.py，无法完成转换。',
  permission_error: '上游拒绝该会话（permission_error），请确认账号权限。',
  oauth_invalid_grant: '授权已被上游撤销，请重新登录。',
  cookie_auth_failed: '会话转换失败，请重试或更换出口代理。',
})

/** Never leak Cloudflare HTML or stack traces to the panel. */
export function publicImportError(raw, code = null) {
  const resolved = code || classifyImportHelperOutput(raw)
  const text = tail(raw)
  if (resolved === 'session_stale_relogin') return PUBLIC_ERROR_MESSAGES.session_stale_relogin
  if (resolved === 'authorize_no_code') return PUBLIC_ERROR_MESSAGES.authorize_no_code
  if (resolved === 'cloudflare_challenge') return PUBLIC_ERROR_MESSAGES.cloudflare_challenge
  if (resolved && PUBLIC_ERROR_MESSAGES[resolved] && !/cloudflare|just a moment/i.test(text)) {
    return PUBLIC_ERROR_MESSAGES[resolved]
  }
  return PUBLIC_ERROR_MESSAGES.cookie_auth_failed
}

/** { status, error: { code, message } } — the shape panel routes return. */
export function panelImportErrorPayload(err = {}) {
  const explicit = err?.error?.code || err?.code || null
  const raw = [err?.error?.message, err?.message, err?.stdout, err?.stderr].filter(Boolean).join(' ')
  const code = explicit && explicit !== 'internal_error' ? explicit : classifyImportHelperOutput(raw)
  const status =
    code === 'no_cookie_auth_bin' || code === 'no_cffi_helper'
      ? 501
      : code === 'cloudflare_challenge'
        ? 502
        : code === 'permission_error' || code === 'oauth_invalid_grant'
          ? 403
          : 400
  return {
    status,
    error: { code, message: publicImportError(raw, code) },
  }
}

// ── URL helpers ─────────────────────────────────────────────────────────────

/** CAI authorize URL for `claude setup-token` — inference scope only. */
export function buildSetupTokenAuthorizeURL(state, codeChallenge) {
  const params = new URLSearchParams({
    code: 'true',
    client_id: SETUP_TOKEN_CLIENT_ID,
    response_type: 'code',
    redirect_uri: 'https://platform.claude.com/oauth/code/callback',
    scope: SETUP_TOKEN_SCOPE,
    state: String(state || ''),
    code_challenge: String(codeChallenge || ''),
    code_challenge_method: 'S256',
  })
  return `https://claude.com/cai/oauth/authorize?${params.toString()}`
}

/** Pull `code` / `state` out of a callback URL, hash fragment, or body object. */
export function extractOAuthCodeFromRedirect(input) {
  let target = ''
  if (input && typeof input === 'object') {
    target = String(input.redirect_uri || input.url || input.redirect_url || '')
  } else {
    target = String(input || '')
  }
  if (!target) return null
  const hashIdx = target.indexOf('#')
  const search = target.includes('?') ? target.slice(target.indexOf('?') + 1).split('#')[0] : ''
  const hash = hashIdx >= 0 ? target.slice(hashIdx + 1) : ''
  for (const chunk of [search, hash]) {
    if (!chunk) continue
    const q = new URLSearchParams(chunk)
    const code = q.get('code')
    if (code) return { code, state: q.get('state') || null }
  }
  return null
}

// ── conversion ──────────────────────────────────────────────────────────────

function fakeCredential(sessionKey, { scope } = {}) {
  const setupToken = String(scope || '').toLowerCase() === 'inference'
  const suffix = String(sessionKey).slice(-8).replace(/[^a-zA-Z0-9]/g, '') || '00000000'
  return {
    source: 'KIN_FAKE_SESSION_OAUTH',
    email: 'fake-oauth@kin.test',
    access_token: `${FAKE_ACCESS_PREFIX}-${suffix}`,
    refresh_token: `sk-ant-ort01-FAKE-${suffix}`,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    account_uuid: '00000000-0000-4000-8000-000000000000',
    org_uuid: '00000000-0000-4000-8000-000000000001',
    scopes: setupToken ? ['user:inference'] : ['user:inference', 'user:profile'],
    scope: setupToken ? 'user:inference' : 'user:inference user:profile',
    type: setupToken ? 'setup-token' : 'oauth',
    mode: setupToken ? 'setup-token' : 'oauth',
  }
}

/**
 * Convert a claude.ai session key (`sk-ant-sid…`) into slot credentials.
 *
 * The live chain needs the CookieAuth helper (see file header); without it this
 * throws `SessionOAuthUnavailableError` — callers surface it through
 * `panelImportErrorPayload`.
 */
export async function sessionKeyToOAuth(sessionKey, { scope = null, proxyUrl = null } = {}) {
  const key = String(sessionKey || '').trim()
  if (!SESSION_KEY_RE.test(key)) {
    throw Object.assign(new Error('sessionKey must look like sk-ant-sid…'), { code: 'invalid_request_error' })
  }
  if (process.env.KIN_FAKE_SESSION_OAUTH === '1') {
    return fakeCredential(key, { scope })
  }
  void proxyUrl
  throw new SessionOAuthUnavailableError()
}

/** CFFI fallback used by the authorize-code exchange path. */
export async function exchangeTokenViaCffi() {
  if (process.env.KIN_FAKE_SESSION_OAUTH === '1') {
    return fakeCredential('sk-ant-sid-fake-cffi', { scope: 'inference' })
  }
  throw new SessionOAuthUnavailableError()
}
