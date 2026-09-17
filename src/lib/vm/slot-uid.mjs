import fs from 'node:fs'

/**
 * 槽内进程的 uid/gid。
 *
 * 槽容器以 `10000+序号:987` 运行（与 kin-os 镜像里的 kincli 组一致），所以宿主写下的
 * 任何槽要读的文件（kernel 配置、内部 token、凭证）都必须交给这个 uid —— 否则容器里
 * 读到的是 `Permission denied`，而宿主侧只看到"内核起不来"。
 *
 * 单独成模块是为了让 codex 运行时与 codex kernel 监督器共用同一份换算，不必互相 import。
 */

const UID_BASE = Number(process.env.KIN_VM_UID_BASE || 10000)
export const SLOT_GID = String(process.env.KIN_VM_GID || 987)

export function slotUidFor(vm) {
  const index = Number(String(vm?.id || '').replace(/\D+/g, '')) || 1
  return UID_BASE + index
}

export function slotUserFor(vm) {
  return `${slotUidFor(vm)}:${SLOT_GID}`
}

/** 把宿主写的文件交给槽的 uid；失败不抛（只读挂载/非 root 时尽力而为）。 */
export function chownForSlot(target, vm) {
  const file = String(target || '')
  if (!file) return false
  try {
    fs.chownSync(file, slotUidFor(vm), Number(SLOT_GID))
    return true
  } catch {
    return false
  }
}
