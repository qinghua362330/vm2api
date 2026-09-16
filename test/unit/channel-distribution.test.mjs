import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ChannelsRepo } from '../../src/lib/db/repos/channels-repo.mjs'
import { EgressBindingsRepo } from '../../src/lib/db/repos/egress-bindings-repo.mjs'
import {
  allowedEgressesForRequest,
  channelOverview,
  modelAllowedInChannel,
  priceForModel,
  resolveRequestChannel,
} from '../../src/lib/pool/channel-distribution.mjs'

/**
 * 渠道分发: a channel bounds which buckets a request may consume and prices
 * them. It must never select an account — that stays with the egress/slot/
 * session resolver, so the codebase keeps one dispatch model.
 */

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-channels-'))
  const db = createDatabase({ dataDir: dir })
  return { dir, db, repo: new ChannelsRepo(db), bindings: new EgressBindingsRepo(db) }
}

test('a channel groups buckets and prices models', () => {
  const { repo } = tmp()
  const channel = repo.create({ name: '主力渠道', description: '自建槽池' })
  assert.equal(channel.status, 'active')
  assert.equal(channel.restrict_models, false)

  const set = repo.setBuckets(channel.id, ['px-a', 'px-b'])
  assert.deepEqual(set.buckets, ['px-a', 'px-b'])
  assert.deepEqual(set.rejected, [])

  const pricing = repo.setPricing(channel.id, [
    { models: ['claude-sonnet-5'], input_price: 3, output_price: 15 },
    { models: [], input_price: 1 },
  ])
  assert.equal(pricing.length, 1, 'a pricing row with no models is meaningless')
  assert.deepEqual(pricing[0].models, ['claude-sonnet-5'])
})

test('a bucket belongs to at most one channel', () => {
  const { repo } = tmp()
  const first = repo.create({ name: 'A' })
  const second = repo.create({ name: 'B' })
  repo.setBuckets(first.id, ['px-a'])

  const clash = repo.setBuckets(second.id, ['px-a', 'px-c'])
  assert.deepEqual(clash.buckets, ['px-c'], 'the taken bucket is not stolen')
  assert.equal(clash.rejected.length, 1)
  assert.equal(clash.rejected[0].channel_id, first.id)
  assert.equal(repo.channelOfBucket('px-a'), first.id)
})

test('pricing matches dated model ids against their alias entry', () => {
  const { repo } = tmp()
  const channel = repo.create({ name: 'A' })
  repo.setPricing(channel.id, [{ models: ['claude-haiku-4-5'], input_price: 1 }])

  assert.equal(priceForModel(channel.id, 'claude-haiku-4-5', { repo })?.input_price, 1)
  assert.equal(priceForModel(channel.id, 'claude-haiku-4-5-20251001', { repo })?.input_price, 1)
  assert.equal(priceForModel(channel.id, 'claude-opus-5', { repo }), null)
})

test('restrict_models only gates when the channel turns it on', () => {
  const { repo } = tmp()
  const open = repo.create({ name: 'open' })
  const gated = repo.create({ name: 'gated', restrict_models: true })
  repo.setPricing(gated.id, [{ models: ['claude-sonnet-5'] }])

  assert.equal(modelAllowedInChannel(repo.get(open.id), 'anything', { repo }), true)
  assert.equal(modelAllowedInChannel(repo.get(gated.id), 'claude-sonnet-5', { repo }), true)
  assert.equal(modelAllowedInChannel(repo.get(gated.id), 'claude-opus-5', { repo }), false)
})

// ── distribution ────────────────────────────────────────────────────────────

test('a key channel wins over the user channels', () => {
  const { repo } = tmp()
  const a = repo.create({ name: 'A' })
  const b = repo.create({ name: 'B' })
  repo.addUser(b.id, 'u1')

  const fromUser = resolveRequestChannel({ userId: 'u1' }, { repo })
  assert.equal(fromUser.id, b.id)

  const fromKey = resolveRequestChannel({ apiKeyRecord: { channel_id: a.id }, userId: 'u1' }, { repo })
  assert.equal(fromKey.id, a.id, 'the key is more specific than the tenant grant')
})

test('a disabled channel resolves to nothing rather than half-serving', () => {
  const { repo } = tmp()
  const channel = repo.create({ name: 'A' })
  repo.addUser(channel.id, 'u1')
  repo.update(channel.id, { status: 'disabled' })

  assert.equal(resolveRequestChannel({ userId: 'u1' }, { repo }), null)
})

