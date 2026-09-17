import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import {
  UserAttributes,
  matchesAttributeFilters,
  normalizeAttributeValue,
  normalizeKey,
} from '../../src/lib/admin/user-attributes.mjs'

/**
 * 用户属性：按类型校验，因为出错是安静的 —— select 存了不在候选项里的值、
 * number 存成文本后按字典序比较（'10' < '9'），都要到有人筛选时才会发现。
 */

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-attrs-'))
  const db = createDatabase({ dataDir: dir })
  const users = new UsersRepo(db)
  users.insert({ id: 'u1', username: 'u1', email: 'u1@t.local', password_hash: 'x', role: 'user' })
  users.insert({ id: 'u2', username: 'u2', email: 'u2@t.local', password_hash: 'x', role: 'user' })
  return { dir, db, attrs: new UserAttributes(db) }
}

// ── pure ────────────────────────────────────────────────────────────────────

test('normalizeKey slugs a display name into a stable key', () => {
  assert.equal(normalizeKey('渠道 来源'), '渠道_来源')
  assert.equal(normalizeKey('Source Channel!'), 'source_channel')
  assert.equal(normalizeKey('  --x--  '), 'x')
  assert.equal(normalizeKey(''), '')
})

test('a number must be clean, not merely parseable', () => {
  const def = { type: 'number', options: [] }
  assert.deepEqual(normalizeAttributeValue(def, '42'), { ok: true, value: '42', value_num: 42 })
  assert.equal(normalizeAttributeValue(def, '12abc').reason, 'not_a_number')
  assert.equal(normalizeAttributeValue(def, 'abc').reason, 'not_a_number')
  assert.equal(normalizeAttributeValue(def, 'Infinity').reason, 'not_a_number')
})

test('a select value outside its options is refused', () => {
  const def = { type: 'select', options: ['telegram', 'friend'] }
  assert.equal(normalizeAttributeValue(def, 'telegram').ok, true)
  const bad = normalizeAttributeValue(def, 'telegrm')
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'not_in_options', 'a typo would become an unfilterable row')
})

test('bool accepts common spellings and refuses the rest', () => {
  const def = { type: 'bool', options: [] }
  assert.equal(normalizeAttributeValue(def, 'yes').value, 'true')
  assert.equal(normalizeAttributeValue(def, '否').value, 'false')
  assert.equal(normalizeAttributeValue(def, 'maybe').reason, 'not_a_boolean')
})

test('date is normalised to ISO and keeps a sortable mirror', () => {
  const def = { type: 'date', options: [] }
  const out = normalizeAttributeValue(def, '2026-05-10')
  assert.equal(out.ok, true)
  assert.equal(out.value, new Date(Date.parse('2026-05-10')).toISOString())
  assert.equal(out.value_num, Date.parse('2026-05-10'))
  assert.equal(normalizeAttributeValue(def, 'not a date').reason, 'not_a_date')
})

test('an empty value clears rather than errors', () => {
  for (const type of ['text', 'number', 'select', 'date', 'bool']) {
    const out = normalizeAttributeValue({ type, options: ['a'] }, '')
    assert.equal(out.ok, true, `${type} should accept empty as clear`)
    assert.equal(out.value, null)
  }
  assert.equal(normalizeAttributeValue({ type: 'text', options: [] }, null).value, null)
})

test('an unknown attribute is refused', () => {
  assert.equal(normalizeAttributeValue(null, 'x').reason, 'unknown_attribute')
})

test('text is length-capped so a paste cannot become the whole table', () => {
  const out = normalizeAttributeValue({ type: 'text', options: [] }, 'x'.repeat(600))
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'too_long')
})

test('filters ignore blanks and reject missing values', () => {
  const bag = { source: 'telegram', vip: 'true' }
  assert.equal(matchesAttributeFilters(bag, { source: 'telegram' }), true)
  assert.equal(matchesAttributeFilters(bag, { source: '' }), true, 'a blank filter is no constraint')
  assert.equal(matchesAttributeFilters(bag, { source: 'friend' }), false)
  assert.equal(matchesAttributeFilters(bag, { missing: 'x' }), false)
  assert.equal(matchesAttributeFilters({}, {}), true)
})

// ── definitions ─────────────────────────────────────────────────────────────

test('a definition is created with a slugged key and rejects a bad select', () => {
  const { attrs } = tmp()
  const def = attrs.createDef({ name: '来源渠道', type: 'select', options: ['telegram', 'friend'], show_in_filter: true })
  assert.equal(def.key, '来源渠道', 'a non-Latin name still yields a usable key')
  assert.deepEqual(def.options, ['telegram', 'friend'])
  assert.equal(def.show_in_filter, true)

  assert.throws(() => attrs.createDef({ key: 'empty', type: 'select', options: [] }), /at least one option/)
})

