# Codex 链：走真 CLI

这一页说明 GPT / Codex 这一跳怎么从"宿主机手写 HTTP 冒充 `codex_cli_rs`"变成
"驱动官方 Codex CLI"。

## 为什么

旧形态是 `crates/codex-kernel` 自己拼 HTTP，带一个写死的 UA
（`codex_cli_rs/0.153.4 (linux x86_64)`）去打上游。它能用，但"像"和"是"之间隔着一整套
请求序列、会话状态与遥测。真 CLI 把这些免费给到：真版本号、真请求形状、真重连与
速率限制处理。

## 形态

```
用户请求 → handle-codex.mjs（协议路由不变）
             ↓ 槽选择
        codex-cli-client.mjs（本仓新增的驱动）
             ↓ spawn，带 CODEX_HOME + ALL_PROXY
        真 codex CLI（官方 @openai/codex）
             ↓
        ChatGPT 后端（从槽绑定的 SOCKS5 出口出去）
```

`handle-codex.mjs` 的流式契约没变：驱动和内核同签名，都按 SSE 行回调，所以下游的
协议映射（`openai.chat` / `openai.completions` → `responsesSseToChatChunk`）一行没改。

## 开关

`src/config/routing.json`：

```json
"codex": { "enabled": true, "engine": "auto" }
```

| 值 | 行为 |
|---|---|
| `auto`（默认） | 有可执行的 `codex` 就走 CLI，没有就回退手写内核 |
| `cli` | 强制 CLI（没有二进制就 503，不会偷偷换引擎） |
| `http` | 强制旧内核 |

`auto` 时还可以用环境变量 `KIN_CODEX_ENGINE=cli|http` 覆盖（显式配置 > 环境变量 >
自动判断），e2e 靠它保证可重复。请求日志里 `via` 会写 `codex-cli` 或 `codex-kernel`，
`codex_engine` 与 `codex_thread_id` 也一并记录。

## 装 CLI

仓库不提交二进制（223MB，且 README 的规矩是二进制走 Release）：

```bash
node scripts/install-codex-cli.mjs                  # 当前平台
node scripts/install-codex-cli.mjs --platform linux-x64
```

装完 `bin/codex` 存在，`auto` 就会选 CLI。

## 一槽一份 CODEX_HOME

`vms/<vm-id>/codex-home/` 是这一跳的"我是谁"：

| 文件 | 作用 |
|---|---|
| `auth.json`（0600） | 凭证。`{OPENAI_API_KEY, tokens:{id_token, access_token, refresh_token, account_id}, last_refresh}` |
| `config.toml`（可选） | 只写显式给的键 —— CLI 有 `--strict-config`，猜 TOML 键会把能跑的槽变成起不来的槽 |

凭证由 `materializeCodexHome()` 在每次请求前从槽的 `vms/<id>/codex-credentials.json`
写入，宿主写、CLI 只读，和 Claude 侧"host writes credentials"是同一个套路。
`codexHomeStatus()` 只报"有没有、是哪种模式、account_id 是谁"，不回传 token。

## 出口

CLI 认 `HTTPS_PROXY` / `ALL_PROXY`（实测含其 WSS 上游），所以槽绑定的 SOCKS5 出口
直接喂给它：`proxyEnvFor()` 把 `socks5h://…` 写进 `ALL_PROXY`，http 代理写
`HTTPS_PROXY`。**没绑代理的槽会被拒绝**（503 `proxy_required`）—— 否则请求会从宿主
IP 出去，等于把身份换了。

## 会话续接

CLI 每次 `codex exec` 会给出 `thread.started.thread_id`；下一次请求带
`previous_response_id` 时驱动改跑 `codex exec resume <thread_id>`。默认加
`--ephemeral`（网关无状态，槽内不堆会话文件）。

## 事件翻译

CLI 的 JSONL → Responses SSE 都在 `codex-cli-client.mjs`：

