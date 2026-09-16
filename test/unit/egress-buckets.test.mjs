import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { EgressBindingsRepo } from '../../src/lib/db/repos/egress-bindings-repo.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import {
  resolveUserDispatch,
  userBucketEgressIds,
  userBucketSlots,
} from '../../src/lib/pool/egress-binding.mjs'

/**
 * A user may hold several buckets; a conversation pins to one of them.
 *
 *   user    ──N──► bucket (egress/IP)
 *   session ──1──► slot (sticky_sessions)
 *
 * The user binding bounds what a conversation may use; the session binding keeps
 * one conversation on one credential. Neither may silently override the other.
 */

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-buckets-'))
  const db = createDatabase({ dataDir: dir })
  return { dir, db, repo: new EgressBindingsRepo(db) }
}

function slot(id, proxyId) {
  return {
    id,
    name: id,
    status: 'running',
    schedulable: true,
    platform: 'claude',
    family: 'claude',
    claude: { has_access: true, has_refresh: true, account_uuid: `acct-${id}` },
    proxy_cli_enabled: true,
    proxy: { id: proxyId, host: '127.0.0.1', port: 1080, url: 'socks5h://127.0.0.1:1080' },
  }
}

test('a user may hold several buckets with exactly one primary', () => {
  const { repo } = tmp()
  repo.upsertEgressBinding({ userId: 'u1', egressId: 'px-a' })
  assert.deepEqual(userBucketEgressIds('u1', { repo }), ['px-a'])

  repo.addBucket({ userId: 'u1', egressId: 'px-b' })
  assert.deepEqual(userBucketEgressIds('u1', { repo }), ['px-a', 'px-b'], 'primary first')
  assert.equal(repo.getEgressBinding('u1').egress_id, 'px-a', 'primary binding unchanged')

  repo.setPrimaryBucket({ userId: 'u1', egressId: 'px-b' })
  assert.deepEqual(userBucketEgressIds('u1', { repo }), ['px-b', 'px-a'])
  assert.equal(repo.getEgressBinding('u1').egress_id, 'px-b', 'primary binding follows')
})

test('removing the primary promotes another bucket instead of leaving none', () => {
  const { repo } = tmp()
  repo.upsertEgressBinding({ userId: 'u1', egressId: 'px-a' })
  repo.addBucket({ userId: 'u1', egressId: 'px-b' })

  const res = repo.removeBucket({ userId: 'u1', egressId: 'px-a' })
  assert.equal(res.removed, true)
  assert.deepEqual(userBucketEgressIds('u1', { repo }), ['px-b'])
  assert.equal(repo.listBuckets('u1').filter((b) => b.is_primary).length, 1)

  repo.removeBucket({ userId: 'u1', egressId: 'px-b' })
  assert.deepEqual(userBucketEgressIds('u1', { repo }), [])
})

test('an admin rebind keeps the old bucket rather than dropping it', () => {
  const { repo } = tmp()
  repo.upsertEgressBinding({ userId: 'u1', egressId: 'px-a' })
  repo.upsertEgressBinding({ userId: 'u1', egressId: 'px-b', reason: 'admin' })
  // rebinding changes which bucket is primary; it does not silently revoke the
  // other one — that is an explicit removeBucket
  assert.deepEqual(userBucketEgressIds('u1', { repo }), ['px-b', 'px-a'])
})

test('bucket slots exclude egresses the user does not hold', () => {
  const { repo } = tmp()
  const vms = [slot('vm-01', 'px-a'), slot('vm-02', 'px-b'), slot('vm-03', 'px-c')]
  repo.upsertEgressBinding({ userId: 'u1', egressId: 'px-a' })
  repo.addBucket({ userId: 'u1', egressId: 'px-b' })

  assert.deepEqual(
    userBucketSlots({ userId: 'u1', vms }, { repo }).sort(),
    ['vm-01', 'vm-02'],
  )
  assert.deepEqual(userBucketSlots({ userId: 'nobody', vms }, { repo }), [])
})

