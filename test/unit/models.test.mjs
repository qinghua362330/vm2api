import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  isCatalogModelId,
  latestIdForFamily,
  resolveCatalogModel,
  setModelCatalog,
  ingestWorkerModels,
  validateOfficialModel,
  clearModelsCache,
  gatewayModelCatalog,
  SEED_MODEL_IDS,
  getCatalogIds,
} from '../../src/lib/protocol/models.mjs'
import { seedDefaultPolicy } from '../../src/lib/protocol/model-policy.mjs'

test('isCatalogModelId rejects fragments', () => {
  assert.equal(isCatalogModelId('claude-sonnet-5'), true)
  assert.equal(isCatalogModelId('claude-fable-5.1'), true)
  assert.equal(isCatalogModelId('claude-3'), false)
  assert.equal(isCatalogModelId('claude-fable-5.md'), false)
  assert.equal(isCatalogModelId('claude-haiku-'), false)
})

test('alias resolves to latest non-fast catalog id', () => {
  const ids = ['claude-sonnet-4-6', 'claude-sonnet-5', 'claude-sonnet-5-fast', 'claude-opus-4-8', 'claude-opus-5']
  assert.equal(latestIdForFamily('sonnet', ids), 'claude-sonnet-5')
  assert.equal(latestIdForFamily('opus', ids), 'claude-opus-5')
  assert.equal(resolveCatalogModel('sonnet', ids).model, 'claude-sonnet-5')
  const opus1m = resolveCatalogModel('opus[1m]', ids)
  assert.equal(opus1m.model, 'claude-opus-5')
  assert.equal(opus1m.want1m, true)
})

test('haiku calling aliases resolve to the dated catalog id', () => {
  setModelCatalog(['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001', 'claude-fable-5'])
  assert.equal(resolveCatalogModel('claude-haiku-4-5').ok, true)
  assert.equal(resolveCatalogModel('claude-haiku-4-5').model, 'claude-haiku-4-5-20251001')
  assert.equal(validateOfficialModel('claude-haiku-4-5').ok, true)
  assert.equal(validateOfficialModel('claude-haiku-4-5').model, 'claude-haiku-4-5-20251001')
  assert.equal(validateOfficialModel('anthropic/claude-haiku-4-5').model, 'claude-haiku-4-5-20251001')
  assert.equal(validateOfficialModel('haiku').model, 'claude-haiku-4-5-20251001')
  clearModelsCache()
})

test('validateOfficialModel only accepts the loaded catalog', () => {
  setModelCatalog(['claude-sonnet-5', 'claude-opus-4-6', 'claude-haiku-4-5-20251001', 'claude-fable-5'])
  assert.equal(validateOfficialModel('anthropic/claude-sonnet-5').ok, true)
  assert.equal(validateOfficialModel('anthropic/claude-sonnet-5').model, 'claude-sonnet-5')
  assert.equal(validateOfficialModel('openrouter/anthropic/claude-opus-4-6').model, 'claude-opus-4-6')
  assert.equal(validateOfficialModel('sonnet').model, 'claude-sonnet-5')
  assert.equal(validateOfficialModel('gpt-4o').ok, false)
  assert.equal(validateOfficialModel('claude-made-up-99').ok, false)
  assert.equal(validateOfficialModel('claude-opus-4-1').ok, false)
  clearModelsCache()
})

test('empty catalog rejects unresolved ids; validate seeds from model-policy', () => {
  clearModelsCache()
  const r = resolveCatalogModel('claude-sonnet-5', [])
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'catalog_unavailable')
  assert.equal(validateOfficialModel('claude-sonnet-5').ok, true)
  assert.equal(validateOfficialModel('claude-opus-5').ok, true)
  assert.equal(validateOfficialModel('claude-made-up-99').ok, false)
  clearModelsCache()
})

test('ingestWorkerModels merges worker list responses into the catalog', () => {
  clearModelsCache()
  ingestWorkerModels({ object: 'list', data: [{ id: 'claude-sonnet-5' }, { id: 'not-a-model' }] })
  ingestWorkerModels({ data: ['claude-opus-4-6'] })
  assert.deepEqual(getCatalogIds().sort(), ['claude-opus-4-6', 'claude-sonnet-5'])
  assert.equal(validateOfficialModel('claude-made-up-99').ok, false)
  clearModelsCache()
})

