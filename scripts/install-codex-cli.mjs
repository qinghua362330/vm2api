#!/usr/bin/env node
/**
 * 把官方 Codex CLI 落到 `bin/codex`。
 *
 * 为什么需要这一步：codex 链的 `auto` 引擎（routing.codex.engine）判断依据就是
 * "有没有可执行的 codex" —— 有就走真 CLI，没有才回退到手写 HTTP 内核。而这个仓
 * 自己不提交二进制（README 的规矩：二进制走 Release，不进 git），所以部署时要有
 * 一个可重复的获取方式。
 *
 * 用法：
 *   node scripts/install-codex-cli.mjs                 # 当前平台
 *   node scripts/install-codex-cli.mjs --platform linux-x64
 *   node scripts/install-codex-cli.mjs --version 0.154.0
 *
 * 只依赖 npm（不装全局包）：把 `@openai/codex` 的对应平台包下到临时目录，取里面的
 * 可执行文件复制到 bin/codex。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function argOf(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  return process.argv[index + 1] || fallback
}

function hostPlatform() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'linux') return `linux-${arch}`
  if (process.platform === 'darwin') return `darwin-${arch}`
  if (process.platform === 'win32') return `win32-${arch}`
  return null
}

const platform = String(argOf('platform', hostPlatform()) || '').trim()
const version = String(argOf('version', 'latest')).trim()
if (!platform) {
  console.error('无法判断平台，请显式传 --platform（linux-x64 / linux-arm64 / darwin-arm64 …）')
  process.exit(2)
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-install-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

try {
  console.log(`[codex-cli] 下载 @openai/codex@${version}（${platform}）…`)
  execFileSync(npm, ['install', '--no-audit', '--no-fund', '--prefix', workDir, `@openai/codex@${version}`], {
    stdio: 'inherit',
  })

  const vendorRoot = path.join(workDir, 'node_modules', '@openai')
  const candidates = []
  for (const entry of fs.existsSync(vendorRoot) ? fs.readdirSync(vendorRoot) : []) {
    const base = path.join(vendorRoot, entry, 'vendor')
    if (!fs.existsSync(base)) continue
    for (const triple of fs.readdirSync(base)) {
      const bin = path.join(base, triple, 'bin', 'codex')
      if (fs.existsSync(bin)) candidates.push(bin)
    }
  }
  if (!candidates.length) {
    console.error('[codex-cli] 没找到 codex 可执行文件，安装目录结构与预期不符')
    process.exit(1)
  }

  const dest = path.join(ROOT, 'bin', 'codex')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(candidates[0], dest)
  fs.chmodSync(dest, 0o755)
  const shown = execFileSync(dest, ['--version'], { encoding: 'utf8' }).trim()
  console.log(`[codex-cli] 已安装到 ${path.relative(ROOT, dest)}（${shown}）`)
  console.log('[codex-cli] routing.codex.engine = auto 现在会走真 CLI；要回退就设成 "http"。')
} finally {
  fs.rmSync(workDir, { recursive: true, force: true })
}