test('dispatch reports the bucket set the session pin must stay inside', () => {
  const { repo } = tmp()
  const vms = [slot('vm-01', 'px-a'), slot('vm-02', 'px-b')]
  const first = resolveUserDispatch({ userId: 'u1', vms }, { repo })
  assert.equal(first.ok, true)
  assert.deepEqual(first.allowedEgressIds, [first.egressId])

  repo.addBucket({ userId: 'u1', egressId: first.egressId === 'px-a' ? 'px-b' : 'px-a' })
  const again = resolveUserDispatch({ userId: 'u1', vms }, { repo })
  assert.equal(again.allowedEgressIds.length, 2)
})

// ── session pinning through the sticky router ───────────────────────────────

function router(db, onSessionMove = null) {
  return new StickyRouter({ db, config: { enabled: true, ttl_seconds: 86400 }, onSessionMove })
}

test('a conversation keeps its slot and egress across turns', () => {
  const { db } = tmp()
  const sticky = router(db)

  sticky.bind('conv-1', { accountId: 'acct-a', vmId: 'vm-01', userId: 'u1', egressId: 'px-a' })
  const first = sticky.resolve('conv-1')
  assert.equal(first.vmId, 'vm-01')
  assert.equal(first.userId, 'u1')
  assert.equal(first.egressId, 'px-a')

  // a later turn hits the same key and must see the same credential
  const second = sticky.resolve('conv-1')
  assert.equal(second.vmId, 'vm-01')
  assert.equal(second.accountId, 'acct-a')
})

test('two conversations of one user may live in different buckets', () => {
  const { db } = tmp()
  const sticky = router(db)
  sticky.bind('conv-a', { accountId: 'acct-a', vmId: 'vm-01', userId: 'u1', egressId: 'px-a' })
  sticky.bind('conv-b', { accountId: 'acct-b', vmId: 'vm-02', userId: 'u1', egressId: 'px-b' })

  assert.equal(sticky.resolve('conv-a').egressId, 'px-a')
  assert.equal(sticky.resolve('conv-b').egressId, 'px-b')
  assert.equal(sticky.repo.countByEgress()['px-a'], 1)
  assert.equal(sticky.repo.countByEgress()['px-b'], 1)
  assert.equal(sticky.repo.listByUser('u1').length, 2)
})

test('moving a conversation to another slot is reported for audit', () => {
  const { db } = tmp()
  const moves = []
  const sticky = router(db, (info) => moves.push(info))

  sticky.bind('conv-1', { accountId: 'acct-a', vmId: 'vm-01', userId: 'u1', egressId: 'px-a' })
  assert.equal(moves.length, 0, 'the first bind is not a move')

  sticky.bind('conv-1', { accountId: 'acct-b', vmId: 'vm-02', userId: 'u1', egressId: 'px-b' })
  assert.equal(moves.length, 1)
  assert.deepEqual(moves[0], {
    key: 'conv-1',
    userId: 'u1',
    fromVmId: 'vm-01',
    toVmId: 'vm-02',
    fromEgressId: 'px-a',
    toEgressId: 'px-b',
  })
})

test('re-binding the same conversation to the same slot is not a move', () => {
  const { db } = tmp()
  const moves = []
  const sticky = router(db, (info) => moves.push(info))
  const pin = { accountId: 'acct-a', vmId: 'vm-01', userId: 'u1', egressId: 'px-a' }
  sticky.bind('conv-1', pin)
  sticky.bind('conv-1', pin)
  assert.equal(moves.length, 0, 'same slot twice is not a move')
  // hits count the turns served by the pin; resolve() must not inflate them
  const hits = sticky.resolve('conv-1').hits
  assert.equal(hits, 2)
  assert.equal(sticky.resolve('conv-1').hits, hits, 'resolve is read-only')
})

test('the sticky store carries tenant and egress through a re-open', () => {
  const { dir, db } = tmp()
  const sticky = router(db)
  sticky.bind('conv-1', { accountId: 'acct-a', vmId: 'vm-01', userId: 'u1', egressId: 'px-a' })

  // a fresh repo over the same file sees the same pin (no in-memory state)
  const reopened = new EgressBindingsRepo(createDatabase({ dataDir: dir }))
  assert.ok(reopened)
  const again = router(db).resolve('conv-1')
  assert.equal(again.userId, 'u1')
  assert.equal(again.egressId, 'px-a')
})
