import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 未声明变量扫描。
 *
 * 这条测试来自一次真实事故：`panel-routes.mjs` 里有 33 处 `audit(req, …)` 调用，
 * 而 `audit` 从来没有被定义过 —— 每个写了审计的路由都会 ReferenceError。语法检查
 * 通不过不了这种错误，单测也发现不了（没人调用那些路由），只有真的点到那个页面才
 * 会 500。biome 的 noUndeclaredVariables 能在静态阶段抓住它，所以把它固化成门禁。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('no module uses an undeclared variable', (t) => {
  const bin = path.join(repoRoot, 'node_modules', '.bin', 'biome')
  if (!fs.existsSync(bin)) {
    // Honest skip: without the binary there is nothing to assert, and a silent
    // pass would be worse than a visible one.
    t.skip('biome is not installed (run npm install)')
    return
  }
  const result = spawnSync(
    bin,
    [
      'lint',
      '--only=correctness/noUndeclaredVariables',
      '--config-path=./biome.undeclared.json',
      'src',
      'test',
      'scripts',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  const output = `${result.stdout || ''}${result.stderr || ''}`
  assert.equal(
    result.status,
    0,
    `undeclared variables found:\n${
      output
        .split('\n')
        .filter((line) => line.includes('noUndeclaredVariables'))
        .join('\n') || output
    }`,
  )
})
