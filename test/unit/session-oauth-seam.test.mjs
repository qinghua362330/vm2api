import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  sessionKeyToOAuth,
  shouldTryNextImportHelper,
  classifyImportHelperOutput,
  publicImportError,
  panelImportErrorPayload,
  buildSetupTokenAuthorizeURL,
  extractOAuthCodeFromRedirect,
} from '../../scripts/session-to-oauth.mjs'

test('KIN_FAKE_SESSION_OAUTH returns deterministic creds without network', async () => {
  process.env.KIN_FAKE_SESSION_OAUTH = '1'
  const cred = await sessionKeyToOAuth('sk-ant-sid-test-aaaaaaaa')
  assert.equal(cred.source, 'KIN_FAKE_SESSION_OAUTH')
  assert.equal(cred.email, 'fake-oauth@kin.test')
  assert.match(cred.access_token, /^sk-ant-oat01-FAKE/)
  assert.ok(cred.expires_at > Math.floor(Date.now() / 1000))
  delete process.env.KIN_FAKE_SESSION_OAUTH
})

test('fake inference scope is setup-token', async () => {
  process.env.KIN_FAKE_SESSION_OAUTH = '1'
  const cred = await sessionKeyToOAuth('sk-ant-sid-test-aaaaaaaa', { scope: 'inference' })
  assert.equal(cred.type, 'setup-token')
  assert.equal(cred.mode, 'setup-token')
  delete process.env.KIN_FAKE_SESSION_OAUTH
})

test('fake branch still rejects non-sid keys', async () => {
  process.env.KIN_FAKE_SESSION_OAUTH = '1'
  await assert.rejects(() => sessionKeyToOAuth('not-a-sid'), /sk-ant-sid/)
  delete process.env.KIN_FAKE_SESSION_OAUTH
})

test('only missing helper or CF may try the next TLS stack', () => {
  assert.equal(shouldTryNextImportHelper('cloudflare_challenge'), true)
  assert.equal(shouldTryNextImportHelper('no_cookie_auth_bin'), true)
  assert.equal(shouldTryNextImportHelper('no_cffi_helper'), true)
  assert.equal(shouldTryNextImportHelper('cookie_auth_failed'), false)
  assert.equal(shouldTryNextImportHelper('session_stale_relogin'), false)
  assert.equal(shouldTryNextImportHelper('permission_error'), false)
})

test('authorize 403 session freshness is not reported as Cloudflare', () => {
  const raw =
    '[1/5] GET /api/organizations impersonate=chrome146 [2/5] authorize failed: 403 {"type":"error","error":{"type":"permission_error","message":"Session is not fresh enough'
  assert.equal(classifyImportHelperOutput(raw), 'session_stale_relogin')
  assert.match(publicImportError(raw), /不够新/)
  assert.doesNotMatch(publicImportError(raw), /Cloudflare|Just a moment/)
})

test('panel import catch maps helper codes without leaking ReferenceError', () => {
  const stale = panelImportErrorPayload({
    message: 'Session is not fresh enough to authorize',
  })
  assert.equal(stale.status, 400)
  assert.equal(stale.error.code, 'session_stale_relogin')
  assert.match(stale.error.message, /不够新/)

  const coded = panelImportErrorPayload({ code: 'session_stale_relogin', message: 'Session is not fresh enough' })
  assert.equal(coded.status, 400)
  assert.equal(coded.error.code, 'session_stale_relogin')
})

test('panel import route binds sessionKey helpers', () => {
  const src = fs.readFileSync(new URL('../../src/lib/admin/panel-routes.mjs', import.meta.url), 'utf8')
  assert.match(src, /sessionKeyToOAuth/)
  assert.match(src, /panelImportErrorPayload/)
  assert.match(src, /from '\.\.\/\.\.\/\.\.\/scripts\/session-to-oauth\.mjs'/)
})

test('Portunex CookieAuth uses platform JSON authorize and Chrome 146 token UA', (t) => {
  const pyPath = new URL('../../scripts/session-import-cffi.py', import.meta.url)
  // The CookieAuth helper is intentionally not distributed with the public
  // snapshot. Assert on it only where it exists, instead of reddening the suite.
  if (!fs.existsSync(pyPath)) {
    t.skip('session-import-cffi.py is not part of the public snapshot')
    return
  }
  const src = fs.readFileSync(new URL('../../scripts/session-to-oauth.mjs', import.meta.url), 'utf8')
  const py = fs.readFileSync(pyPath, 'utf8')
  assert.match(src, /PLATFORM\}\/v1\/oauth\/\$\{orgUUID\}\/authorize/)
  assert.match(src, /Chrome\/146\.0\.0\.0/)
  assert.match(src, /POST chrome token/)
  assert.doesNotMatch(src, /axios\/1\.13\.4/)
  assert.match(src, /claude_cli\/bootstrap/)
  assert.match(src, /grove_enabled/)
  assert.match(src, /Origin: 'https:\/\/claude\.com'/)
  assert.match(py, /PLATFORM\}\/v1\/oauth\/\{org_uuid\}\/authorize/)
  assert.match(py, /Chrome\/146\.0\.0\.0/)
  assert.match(py, /POST chrome token/)
  assert.doesNotMatch(py, /axios\/1\.13\.4/)
  assert.match(py, /claude_cli\/bootstrap/)
  assert.match(py, /grove_enabled/)
  assert.match(py, /origin="https:\/\/claude\.com"/)
  assert.match(py, /skip bootstrap\/grove for inference setup-token/)
})

test('setup-token CAI URL helper stays inference-only', () => {
  const url = buildSetupTokenAuthorizeURL('st', 'ch')
  assert.match(url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true/)
  assert.match(url, /client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e/)
  assert.match(url, /scope=user%3Ainference/)
  assert.ok(!url.includes('user:profile'))
})

test('extractOAuthCodeFromRedirect reads callback query', () => {
  const got = extractOAuthCodeFromRedirect('https://platform.claude.com/oauth/code/callback?code=abc123&state=xyz')
  assert.equal(got.code, 'abc123')
  assert.equal(got.state, 'xyz')
  assert.equal(extractOAuthCodeFromRedirect({ redirect_uri: 'https://x.test/?code=tok#state=s' }).code, 'tok')
  assert.equal(extractOAuthCodeFromRedirect('https://x.test/nope'), null)
})

test('authorize_no_code is a 400 not Cloudflare', () => {
  assert.equal(classifyImportHelperOutput('authorize_no_code login_redirect'), 'authorize_no_code')
  assert.match(publicImportError('authorize_no_code login_redirect'), /CAI 授权页/)
  const payload = panelImportErrorPayload({ code: 'authorize_no_code', message: 'authorize_no_code' })
  assert.equal(payload.status, 400)
  assert.equal(payload.error.code, 'authorize_no_code')
})
