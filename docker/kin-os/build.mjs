#!/usr/bin/env node
/** Build host-local kin-os slot images. The control-plane compose stack does not ship these. */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const images = [
  { tag: 'kin-os/ubuntu:24.04', dir: 'ubuntu-24.04' },
  { tag: 'kin-os/debian:12', dir: 'debian-12' },
  { tag: 'kin-os/arch:latest', dir: 'archlinux' },
  { tag: 'kin-os/fedora:41', dir: 'fedora-41' },
]
const only = process.argv.slice(2)

for (const img of images) {
  if (only.length && !only.some((arg) => img.tag.includes(arg) || img.dir.includes(arg))) continue
  const r = spawnSync('docker', ['build', '-t', img.tag, path.join(root, img.dir)], {
    stdio: 'inherit',
  })
  if (r.status !== 0) process.exit(r.status || 1)
}