| CLI 事件 | Responses SSE |
|---|---|
| `thread.started` | （记下 thread id） |
| `turn.started` | `response.created` + `response.in_progress` |
| `item.updated/started/completed`（`agent_message`） | `response.output_item.added` / `content_part.added` / `output_text.delta` / `...done` |
| `item.completed`（工具类 item） | `function_call` 输出项 |
| `turn.completed` | `response.completed`（带 usage） |
| `turn.failed` / `error` | `response.failed` |

两个坑写在代码注释里：`item.updated` 给的是**累计文本**（直接当 delta 会重复整段），
以及 `item.completed{type:error}` 是非致命提示（例如 skills 预算提示），不是请求失败。

## 健康探针

`codexDoctorStatus()` 跑 `codex doctor --json`（版本 / auth / 配置 / 网络，23 项检查），
可用于槽健康检查与"这个槽到底能不能用"的排查。

## 槽选择（复用 egress 那套）

`pickCodexVm()` 不再是"列表里第一个 codex 槽"：

- **master pin**（`x-kin-vm`）→ 用指定槽，pin 到 Claude 槽报 `platform_mismatch`；
- **有用户身份**（API key 带 user_id）→ `resolveUserDispatch(kind:'codex')`：
  用户绑定 → 桶 → 负载 → 迁移，和 Claude 侧同一套代码；
- **平台级调用** → 全池最空的 codex 槽（按挂人少的 egress 排）；
- 一律**不允许回退到本机共享 IP**（`allowDirect: false`）—— 真 CLI 从宿主机直连
  等于换掉槽的身份；
- 绑定层的错误**不让请求失败**：降到"全池挑一个能用的 codex 槽"，并把失败原因留在
  日志里（和 Claude 侧对 `userBinding` 的态度一致）。

### 绑定按凭证类型分开（028 迁移）

一个用户可能同时用 Claude 和 Codex，而槽的 IP 是槽自己带来的。如果两种凭证共用一行
绑定：用户原本的 Claude 出口在 IP-A，第一次走 Codex（槽在 IP-B）时迁移链会把 primary
改写成 IP-B —— **他的 Claude 出口跟着变了**。所以 028 把
`user_egress_bindings` / `user_egress_buckets` / `user_slot_bindings` 重建为
`(user_id, kind)` 主键，`egress_migrations` 加 `kind` 列，默认值 `'claude'` 让既有数据
与既有代码路径行为完全不变。Repo 的每个方法都多一个 `kind = 'claude'` 参数。

槽侧闸门也跟着按类型分派：`evaluateSlotGate(vm, { requireKind })` —— Claude 池要
claude 槽（codex 槽返回 `codex_vm`），Codex 池要 codex 槽（claude 槽返回 `claude_vm`），
默认不传保持原行为。

## 槽容器：与 Claude 槽同形

`src/lib/vm/codex-runtime.mjs` 让 codex 槽和 Claude 槽走同一条容器链 —— 同一套机器
身份、资源限制与网络规则，只有挂进去的东西不同：