test('no channel leaves the request unconstrained (pre-channel behaviour)', () => {
  const { repo, bindings } = tmp()
  bindings.upsertEgressBinding({ userId: 'u1', egressId: 'px-a' })
  const scope = allowedEgressesForRequest({ userId: 'u1' }, { repo, bindingsRepo: bindings })
  assert.equal(scope.allowedEgressIds, null)
  assert.equal(scope.reason, 'no_channel')
})

test('the channel narrows the user buckets to the intersection', () => {
  const { repo, bindings } = tmp()
  const channel = repo.create({ name: 'A' })
  repo.setBuckets(channel.id, ['px-a', 'px-b'])
  repo.addUser(channel.id, 'u1')
  bindings.upsertEgressBinding({ userId: 'u1', egressId: 'px-b' })
  bindings.addBucket({ userId: 'u1', egressId: 'px-c' })

  const scope = allowedEgressesForRequest({ userId: 'u1' }, { repo, bindingsRepo: bindings })
  assert.deepEqual(scope.allowedEgressIds, ['px-b'], 'only buckets both sides agree on')
  assert.equal(scope.reason, 'channel_intersect')
})

test('a user granted nothing yet gets the channel as the grant', () => {
  const { repo, bindings } = tmp()
  const channel = repo.create({ name: 'A' })
  repo.setBuckets(channel.id, ['px-a', 'px-b'])
  repo.addUser(channel.id, 'u1')

  const scope = allowedEgressesForRequest({ userId: 'u1' }, { repo, bindingsRepo: bindings })
  assert.deepEqual(scope.allowedEgressIds, ['px-a', 'px-b'])
  assert.equal(scope.reason, 'channel_only')
})

test('an empty intersection denies instead of widening to the fleet', () => {
  const { repo, bindings } = tmp()
  const channel = repo.create({ name: 'A' })
  repo.setBuckets(channel.id, ['px-a'])
  repo.addUser(channel.id, 'u1')
  bindings.upsertEgressBinding({ userId: 'u1', egressId: 'px-z' })

  const scope = allowedEgressesForRequest({ userId: 'u1' }, { repo, bindingsRepo: bindings })
  assert.deepEqual(scope.allowedEgressIds, [])
  assert.equal(scope.reason, 'no_bucket_in_channel')
})

test('a channel with no buckets serves nothing', () => {
  const { repo, bindings } = tmp()
  const channel = repo.create({ name: 'A' })
  repo.addUser(channel.id, 'u1')
  const scope = allowedEgressesForRequest({ userId: 'u1' }, { repo, bindingsRepo: bindings })
  assert.deepEqual(scope.allowedEgressIds, [])
  assert.equal(scope.reason, 'channel_has_no_buckets')
})

test('overview reports buckets, users and pricing per channel', () => {
  const { repo } = tmp()
  const channel = repo.create({ name: 'A', rate_multiplier: 0.8 })
  repo.setBuckets(channel.id, ['px-a', 'px-b'])
  repo.addUser(channel.id, 'u1')
  repo.addUser(channel.id, 'u2')
  repo.setPricing(channel.id, [{ models: ['claude-sonnet-5'], input_price: 3 }])

  const [row] = channelOverview({ repo })
  assert.equal(row.name, 'A')
  assert.equal(row.bucket_count, 2)
  assert.equal(row.user_count, 2)
  assert.equal(row.pricing.length, 1)
  assert.equal(row.rate_multiplier, 0.8)
})

test('removing a channel releases its buckets for reuse', () => {
  const { repo } = tmp()
  const a = repo.create({ name: 'A' })
  const b = repo.create({ name: 'B' })
  repo.setBuckets(a.id, ['px-a'])
  repo.remove(a.id)

  const reassigned = repo.setBuckets(b.id, ['px-a'])
  assert.deepEqual(reassigned.buckets, ['px-a'])
  assert.equal(reassigned.rejected.length, 0)
  assert.equal(repo.get(a.id), null, 'soft deleted')
})

test('renaming does not duplicate a channel name', () => {
  const { repo } = tmp()
  repo.create({ name: 'A' })
  const b = repo.create({ name: 'B' })
  const updated = repo.update(b.id, { name: 'B2' })
  assert.equal(updated.name, 'B2')
  assert.equal(repo.get(b.id).name, 'B2')
})