test('seed catalog matches the console model-policy matrix including opus-5', () => {
  const expected = Object.keys(seedDefaultPolicy().models || {}).sort()
  assert.deepEqual([...SEED_MODEL_IDS].sort(), expected)
  assert.ok(SEED_MODEL_IDS.includes('claude-opus-5'))
  assert.ok(SEED_MODEL_IDS.includes('claude-sonnet-5'))
  assert.ok(SEED_MODEL_IDS.includes('claude-fable-5'))
  assert.ok(SEED_MODEL_IDS.includes('claude-fable-5.1'))
  clearModelsCache()
  const cat = gatewayModelCatalog()
  const ids = cat.data.map((m) => m.id)
  assert.ok(ids.includes('claude-opus-5'))
  assert.ok(ids.includes('claude-fable-5.1'))
  assert.equal(validateOfficialModel('claude-opus-5').ok, true)
  assert.equal(validateOfficialModel('opus').ok, true)
  assert.equal(validateOfficialModel('opus').model, 'claude-opus-5')
  assert.equal(validateOfficialModel('claude-fable-5.1').ok, true)
  clearModelsCache()
})

test('claude-fable-5.1 shares fable-5 policy params', () => {
  const seed = seedDefaultPolicy()
  const a = seed.models['claude-fable-5']
  const b = seed.models['claude-fable-5.1']
  assert.equal(b.family, 'fable')
  assert.deepEqual(b.params, a.params)
  assert.deepEqual(b.capabilities, a.capabilities)
  assert.equal(b.betas.pass_context_1m, a.betas.pass_context_1m)
})

test('gatewayModelCatalog stays local and never hops', () => {
  clearModelsCache()
  const cat = gatewayModelCatalog()
  assert.equal(cat.source, 'model-policy')
  assert.equal(cat.object, 'list')
  assert.ok(Array.isArray(cat.data))
  assert.ok(cat.data.length > 0)
  const ids = cat.data.map((m) => m.id)
  assert.ok(
    ids.some((id) => /^gpt-/i.test(id)),
    JSON.stringify(ids.slice(0, 12)),
  )
  assert.ok(
    ids.some((id) => String(id).startsWith('claude-')),
    JSON.stringify(ids.slice(0, 12)),
  )
  const src = fs.readFileSync(new URL('../../src/server.mjs', import.meta.url), 'utf8')
  assert.equal(src.includes('callWorkerGet'), false)
  // 目录必须本地算（不 hop）。现在会带上"这套部署真有哪种槽"做过滤，
  // 所以匹配调用本身，并额外确认过滤确实接上了。
  assert.match(src, /gatewayModelCatalog\(/)
  assert.match(src, /kinds: availableSlotKinds\(\)/)
})

test('models module never talks to Anthropic or a CLI binary', () => {
  const src = fs.readFileSync(new URL('../../src/lib/protocol/models.mjs', import.meta.url), 'utf8')
  assert.equal(src.includes('api.anthropic.com'), false)
  assert.equal(src.includes('oauth-2025-04-20'), false)
  assert.equal(src.includes('spawnSync'), false)
  assert.equal(src.includes('child_process'), false)
  assert.equal(/user-agent.*claude-cli/.test(src), false)
})

test('目录按"真有哪种槽"过滤：codex-only 部署不列 Claude 模型', () => {
  const codexOnly = gatewayModelCatalog({ kinds: new Set(['codex']) })
  const ids = codexOnly.data.map((m) => m.id)
  assert.ok(ids.length > 0)
  assert.ok(
    ids.every((id) => !String(id).startsWith('claude-')),
    JSON.stringify(ids),
  )
  assert.ok(ids.some((id) => /^gpt-/i.test(id)))
  assert.deepEqual(codexOnly.slot_kinds, ['codex'])

  const both = gatewayModelCatalog({ kinds: new Set(['claude', 'codex']) })
  assert.ok(both.data.some((m) => String(m.id).startsWith('claude-')))

  // 老调用方（不传 kinds）保持全量，行为不变
  const unfiltered = gatewayModelCatalog()
  assert.equal(unfiltered.slot_kinds, undefined)
  assert.ok(unfiltered.data.some((m) => String(m.id).startsWith('claude-')))
})
