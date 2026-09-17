import { afterEach, describe, expect, it, vi } from 'vitest'
import { logoutRequest } from './api'
import { LS_BASE, LS_TOKEN, LS_USER, deployBasePath, hasSession, setApiBase, setSession } from './session'

function installBrowser(hostname: string) {
  const values = new Map<string, string>()
  vi.stubGlobal('location', { hostname, protocol: 'https:' })
  vi.stubGlobal('document', { cookie: '' })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
  return values
}

afterEach(() => vi.unstubAllGlobals())

describe('panel session storage', () => {
  it('uses the HttpOnly server cookie on same-origin deployments', () => {
    const values = installBrowser('ccmax20.cc')

    setSession('secret-token', 'admin')

    expect(values.get(LS_TOKEN)).toBeUndefined()
    expect(values.get(LS_USER)).toBe('admin')
    expect(hasSession()).toBe(true)
  })

  it('keeps the bearer fallback only for a separate API origin', () => {
    const values = installBrowser('localhost')
    setApiBase('https://ccmax20.cc')

    setSession('secret-token', 'admin')

    expect(values.get(LS_BASE)).toBe('https://ccmax20.cc')
    expect(values.get(LS_TOKEN)).toBe('secret-token')
  })

  it('calls the server logout endpoint without a readable bearer token', async () => {
    installBrowser('ccmax20.cc')
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    setSession('secret-token', 'admin')

    logoutRequest()

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/panel/logout')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
    })
  })
})

describe('deployBasePath（子路径部署）', () => {
  it('挂在根上时是空串 —— 接口不带前缀', () => {
    expect(deployBasePath('/')).toBe('')
    expect(deployBasePath('')).toBe('')
  })

  it('挂在子路径下时返回前缀（去掉尾斜杠）', () => {
    // Vite 的 base 带尾斜杠，请求前缀不能带，否则会拼出 //api/panel
    expect(deployBasePath('/vm2api/')).toBe('/vm2api')
    expect(deployBasePath('/a/b/')).toBe('/a/b')
  })
})
