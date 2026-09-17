import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBasePath, stripBasePath } from '../../src/lib/http/base-path.mjs'

/**
 * 子路径部署（反代 /vm2api/ → 127.0.0.1:8787）。
 *
 * 这类前缀最容易出的错是"剥一半"：`/vm2api/console` 变成 `//console` 或者只剥了
 * `/vm2api` 而漏了 `assets`，表现是控制台白屏、接口 404 —— 所以边界值全钉住。
 */

test('normalizeBasePath：斜杠、空串、缺前导斜杠都收敛到同一形状', () => {
  assert.equal(normalizeBasePath('/vm2api'), '/vm2api')
  assert.equal(normalizeBasePath('/vm2api/'), '/vm2api')
  assert.equal(normalizeBasePath('vm2api'), '/vm2api')
  assert.equal(normalizeBasePath('  /a/b//  '), '/a/b')
  assert.equal(normalizeBasePath('/'), '')
  assert.equal(normalizeBasePath(''), '')
  assert.equal(normalizeBasePath(null), '')
})

test('stripBasePath：前缀、前缀下的路径、以及不带前缀的请求', () => {
  assert.equal(stripBasePath('/vm2api', '/vm2api'), '/')
  assert.equal(stripBasePath('/vm2api/', '/vm2api'), '/')
  assert.equal(stripBasePath('/vm2api/console', '/vm2api'), '/console')
  assert.equal(stripBasePath('/vm2api/assets/index.js', '/vm2api'), '/assets/index.js')
  assert.equal(stripBasePath('/vm2api/api/panel/login', '/vm2api'), '/api/panel/login')
  // 没配前缀 = 原样（老部署行为不变）
  assert.equal(stripBasePath('/console', ''), '/console')
  assert.equal(stripBasePath('/console', '/'), '/console')
  // 仅仅是前缀同名前缀的路径不能被误剥：/vm2apix 不是 /vm2api 下的路径
  assert.equal(stripBasePath('/vm2apix/console', '/vm2api'), '/vm2apix/console')
  // 不带前缀的请求仍然可达（鉴权不在这层，少一层隐式 404 更好排障）
  assert.equal(stripBasePath('/health', '/vm2api'), '/health')
  assert.equal(stripBasePath('/', '/vm2api'), '/')
})