| | Claude 槽 | codex 槽 |
|---|---|---|
| 镜像 | `kin-os/*`（按 `vm.kernel`） | 同一个 |
| 网络 | 槽绑 SOCKS5 的透明网络，无代理拒绝启动 | 同一条规则 |
| 机器身份 | `/etc/machine-id` + `/var/lib/dbus/machine-id` 只读挂载（`ensureGuestMachineIdFile`） | 同一个函数、同一个目标路径 |
| 资源限制 | 只读根、tmpfs、`--memory`/`--pids-limit`、`no-new-privileges`、`--cap-drop ALL` | 逐条相同 |
| 挂载 | `cli-home` → `/home/kincli` + `kin-kernel`/`kin-worker` | `codex-home` → `/home/kincli/.codex`（CODEX_HOME）+ `bin/codex` → `/usr/local/bin/codex:ro` |
| 容器内常驻 | `kin-kernel --gateway-worker`（PID 1） | `sleep infinity` 待命；CLI 由驱动 `docker exec -i` 进来跑 |
| kernel | 容器内 `kin-kernel`，config/socket 走 `/run/kin` | 容器内 `kin-codex-kernel`（`docker exec -d` 起，和 telemetry worker 同一种起法），config/socket 同样走 `/run/kin` |
| kernel 配置坐标 | `socket_path: /run/kin/kernel.sock`、`proxy_url: ''`、`proxy_required: false` | **同一套写法**：`/run/kin/codex-kernel.sock`、`proxy_url: ''`、`proxy_required: false`（容器里的 `127.0.0.1` 是它自己，宿主那串 SOCKS 地址进去只会连到自己；槽的出口由透明网络承担） |
| kernel 凭证 | `cli-home/.claude/credentials.json` | `codex-home/credentials.json`（kernel 自己的 accounts 格式，与 CLI 的 `auth.json` 分开、同级信任） |
| 建槽 | `/api/panel/vms/create` → `seedFreshCliHome` | 同一个路由，`kind=codex` → `seedCodexSlotHome`（只建空的 codex-home；凭证等导入或启动时宿主写） |

启动前 `preflightCodexSlot()` 会把缺的东西一次说清（`codex_bin` / `codex_credential_missing`
/ `slot_network` / `image_missing`），而不是 `docker run` 到一半才炸 —— 只读根 + 只读挂载
意味着缺一样都是启动后才发现。

凭证在槽启动时由宿主写进 `vms/<id>/codex-home/auth.json`（`ensureCodexSlotHome`），
与 Claude 侧"host writes credentials"一致；容器只读用。

驱动侧按容器是否在跑来选执行位置：容器在跑 → `docker exec -i <container> codex exec --json`；
没有容器 → 退回宿主进程（老环境不至于因此不可用）。

## 首次真机部署踩到并修掉的坑（都有测试）

| 症状 | 真因 |
|---|---|
| 槽选不中，报 `no_codex_slot` | `slotHasBoundProxy` 要求 Claude 专属的 `proxy_cli_enabled`；codex 槽只看绑定本身 |
| 代理明明配了却连不上 | `http://…` 行被解析成 `username='http'`（静默存坏记录）——现在显式拒绝并提示改 `socks5h://` |
| 内核起不来，只回 `health_timeout` | 容器漏挂 `/run/kin`；超时后改前台探一次，把 `config: No such file or directory` 带回来 |
| `Permission denied` 一串 | 宿主以 root 写的 home/配置/凭证没交给槽 uid（10000+序号:987） |
| 同上，凭证仍读不到 | 容器内路径被拿去 chown 宿主文件（静默失败）→ 宿主那份交给 `chownCodexHome()` |
| CLI 告警 `could not create PATH aliases` | 容器 `$HOME` 不可写：整份 home 挂到 `/home/kincli`，状态放 `.codex/` |
| `No prompt provided via stdin` | `codex exec … -` 是读 stdin，而 spawn 用了 `'ignore'` |
| 请求卡 5 分钟无输出 | 透明出口网关从没为 codex 起过，且 `ALL_PROXY` 造成双重代理 → 先 `ensureProxyEgress`，不再注入代理变量 |
| 客户端收到两条失败帧 | CLI 同时发 `error` 与 `turn.failed`，翻译层去重 |

## 模型清单是账号驱动的

`/v1/models` 里的 GPT 部分不是写死的策略表，而是导入凭证时（以及面板"同步目录"时）
由 `syncCodexCatalog()` 从 `chatgpt.com/backend-api/codex/models` 拉下来、写进
`gpt_model_policy`（`source: codex`）的。`luna` / `wm` 这类 slug 会被**故意过滤**——
Codex 账号请求它们会 400。

## 尚未做（下一步）

1. 常驻 `codex app-server`（省掉每请求冷启动）；
2. codex 配额闸门（`GetAccountRateLimits`）与计费；
3. 建槽向导里把类型做成显式选项（现在 `kind=codex` 已可用，前端入口还是"导入凭证"
   那条路）。
