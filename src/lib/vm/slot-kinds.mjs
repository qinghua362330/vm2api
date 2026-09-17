/**
 * 这套部署"真的能服务"哪种槽。
 *
 * 为什么需要它（都是分发 key 时踩出来的）：
 *   - 只有 codex 槽的部署里，Claude 形状的请求回的是"号池负载过高，稍后再试" ——
 *     那是"还有账号、只是排队"的话术，客户端会一直重试一条不可能成功的路；
 *   - `/v1/models` 把两种模型都列出来，客户端照着列表选，必然撞上做不了的模型。
 *
 * 判据是"有槽 **且** 有该类型的凭证"：只按 `platform/family` 判断会把一个空的种子
 * 槽（比如 vm-01，anthropic 但没导过凭证）当成"有 Claude 服务"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getVm, listVms, vmHasClaudeCredential } from './vm-registry.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { readCodexAccounts } from './codex-slot.mjs'

export function servableSlotKinds(projectRoot) {
  const out = {
    /** 真能服务的类型 */
    kinds: new Set(),
    /** 槽文件数量（按类型） */
    slots: { claude: 0, codex: 0 },
    /** 其中带凭证的数量（按类型） */
    withCredential: { claude: 0, codex: 0 },
    /** 槽目录读不到 = 不知道（调用方应退回老行为，别下结论） */
    readable: true,
  }
  // 目录都不在 = 读不到（`listVms` 对不存在的路径只会安静地回空数组，
  // 那会被误读成"这套部署一个槽都没有"）
  if (!projectRoot || !fs.existsSync(path.join(projectRoot, 'vms'))) {
    out.readable = false
    return out
  }
  let summaries = []
  try {
    summaries = listVms(projectRoot)
  } catch {
    out.readable = false
    return out
  }
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    if (!summary?.id) continue
    const vm = getVm(projectRoot, summary.id) || summary
    const codex = isCodexVm(vm)
    const key = codex ? 'codex' : 'claude'
    out.slots[key] += 1
    const hasCredential = codex
      ? readCodexAccounts(projectRoot, vm.id).some((account) =>
          String(account?.access_token || account?.refresh_token || '').trim(),
        )
      : vmHasClaudeCredential(vm)
    if (hasCredential) {
      out.withCredential[key] += 1
      out.kinds.add(key)
    }
  }
  return out
}
