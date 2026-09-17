import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations, createDatabase } from '../../src/lib/db/database.mjs'
import { EgressBindingsRepo } from '../../src/lib/db/repos/egress-bindings-repo.mjs'

/**
 * 028 把两张绑定表按 kind 拆开（一个用户 = 每个凭证类型一套绑定）。
 *
 * 这一条测的是**升级路径**，不是新建路径：因为 user_id 原本是主键、改主键只能重建表
 * 再回填，重建写错就是静默丢数据 —— 而丢的是"这个用户的出口是哪台"，丢完只能等人
 * 发现 IP 变了。所以这里先建一个停在 027 的库、塞进真实形状的数据，再跑 028。
 */

const REAL_MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/lib/db/migrations')

function preUpgradeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kind-mig-'))
  const partial = path.join(dir, 'migrations-upto-027')
  fs.mkdirSync(partial, { recursive: true })
  for (const file of fs.readdirSync(REAL_MIGRATIONS)) {
    const version = Number(String(file).split('_')[0])
    if (!Number.isFinite(version) || version > 27) continue
    fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(partial, file))
  }
  const db = createDatabase({ dataDir: path.join(dir, 'data'), migrationsDir: partial })
  return { dir, db, partial }
}

test('028 重建表后旧数据仍在，且默认归到 claude', () => {
  const { dir, db } = preUpgradeDb()
  try {
    // 一个已经跑过一段时间的库：用户 u1 在 IP-A 上有主出口、两个桶、一个槽，
    // 并且有一条历史迁移记录。
    db.prepare(
      "INSERT INTO user_egress_bindings (user_id, egress_id, reason, bound_by, bound_at, updated_at) VALUES ('u1','proxy-a','auto',NULL,'2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z')",
    ).run()
    db.prepare(
      "INSERT INTO user_egress_buckets (user_id, egress_id, is_primary, reason, bound_by, bound_at, updated_at) VALUES ('u1','proxy-a',1,'auto',NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
    ).run()
    db.prepare(
      "INSERT INTO user_egress_buckets (user_id, egress_id, is_primary, reason, bound_by, bound_at, updated_at) VALUES ('u1','proxy-b',0,'auto',NULL,'2026-01-05T00:00:00.000Z','2026-01-05T00:00:00.000Z')",
    ).run()
    db.prepare(
      "INSERT INTO user_slot_bindings (user_id, slot_id, egress_id, reason, migrations, last_reason) VALUES ('u1','vm-a','proxy-a','auto',2,'quota_exhausted')",
    ).run()
    db.prepare(
      "INSERT INTO egress_migrations (user_id, egress_id, from_slot, to_slot, reason, detail, created_at) VALUES ('u1','proxy-a','vm-old','vm-a','quota_exhausted','5h window','2026-01-05T00:00:00.000Z')",
    ).run()

    applyMigrations(db, { migrationsDir: REAL_MIGRATIONS })

    const egress = db.prepare('SELECT * FROM user_egress_bindings WHERE user_id = ?').get('u1')
    assert.equal(egress.egress_id, 'proxy-a', 'the primary egress must survive the rebuild')
    assert.equal(egress.kind, 'claude')
    assert.equal(egress.bound_at, '2026-01-01T00:00:00.000Z')

    const buckets = db.prepare('SELECT * FROM user_egress_buckets WHERE user_id = ? ORDER BY egress_id').all('u1')
    assert.deepEqual(
      buckets.map((row) => `${row.egress_id}:${row.kind}:${row.is_primary}`),
      ['proxy-a:claude:1', 'proxy-b:claude:0'],
    )

    const slot = db.prepare('SELECT * FROM user_slot_bindings WHERE user_id = ?').get('u1')
    assert.equal(slot.slot_id, 'vm-a')
    assert.equal(slot.migrations, 2, 'migration counter must not reset')
    assert.equal(slot.last_reason, 'quota_exhausted')
    assert.equal(slot.kind, 'claude')

    const migration = db.prepare('SELECT * FROM egress_migrations WHERE user_id = ?').get('u1')
    assert.equal(migration.kind, 'claude')
    assert.equal(migration.detail, '5h window')

    // 每个 kind 一个 primary：同一个用户现在可以两类各有一行
    db.prepare(
      "INSERT INTO user_egress_bindings (user_id, kind, egress_id, reason) VALUES ('u1','codex','proxy-c','auto')",
    ).run()
    db.prepare(
      "INSERT INTO user_slot_bindings (user_id, kind, slot_id, egress_id, reason) VALUES ('u1','codex','vm-codex','proxy-c','auto')",
    ).run()
    db.prepare(
      "INSERT INTO user_egress_buckets (user_id, kind, egress_id, is_primary, reason) VALUES ('u1','codex','proxy-c',1,'auto')",
    ).run()
    // node:sqlite 返回 null-prototype 对象，比较前先摊成基本类型
    const rows = db
      .prepare('SELECT kind, egress_id FROM user_egress_bindings WHERE user_id = ? ORDER BY kind')
      .all('u1')
      .map((row) => `${row.kind}:${row.egress_id}`)
    assert.deepEqual(rows, ['claude:proxy-a', 'codex:proxy-c'])

    // 同一 kind 不能有两个 primary —— 索引必须跟着变成 (user_id, kind)
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO user_egress_buckets (user_id, kind, egress_id, is_primary, reason) VALUES ('u1','codex','proxy-d',1,'auto')",
        )
        .run(),
    )
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('两类的绑定互不可见（repo 取数按 kind 分开）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kind-repo-'))
  try {
    const db = createDatabase({ dataDir: path.join(dir, 'data') })
    const repo = new EgressBindingsRepo(db)
    repo.upsertEgressBinding({ userId: 'u1', egressId: 'proxy-a', kind: 'claude' })
    repo.upsertEgressBinding({ userId: 'u1', egressId: 'proxy-c', kind: 'codex' })
    repo.upsertSlotBinding({ userId: 'u1', slotId: 'vm-a', egressId: 'proxy-a', kind: 'claude' })
    repo.upsertSlotBinding({ userId: 'u1', slotId: 'vm-codex', egressId: 'proxy-c', kind: 'codex' })

    // 默认 kind=claude：既有调用点一行不改，也仍然只看得到 Claude 那一套
    assert.equal(repo.getEgressBinding('u1').egress_id, 'proxy-a')
    assert.equal(repo.getSlotBinding('u1').slot_id, 'vm-a')
    assert.equal(repo.getEgressBinding('u1', 'codex').egress_id, 'proxy-c')
    assert.equal(repo.getSlotBinding('u1', 'codex').slot_id, 'vm-codex')

    repo.addBucket({ userId: 'u1', egressId: 'proxy-b', kind: 'claude' })
    repo.addBucket({ userId: 'u1', egressId: 'proxy-d', kind: 'codex' })
    assert.deepEqual(
      repo.listBuckets('u1').map((bucket) => bucket.egress_id),
      ['proxy-a', 'proxy-b'],
    )
    assert.deepEqual(
      repo.listBuckets('u1', 'codex').map((bucket) => bucket.egress_id),
      ['proxy-c', 'proxy-d'],
    )

    // 槽上挂了几个人也要分 kind 数：codex 出口上的人不能被 Claude 侧看见
    repo.upsertSlotBinding({ userId: 'u3', slotId: 'vm-codex-2', egressId: 'proxy-c', kind: 'codex' })
    assert.equal(repo.listSlotBindingsByEgress('proxy-c').length, 0, 'claude 侧看不到 codex 出口上的人')
    assert.deepEqual(
      repo
        .listSlotBindingsByEgress('proxy-c', 'codex')
        .map((row) => row.user_id)
        .sort(),
      ['u1', 'u3'],
      'codex 侧两个用户都在，且互相独立',
    )
    assert.equal(repo.listSlotBindingsBySlot('vm-codex').length, 1, '按槽取人不受 kind 影响（槽本身只属于一类）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
