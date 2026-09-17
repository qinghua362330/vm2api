const LS_TOKEN = 'kin_console_token'
const LS_USER = 'kin_console_user'
const LS_BASE = 'kin_api_base'
const COOKIE = 'kin_panel_token'

export { LS_TOKEN, LS_USER, LS_BASE, COOKIE }

export function sameOriginPanel(host = location.hostname): boolean {
  return /^(ccmax20\.cc|www\.ccmax20\.cc|kin\.fkcodex\.com)$/i.test(host || '')
}

/**
 * 部署前缀（构建期的 Vite base，例如 /vm2api/）。挂在子路径下时，面板接口也必须带
 * 同样的前缀，否则请求会打到域名根上的别的服务。挂在根上时为 ''。
 */
export function deployBasePath(
  raw: string = String(
    (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL || '/'
  )
): string {
  const trimmed = String(raw || '/').replace(/\/+$/, '')
  return trimmed === '' ? '' : trimmed
}

export function apiBase(): string {
  const host = location.hostname || ''
  if (sameOriginPanel(host)) return ''
  const saved = (localStorage.getItem(LS_BASE) || '').replace(/\/$/, '')
  if (saved) return saved
  if (/vercel\.app$|netlify\.app$|github\.io$|grok\.me$/i.test(host)) {
    return 'https://ccmax20.cc'
  }
  // 子路径部署：与页面同源但带前缀，接口跟着前缀走
  return deployBasePath()
}

export function setApiBase(base: string) {
  const trimmed = base.trim().replace(/\/$/, '')
  if (sameOriginPanel() || !trimmed) {
    localStorage.removeItem(LS_BASE)
    return
  }
  localStorage.setItem(LS_BASE, trimmed)
}

function clearClientCookie(name: string) {
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`
}

export function sessionToken(): string {
  return (localStorage.getItem(LS_TOKEN) || '').trim()
}

export function hasSession(): boolean {
  return Boolean(sessionToken() || storedUser())
}

export function setSession(token: string, user?: string) {
  clearClientCookie(COOKIE)
  clearClientCookie('kin_console_token')
  if (token && apiBase()) localStorage.setItem(LS_TOKEN, token)
  else localStorage.removeItem(LS_TOKEN)
  if (user) localStorage.setItem(LS_USER, user)
}

export function clearSession() {
  localStorage.removeItem(LS_TOKEN)
  localStorage.removeItem(LS_USER)
  clearClientCookie(COOKIE)
  clearClientCookie('kin_console_token')
}

export function storedUser(): string {
  return localStorage.getItem(LS_USER) || ''
}