test('an unknown type falls back to text rather than being stored', () => {
  const { attrs } = tmp()
  const def = attrs.createDef({ key: 'x', type: 'nonsense' })
  assert.equal(def.type, 'text')
  const patched = attrs.updateDef(def.id, { type: 'also-nonsense' })
  assert.equal(patched.type, 'text')
})

test('removing a definition drops its values', () => {
  const { attrs } = tmp()
  const def = attrs.createDef({ key: 'vip', type: 'bool' })
  attrs.setValues('u1', { vip: 'true' })
  assert.deepEqual(attrs.bagFor('u1'), { vip: 'true' })

  attrs.removeDef(def.id)
  assert.equal(attrs.getDef(def.id), null)
  assert.deepEqual(attrs.bagFor('u1'), {}, 'an orphaned value would keep filtering')
})

// ── values ──────────────────────────────────────────────────────────────────

test('values round-trip through the bag', () => {
  const { attrs } = tmp()
  attrs.createDef({ key: 'source', type: 'select', options: ['telegram', 'friend'] })
  attrs.createDef({ key: 'score', type: 'number' })

  const res = attrs.setValues('u1', { source: 'telegram', score: '42' })
  assert.equal(res.ok, true)
  assert.equal(res.rejected.length, 0)
  assert.deepEqual(attrs.bagFor('u1'), { source: 'telegram', score: '42' })
})

test('an unknown key or an invalid value is rejected, not stored', () => {
  const { attrs } = tmp()
  attrs.createDef({ key: 'source', type: 'select', options: ['telegram'] })

  const res = attrs.setValues('u1', { source: 'telegrm', nope: 'x' })
  assert.equal(res.ok, false)
  assert.equal(res.rejected.length, 2)
  assert.deepEqual(res.rejected.map((r) => r.reason).sort(), ['not_in_options', 'unknown_attribute'])
  assert.deepEqual(attrs.bagFor('u1'), {}, 'a rejected write must leave nothing behind')
})

test('setting an empty value clears it', () => {
  const { attrs } = tmp()
  attrs.createDef({ key: 'source', type: 'text' })
  attrs.setValues('u1', { source: 'telegram' })
  attrs.setValues('u1', { source: '' })
  assert.deepEqual(attrs.bagFor('u1'), {})
})

test('values are per user', () => {
  const { attrs } = tmp()
  attrs.createDef({ key: 'source', type: 'text' })
  attrs.setValues('u1', { source: 'telegram' })
  attrs.setValues('u2', { source: 'friend' })
  assert.equal(attrs.bagFor('u1').source, 'telegram')
  assert.equal(attrs.bagFor('u2').source, 'friend')

  const bags = attrs.bagsFor(['u1', 'u2'])
  assert.equal(bags.get('u1').source, 'telegram')
  assert.equal(bags.get('u2').source, 'friend')
})

test('setting a value twice overwrites rather than duplicating', () => {
  const { attrs } = tmp()
  attrs.createDef({ key: 'score', type: 'number' })
  attrs.setValues('u1', { score: '10' })
  attrs.setValues('u1', { score: '20' })
  assert.equal(attrs.bagFor('u1').score, '20')
})

test('numeric values keep a numeric mirror for range comparisons', () => {
  const { db, attrs } = tmp()
  const def = attrs.createDef({ key: 'score', type: 'number' })
  attrs.setValues('u1', { score: '9' })
  attrs.setValues('u2', { score: '10' })

  const rows = db
    .prepare('SELECT user_id, value_num FROM user_attribute_values WHERE attr_id = ? ORDER BY value_num DESC')
    .all(def.id)
  assert.deepEqual(rows.map((r) => r.user_id), ['u2', 'u1'], 'numeric order, not lexicographic')
})

test('an empty user id is refused', () => {
  const { attrs } = tmp()
  attrs.createDef({ key: 'x', type: 'text' })
  assert.equal(attrs.setValues('', { x: '1' }).reason, 'user_required')
})

test('overview lists definitions with the values actually in use', () => {
  const { attrs } = tmp()
  attrs.createDef({ key: 'source', type: 'select', options: ['telegram', 'friend', 'unused'], show_in_filter: true })
  attrs.createDef({ key: 'score', type: 'number' })
  attrs.setValues('u1', { source: 'telegram' })
  attrs.setValues('u2', { source: 'friend' })

  const overview = attrs.overview()
  const source = overview.find((d) => d.key === 'source')
  assert.deepEqual(source.used_values.sort(), ['friend', 'telegram'])
  const score = overview.find((d) => d.key === 'score')
  assert.deepEqual(score.used_values, [], 'only selects report used values')
})
