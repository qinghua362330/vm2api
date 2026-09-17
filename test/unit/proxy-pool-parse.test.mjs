import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSocks5Line, parseSocks5Fields } from '../../src/lib/vm/proxy-pool.mjs'

test('recognizes host:port:user:pass vendor lines as socks5', () => {
  const parsed = parseSocks5Line('154.9.177.229:5509:howwaqev:lgg15vfswgy8')
  assert.equal(parsed.scheme, 'socks5')
  assert.equal(parsed.host, '154.9.177.229')
  assert.equal(parsed.port, 5509)
  assert.equal(parsed.username, 'howwaqev')
  assert.equal(parsed.password, 'lgg15vfswgy8')
})

test('recognizes user:pass@host:port and socks5 URLs', () => {
  const at = parseSocks5Line('howwaqev:lgg15vfswgy8@154.9.177.229:5509')
  assert.equal(at.host, '154.9.177.229')
  assert.equal(at.port, 5509)
  assert.equal(at.username, 'howwaqev')
  const url = parseSocks5Line('socks5h://howwaqev:lgg15vfswgy8@154.9.177.229:5509')
  assert.equal(url.host, '154.9.177.229')
  assert.equal(url.username, 'howwaqev')
})

test('recognizes user:pass:host:port and structured fields', () => {
  const flipped = parseSocks5Line('howwaqev:lgg15vfswgy8:154.9.177.229:5509')
  assert.equal(flipped.host, '154.9.177.229')
  assert.equal(flipped.port, 5509)
  assert.equal(flipped.username, 'howwaqev')
  const fields = parseSocks5Fields({
    host: '154.9.177.229',
    port: '5509',
    username: 'howwaqev',
    password: 'secret',
  })
  assert.equal(fields.scheme, 'socks5')
  assert.equal(fields.port, 5509)
  assert.equal(fields.username, 'howwaqev')
})

test('rejects incomplete or non-proxy lines', () => {
  assert.equal(parseSocks5Line(''), null)
  assert.equal(parseSocks5Line('# comment'), null)
  assert.equal(parseSocks5Line('154.9.177.229'), null)
  assert.equal(parseSocks5Fields({ host: '154.9.177.229' }), null)
})

test('http:// 行要明确拒绝，不能把 "http" 当用户名存进去', () => {
  // 线上踩到的：导入 http://user:pass@host:port 时掉进了 user:pass@host:port 分支，
  // 存成 username='http'、password='//user:pass' —— 记录看着正常，连不上，
  // 而且没有任何报错指向真正的原因。
  const parsed = parseSocks5Line('http://bp-abc:secret@38.109.193.59:6023')
  assert.equal(parsed.host, undefined, 'must not produce a usable record')
  assert.equal(parsed.reason, 'unsupported_scheme')
  assert.match(parsed.hint, /socks5h:\/\//)

  // 同一行改成 socks5h 就能正常解析（多数代理同一端口同时开 SOCKS5）
  const socks = parseSocks5Line('socks5h://bp-abc:secret@38.109.193.59:6023')
  assert.equal(socks.scheme, 'socks5')
  assert.equal(socks.username, 'bp-abc')
  assert.equal(socks.password, 'secret')
  assert.equal(socks.port, 6023)
})
