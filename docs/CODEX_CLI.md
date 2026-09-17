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

## 尚未做（下一步）

1. 槽内容器化：现在 CLI 跑在宿主（一槽一份 CODEX_HOME），下一步把它放进槽容器，
   拿到机器级指纹隔离；
2. 常驻 `codex app-server`（省掉每请求冷启动）；
3. codex 配额闸门（`GetAccountRateLimits`）与计费。
