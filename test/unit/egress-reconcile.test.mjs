import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileSlotEgress } from '../../src/lib/vm/egress.mjs'

/**
 * 控制面重启会带走 `kin-egress`（它是控制面进程的 detached 子进程），而槽容器是
 * `--restart unless-stopped`，照旧在跑 —— 结果是"槽在跑、面板健康、槽里所有出站
 * 指向一个没人监听的端口"，表现为 codex CLI 一直重连到超时。开机对账就是为了
 * 把这个静默状态修回来，所以它必须：只碰在跑且绑了代理的槽，且幂等。
 */

const running = (id, proxyId = 'px-1') => ({
  id,
  status: 'running',
  proxy: { id: proxyId, host: '127.0.0.1', port: 1080, username: 'u', password: 'p' },
})

test('给在跑且绑了代理的槽重新确保出口', () => {
  const calls = []
  const rows = reconcileSlotEgress('/p', [running('vm-01'), running('vm-03')], {
    ensure: (projectRoot, proxy) => {
      calls.push([projectRoot, proxy.id])
      return { ok: true, reused: true, network: `kin-eg-${proxy.id}` }
    },
  })
  assert.deepEqual(calls, [
    ['/p', 'px-1'],
    ['/p', 'px-1'],
  ])
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => r.ok && r.reused))
  assert.equal(rows[0].network, 'kin-eg-px-1')
})

test('没在跑的槽、没绑代理的槽都不碰', () => {
  const calls = []
  const rows = reconcileSlotEgress(
    '/p',
    [
      { id: 'vm-01', status: 'stopped', proxy: { id: 'px-1' } },
      { id: 'vm-02', status: 'running', proxy: null },
      { id: 'vm-03', status: 'RUNNING', proxy: { id: 'px-2' } },
    ],
    {
      ensure: (_root, proxy) => {
        calls.push(proxy.id)
        return { ok: true }
      },
    },
  )
  assert.deepEqual(calls, ['px-2'])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].vm_id, 'vm-03')
})

test('单个槽失败不影响其它槽，也不抛出去', () => {
  const rows = reconcileSlotEgress('/p', [running('vm-01', 'px-1'), running('vm-03', 'px-2')], {
    ensure: (_root, proxy) => {
      if (proxy.id === 'px-1') throw new Error('docker unavailable')
      return { ok: true }
    },
  })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].ok, false)
  assert.match(rows[0].error, /docker unavailable/)
  assert.equal(rows[1].ok, true)
})

test('空输入不炸（没有槽的机器）', () => {
  assert.deepEqual(reconcileSlotEgress('/p', null, { ensure: () => ({ ok: true }) }), [])
  assert.deepEqual(reconcileSlotEgress('/p', [], { ensure: () => ({ ok: true }) }), [])
})
