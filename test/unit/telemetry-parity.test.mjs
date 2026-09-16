import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildFullEnvJson, deploymentEnvironmentFor } from '../../src/lib/identity/telemetry-env.mjs'

/**
 * `deployment_environment` used to be derived twice with different rules:
 * telemetry-env.mjs returned '' for non-Linux while the Go sidecar always
 * produced "unknown-<platform>". The sidecar is what actually ships telemetry,
 * so the two disagreed on every darwin/win32 persona.
 *
 * Cases below must stay in lockstep with
 * worker/internal/telemetry/event_test.go TestDeploymentEnvironmentMatchesNodeRule.
 */
const CASES = [
  { platform: 'linux', explicit: '', want: 'unknown-linux' },
  { platform: 'darwin', explicit: '', want: 'unknown-darwin' },
  { platform: 'win32', explicit: '', want: 'unknown-win32' },
  { platform: '', explicit: '', want: 'unknown-linux' },
  { platform: 'linux', explicit: 'prod', want: 'prod' },
  { platform: 'darwin', explicit: 'unknown-linux', want: 'unknown-linux' },
]

test('deploymentEnvironmentFor mirrors the Go sidecar rule', () => {
  for (const c of CASES) {
    assert.equal(
      deploymentEnvironmentFor(c.platform, c.explicit),
      c.want,
      `platform=${c.platform} explicit=${c.explicit}`,
    )
  }
})

test('buildFullEnvJson emits the shared value, never the old empty string', () => {
  assert.equal(buildFullEnvJson({ platform: 'linux' }).deployment_environment, 'unknown-linux')
  assert.equal(buildFullEnvJson({ platform: 'darwin' }).deployment_environment, 'unknown-darwin')
  assert.equal(buildFullEnvJson({}).deployment_environment, 'unknown-linux')
  assert.equal(
    buildFullEnvJson({ platform: 'darwin', deployment_environment: 'captured-value' }).deployment_environment,
    'captured-value',
  )
})

test('no caller still derives deployment_environment on its own', () => {
  const root = new URL('../../', import.meta.url)
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'web') continue
      const full = `${dir}${entry.name}${entry.isDirectory() ? '/' : ''}`
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.mjs')) continue
      const src = fs.readFileSync(full, 'utf8')
      // A local ternary/fallback that re-derives the value is the bug we just fixed.
      if (/deployment_environment\s*:\s*[^,\n]*\?\s*'unknown-linux'/.test(src)) {
        offenders.push(fileURLToPath(full))
      }
    }
  }
  walk(fileURLToPath(root))
  assert.deepEqual(offenders, [], 'deployment_environment must come from deploymentEnvironmentFor()')
})

test('the Go sidecar exposes the explicit override field', () => {
  const cfg = fs.readFileSync(
    new URL('../../worker/internal/config/config.go', import.meta.url),
    'utf8',
  )
  const ev = fs.readFileSync(
    new URL('../../worker/internal/telemetry/event.go', import.meta.url),
    'utf8',
  )
  assert.match(cfg, /DeploymentEnvironment\s+string\s+`json:"deployment_environment"`/)
  assert.match(ev, /strings\.TrimSpace\(id\.DeploymentEnvironment\)/)
  assert.match(ev, /deploy = "unknown-" \+ platform/)
})
