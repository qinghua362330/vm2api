/**
 * Shared HTTP helpers for protocol and panel. SSE headers flush immediately
 * and optionally disable Nagle so Claude Code subagent tokens are not delayed.
 */
import { ErrorCode, ErrorType, makeError } from '../core/errors.mjs'

export const CORS_ALLOW_HEADERS =
  'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-session-id, x-kin-rewrite, x-panel-token, x-request-id, x-kin-debug, x-kin-log, x-kin-vm, x-kin-backend'

export function corsHeaders(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': CORS_ALLOW_HEADERS,
    'access-control-allow-methods': 'GET,POST,OPTIONS,PUT,DELETE,PATCH',
    ...extra,
  }
}

export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      req.removeAllListeners('data')
      req.on('data', () => {})
      req.resume()
      reject(error)
    }
    req.on('data', (c) => {
      if (settled) return
      size += c.length
      if (size > maxBytes) {
        fail(
          makeError({
            type: ErrorType.INVALID_REQUEST,
            code: ErrorCode.BODY_TOO_LARGE,
            message: `Request body exceeds limit of ${maxBytes} bytes`,
            status: 413,
            details: { max_bytes: maxBytes, received: size },
          }),
        )
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(
          makeError({
            type: ErrorType.INVALID_REQUEST,
            code: ErrorCode.INVALID_JSON,
            message: 'Request body is not valid JSON: ' + (e.message || 'parse error'),
            status: 400,
            details: { parse_error: String(e.message || e) },
          }),
        )
      }
    })
    req.on('error', (e) =>
      fail(
        makeError({
          type: ErrorType.API,
          code: 'request_stream_error',
          message: String(e.message || e),
          status: 400,
        }),
      ),
    )
  })
}

export function applySseSocketTuning(res, { tcpNodelay = true } = {}) {
  if (typeof res.flushHeaders === 'function') {
    try {
      res.flushHeaders()
    } catch {}
  }
  if (tcpNodelay !== false) {
    try {
      res.socket?.setNoDelay?.(true)
    } catch {}
  }
}

export function createRespond(cfg, options = {}) {
  const resolveNodelay = () => {
    if (typeof options.tcpNodelay === 'function') return options.tcpNodelay() !== false
    return options.tcpNodelay !== false
  }

  function json(res, status, body) {
    const data = JSON.stringify(body)
    const headers = corsHeaders({
      'content-type': 'application/json; charset=utf-8',
      'x-kin-rewrite': cfg.rewrite.enabled ? 'on' : 'off',
    })
    if (res._kinRequestId) headers['x-request-id'] = res._kinRequestId
    res.writeHead(status, headers)
    res.end(data)
  }

  function writeSSEHeaders(res) {
    const headers = corsHeaders({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-kin-rewrite': cfg.rewrite.enabled ? 'on' : 'off',
    })
    if (res._kinRequestId) headers['x-request-id'] = res._kinRequestId
    res.writeHead(200, headers)
    applySseSocketTuning(res, { tcpNodelay: resolveNodelay() })
  }

  return { json, writeSSEHeaders, readBody, corsHeaders }
}

/**
 * Read the request body as a string, without parsing.
 *
 * Signature verification needs the exact bytes: re-serialising JSON changes key
 * order and whitespace, and a Stripe HMAC over a re-serialised body never
 * matches. Form-encoded callbacks (易支付) are not JSON at all.
 */
export function readRawBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      req.removeAllListeners('data')
      req.on('data', () => {})
      req.resume()
      reject(error)
    }
    req.on('data', (c) => {
      if (settled) return
      size += c.length
      if (size > maxBytes) {
        fail(
          makeError({
            type: ErrorType.INVALID_REQUEST,
            code: ErrorCode.BODY_TOO_LARGE,
            message: `Request body exceeds limit of ${maxBytes} bytes`,
            status: 413,
            details: { max_bytes: maxBytes, received: size },
          }),
        )
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (e) =>
      fail(
        makeError({
          type: ErrorType.API,
          code: 'request_stream_error',
          message: String(e.message || e),
          status: 400,
        }),
      ),
    )
  })
}
