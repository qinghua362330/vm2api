/**
 * 部署前缀。
 *
 * 反代把控制台挂在子路径下（`leharrt.com/vm2api/` → 家宽 127.0.0.1:8787）时，浏览器
 * 发过来的每个请求都带前缀：`/vm2api/console`、`/vm2api/assets/…`、`/vm2api/api/panel/…`。
 * 与其给每个 handler 都加一遍前缀，不如在入口剥一次 —— 后面的路由照旧按 `/console`、
 * `/assets`、`/api` 匹配。
 *
 * 约定：前缀本身不参与路由（`/vm2api` 等价于 `/`）；没配前缀时函数原样返回，行为与
 * 以前完全一致。不带前缀的请求仍然可达（宽松），因为鉴权不在这一层 —— 少一层隐式 404
 * 比多一层更好排障。
 */

/** `/vm2api/` → `/vm2api`；`/`、空串、`vm2api` → 规范化；非法输入 → ''。 */
export function normalizeBasePath(raw) {
  const text = String(raw ?? '').trim()
  if (!text || text === '/') return ''
  const withSlash = text.startsWith('/') ? text : `/${text}`
  const trimmed = withSlash.replace(/\/+$/, '')
  return trimmed === '' ? '' : trimmed
}

/** 数组形式的前缀路径（`/vm2api` → `['/vm2api']`），便于与既有 path 列表比较。 */
export function basePathSegments(basePath) {
  const base = normalizeBasePath(basePath)
  return base ? [base] : []
}

/**
 * 剥掉前缀。`/vm2api` → `/`，`/vm2api/console` → `/console`，其余原样。
 */
export function stripBasePath(pathname, basePath) {
  const path = String(pathname ?? '/') || '/'
  const base = normalizeBasePath(basePath)
  if (!base) return path
  if (path === base) return '/'
  if (path.startsWith(`${base}/`)) return path.slice(base.length)
  return path
}
