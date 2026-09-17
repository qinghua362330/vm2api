import test from 'node:test'
import assert from 'node:assert/strict'
import { cliFailureMessage } from '../../src/lib/transport/codex-cli-client.mjs'

/**
 * `codex exec` 失败时到底该报什么。
 *
 * 线上只回过一句 `codex exec failed`（事件和 stderr 都是空的），于是"上游说了什么"
 * 得进容器手跑 CLI 才知道。这个函数按可信度三级回退，别再把原因丢掉。
 */

test('优先用 CLI 自己的 error/turn.failed 原文', () => {
  assert.equal(
    cliFailureMessage({ state: { error: 'Selected model is at capacity. Please try a different model.' } }),
    'Selected model is at capacity. Please try a different model.',
  )
})

test('没有事件原文时用 stderr 尾部（多行收成一行，去掉空行）', () => {
  const message = cliFailureMessage({ stderr: 'line1\n\n  line2  \nline3\n' })
  assert.equal(message, 'line1 · line2 · line3')
})

test('stderr 也空时用 stdout 里那些不是 JSONL 的行', () => {
  const stdoutTail = '{"type":"session.created"}\nwarning: not logged in\n{"type":"x"}\n'
  assert.equal(cliFailureMessage({ stdoutTail }), 'warning: not logged in')
})

test('三样都没有才回退到 codex exec failed', () => {
  assert.equal(cliFailureMessage({}), 'codex exec failed')
  assert.equal(cliFailureMessage(), 'codex exec failed')
})

test('超长原文会被截断，不会把日志撑爆', () => {
  const message = cliFailureMessage({ state: { error: 'x'.repeat(5000) } })
  assert.equal(message.length, 800)
})
