# Pi 0.83.0 公共接口复核

- 调研日期：2026-08-03（Asia/Shanghai）
- 目标：在 Task 4 开始前重新核验 Pi 的固定候选、npm 制品身份与公开 Extension、JSON、RPC、SDK 接口
- 来源范围：仅使用 Pi 官方 GitHub Release、固定 tag/commit 下的文档与源码，以及 npm registry 的包元数据与 provenance
- 排除项：未运行 Pi、未安装包、未登录、未读取凭据、未调用模型或 Provider、未产生付费请求
- 证据边界：本文是上游研究，不是 `CapabilityProbeReceipt`、本机 Evidence 或 Windows/Ubuntu PASS

## 1. 结论

1. **[事实]** 截至本次复核，GitHub 最新非 draft、非 prerelease Release 和 npm `latest` 都是 `0.83.0`。Tag `v0.83.0`、Release commit、npm `gitHead` 均指向 `845d6ff1f6643aba440341cce877ce1c43ebbc39`。
2. **[决策]** Task 4 有意保留初始候选 `@earendil-works/pi-coding-agent@0.83.0`，同时冻结 npm integrity 与上述 commit；没有上游事实支持改用另一个候选。
3. **[工程推论]** Extension、JSON、RPC 和 SDK 的公开接口足以继续固定版本 Spike；目前没有发现需要 Pi 源码补丁或 Fork ADR 的明确接口阻断。
4. **[NOT_PROVEN]** “接口存在”不等于 Hunter Pi 能可靠地启动、观察、中断、恢复或清理真实 Pi。Core Extension 身份与有效工具图、RPC 取消后的子进程树、Session 恢复、Windows/Ubuntu 行为都必须由临时 Git fixture 的 Task 4 探针证明。
5. **[事实 + 边界]** Pi 的 `agent_end`、`agent_settled`、RPC `success: true`、SDK `prompt()` resolve、进程退出和 JSON exit code 都不是 Hunter Step success。Hunter 成功仍只能来自自己的 Verification 或精确 Human Receipt。

## 2. 状态标记

- **[事实]**：固定官方来源直接表达或固定源码直接实现的行为。
- **[工程推论]**：从官方事实推导出的 Hunter Pi 实施含义，不是 Pi 上游承诺。
- **[NOT_PROVEN]**：必须由 Hunter Pi 本机、fixture 或 CI 实测才能成立；本文不得签发 `SUPPORTED` 或 `PASS`。
- **[决策]**：本次研究对 Task 4 候选的有意选择，不代表候选已通过资格验证。

## 3. 固定候选与 npm 制品

| 项目 | 复核结果 | 来源 |
|---|---|---|
| 最新稳定 Release | `v0.83.0`，发布于 `2026-07-29T22:30:33Z` | [官方 Release](https://github.com/earendil-works/pi/releases/tag/v0.83.0) |
| Tag commit | `845d6ff1f6643aba440341cce877ce1c43ebbc39` | [固定 commit](https://github.com/earendil-works/pi/commit/845d6ff1f6643aba440341cce877ce1c43ebbc39) |
| npm 包 | `@earendil-works/pi-coding-agent@0.83.0`；npm `latest=0.83.0` | [0.83.0 registry metadata](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/0.83.0)、[dist-tags](https://registry.npmjs.org/-/package/@earendil-works%2fpi-coding-agent/dist-tags) |
| npm identity | npm `gitHead` 与 tag commit 相同 | [0.83.0 registry metadata](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/0.83.0) |
| npm integrity | `sha512-uYhF+FsZxogoSX/AxBcUdiY+ZklubwaXyAoEGA2eQwsHcyEAhUYIKh/WLXe/a8+k8eTCmxb+ZN2Zo9mzQtzbWw==` | [0.83.0 registry metadata](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/0.83.0) |
| npm SHA-1 shasum | `c7382fd5e2958b75fdc2313eae67e9f6d12ac690` | [0.83.0 registry metadata](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/0.83.0) |
| npm provenance | registry 声明 SLSA provenance，resolved dependency 指向同一 tag/commit | [npm attestations](https://registry.npmjs.org/-/npm/v1/attestations/@earendil-works%2fpi-coding-agent@0.83.0) |
| Node 运行要求 | `>=22.19.0`；ESM；命令 `pi -> dist/cli.js` | [固定 package.json](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/package.json) |
| 包导出 | 根导出 `.`，另有 `./rpc-entry` | [固定 package.json](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/package.json#L1-L29) |
| Windows 附加要求 | Pi 的 Bash 工具需要 Bash；依次查自定义 `shellPath`、Git Bash、PATH 上的 Bash | [Windows setup](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/windows.md#L1-L17) |

**[事实]** Node 24 满足该 npm 制品的最低 Node 版本。`0.83.0` Release 同时包含 TypeBox `1.3.7` 的 breaking change，移除了多项弃用 API，因此 Core Extension 必须针对这个精确制品重新编译和运行，不能沿用旧版兼容结论。[v0.83.0 Breaking Changes](https://github.com/earendil-works/pi/releases/tag/v0.83.0)

**[NOT_PROVEN]** registry 报告的 integrity、provenance 和上游 Release 身份尚未成为 Hunter Pi 本机安装 Evidence。Task 4 必须通过 lockfile、实际解析版本和实际安装树对账；也不能把 npm 包验证混称为 standalone Release binary 已验证。

## 4. Extension 生命周期与有效工具图

### 4.1 生命周期

**[事实]** Extension 是同步或异步 factory。异步 factory 在启动继续前被 await，早于 `session_start`、`resources_discover` 和排队的 Provider 注册 flush。[Extension factory](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L154-L182)

**[事实]** 固定版本公开的关键顺序是：

```text
project_trust
  → session_start
  → resources_discover
  → input
  → before_agent_start
  → agent_start
  → turn_start
  → context / provider hooks
  → tool_execution_start
  → tool_call
  → tool_execution_update
  → tool_result
  → tool_execution_end
  → turn_end
  → agent_end
  → agent_settled
```

`new`、`resume` 和 `fork` 会先触发旧实例的 `session_shutdown`，再为替换后的 Session 重新建立 Extension 实例并触发新的 `session_start`。[Lifecycle Overview](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L273-L348)、[固定事件类型](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/types.ts#L519-L663)

**[事实]** `agent_end` 后仍可能有自动 retry、compaction 或排队 continuation；`agent_settled` 只说明 Pi 不再自动继续。[Agent events](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L519-L646)

**[工程推论]** Core Extension 可以在 `session_start` 发送版本化 handshake，并在每次 replacement/reload 后重建绑定；Hunter Host 不能永久持有旧 Extension context 或把 `agent_settled` 翻译成完成。

### 4.2 工具拦截和 inventory

**[事实]** `tool_call` 在执行前触发，可 block 或原地修改输入；修改后 Pi 不重新做 schema validation。默认并行工具模式中，同一 assistant message 的 sibling calls 先顺序 preflight，再并行执行，因此一个 `tool_call` 不保证看见 sibling 的结果。`tool_result` 可修改 `content`、`details`、`isError` 和 `usage`，并可能按完成顺序交错。[Tool events](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L749-L846)

**[事实]** 固定源码声明七个可用内建工具：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`；SDK 默认激活前四个。[工具源码](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/tools/index.ts#L81-L164)、[SDK 默认工具](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/sdk.ts#L245-L250)

**[事实]** Extension 可动态注册工具，也可用同名定义覆盖内建工具。`getActiveTools()` 返回当前激活名称；`getAllTools()` 返回所有已配置工具的 `name`、`description`、`parameters`、`promptGuidelines` 和 `sourceInfo`，可区分 builtin、SDK 与 Extension 来源。[Tool inventory API](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L1624-L1649)、[Override built-ins](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L2022-L2043)

**[事实]** `pi.appendEntry(customType, data)` 可保存不进入模型上下文的 Extension 状态；`AgentSessionEvent` 包含可由外层观察的 `entry_appended`。[Extension actions](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/types.ts#L1281-L1326)、[AgentSessionEvent](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/agent-session.ts#L138-L181)

**[工程推论]** Core Extension 可用“Hunter 预先计算的 Extension artifact digest + Extension 自身版本 + `getActiveTools()` + `getAllTools().sourceInfo`”形成 handshake，再由 Host 映射为 Hunter receipt。Pi 本身不会自动签发 Core artifact 的密码学身份证明，所以该设计仍须探针验证。

**[NOT_PROVEN]** 固定 Core Extension 是否实际加载、是否被 shadow、handshake 是否能绑定精确 artifact、有效工具图是否在工具动态变化后保持可追踪，都没有在本文执行。

## 5. JSON mode

**[事实]** `pi --mode json` 是 single-shot print mode：stdout 首先写 Session header，之后把订阅到的每个 `AgentSessionEvent` 写成一行 JSON。[JSON mode](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/json.md)、[print-mode 实现](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/modes/print-mode.ts#L90-L127)

**[事实：同一 tag 内文档漂移]** `docs/json.md` 展示的 `AgentSessionEvent` 列表不完整；固定源码还包含 `agent_settled`、`entry_appended`、`session_info_changed`、`thinking_level_changed` 和 `bash_execution_update`。Task 4 必须按固定源码/导出类型和实测输出冻结解析器，不能复制 Markdown 列表后假设穷尽。[固定 AgentSessionEvent](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/agent-session.ts#L138-L181)

**[事实]** JSON mode 没有 stdin command/cancel 协议。固定实现只在 text mode 根据末条 assistant 的 `error`/`aborted` stop reason 把 exit code 设为 1；JSON 分支不会执行这个判断。[print-mode exit handling](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/modes/print-mode.ts#L125-L151)

**[工程推论]** JSON mode 适合 one-shot Observation 收集，不适合作为可中断的长期 Host 控制通道。JSON exit `0`、`agent_end` 或 `agent_settled` 都只能记录为 Observation。

## 6. RPC framing、相关性与取消

**[事实]** RPC 通过 stdin/stdout 传输 JSONL：stdin 一行一个 command，stdout 混合 response 与流式 event。所有 command 可带可选 `id`，response 回显相同 `id`；普通 Agent events 不带 originating request id，只有 direct RPC bash 的 update 带其 command id。[RPC overview](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/rpc.md#L20-L37)

**[事实]** framing 只以 LF (`\n`) 为记录分隔符；输入可去掉 LF 前的 CR。Node `readline` 会额外按 JSON 字符串中合法的 `U+2028`/`U+2029` 拆分，因此不符合协议。[严格 JSONL 源码](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/modes/rpc/jsonl.ts#L1-L59)

**[事实]** `prompt` response 的 `success: true` 仅表示 prompt 已被接受、排队或由 Extension 立即处理。接受后的失败通过 event/message stream 报告，不会为同一 request id 再发第二个 response。[RPC prompt](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/rpc.md#L43-L78)

**[事实]** command 输入可以并发处理，所以 response/event 可能交错；客户端必须按唯一 `id` 关联 response，不能依赖响应顺序。[RPC input handling](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L747-L807)

**[事实]** `abort` 取消当前 Agent operation，并在 `session.abort()` 等待 Agent idle 后返回；direct RPC `bash` 有独立的 `abort_bash`。`RpcCommand` 的 `abort` 不接受目标 prompt/request id，因此它不是 request-scoped cancellation。[RPC command types](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/modes/rpc/rpc-types.ts#L20-L73)、[AgentSession abort](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/agent-session.ts#L1539-L1553)

**[事实]** 没有 documented RPC `shutdown` command；stdin EOF 进入 runtime shutdown/dispose 路径。[RPC mode](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L718-L816)

**[工程推论]** Hunter Host 应限制每个 RPC Agent process 同时只有一个可变 Agent operation，把 Hunter operation id 与 RPC request id 记入自己的 journal；direct bash 必须走单独的取消/对账路径。上游没有 Hunter operation fingerprint、幂等 Receipt 或 replay cursor，这些职责仍属于 Host。

**[NOT_PROVEN]** `abort` acknowledgement 之后是否没有迟到 event、是否终止了全部工具子进程、EOF/dispose 是否在 Windows 与 Ubuntu 完成精确清理，必须实测。

## 7. SDK Session、事件、持久化与恢复

**[事实]** npm 包根入口公开导出 `AgentSession`、`AgentSessionEvent`、`createAgentSession`、`AgentSessionRuntime`、runtime factories、`SessionManager`、`RpcClient` 与 run modes；Task 4 不需要导入私有源码路径。[公共导出](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/index.ts#L1-L25)、[SDK/Session exports](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/index.ts#L194-L247)、[RPC exports](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/index.ts#L326-L344)

**[事实]** `createAgentSession()` 返回 `AgentSession`；公开操作包括 `prompt`、`steer`、`followUp`、`subscribe`、`abort`、`dispose`。`prompt()` 对被接受的普通 prompt 会等完整 run（含 retry）结束才 resolve，但接受后的失败仍体现在 event/message stream，不会变成 preflight rejection。[SDK core concepts](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/sdk.md#L16-L114)、[Prompt behavior](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/sdk.md#L180-L234)

**[事实]** Extension command 在普通模型/API key 验证前处理；因此 Core probe command 可以在不登录 Provider 的情况下覆盖部分 Session/Extension 路径。正常模型 prompt 仍会检查 model 与认证。[AgentSession prompt preflight](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/agent-session.ts#L1110-L1195)

**[事实]** new/resume/fork/import 的 Session replacement 位于 `AgentSessionRuntime`。替换后 `runtime.session` 指向新 Session，调用方需要重新绑定 Session 订阅；Extension 也经历 shutdown 和重新实例化。[SDK runtime](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/sdk.md#L114-L178)

**[事实]** `SessionManager` 公开 `create`、`open`、`continueRecent`、`inMemory`、`forkFrom`、`list` 和 `listAll`。Session 是 JSONL v3 的 `id`/`parentId` 树，可读取 Session id/file/leaf/entries，并保存 Extension custom entry。[SDK Session Management](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/sdk.md#L721-L823)、[Session format](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/session-format.md#L1-L27)、[SessionManager constructors](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/session-manager.ts#L1514-L1570)

### 7.1 Pi Session 不是 Hunter durable checkpoint

**[事实]** 固定源码用 `writeFileSync`/`appendFileSync` 写 Session，没有 fsync 或 Hunter 式原子不可替换 segment；首个 assistant message 出现前，部分 user/custom entries 还可能只在内存中，首次出现 assistant 后才整体落盘。[Session persistence source](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/session-manager.ts#L979-L1049)

**[工程推论]** Hunter Checkpoint 必须保存在 Hunter 自己的 durable event store，只把 Pi `sessionId`、`sessionFile`、leaf 与版本作为 adapter-owned external references。Pi `open`/`continueRecent` 只能作为恢复输入，不能替代 Hunter 的 checkpoint、operation journal 或 Verification history。

**[NOT_PROVEN]** 已落盘 Session 的精确 reopen、source/workspace binding、截断文件失败方式、in-flight 恢复和恢复后 event continuity 都必须由 Task 4 fixture 验证。

### 7.2 中断与进程清理

**[事实]** Windows `killProcessTree()` 通过 detached `taskkill /F /T` 发起清理且不等待完成；异常也被忽略。`AgentSessionRuntime.dispose()` 会发 `session_shutdown` 并调用同步 `session.dispose()`，但不像 Session replacement 路径那样先 `await session.abort()`。[Windows process-tree source](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/utils/shell.ts#L175-L225)、[runtime teardown/dispose](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/agent-session-runtime.ts#L167-L178)、[runtime dispose](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/agent-session-runtime.ts#L398-L405)

**[工程推论]** Hunter Host 仍需外层 process-tree containment 和退出后的进程/工作区 reconciliation；Pi `abort`、idle、dispose 或 process exit 都不是 exact cleanup Receipt。

## 8. 源码级能力映射

下表只回答“固定公开接口是否看起来可以表达该动作”，不签发本机 capability：

| Hunter Host 原子能力 | 上游公开入口 | 当前结论 | Task 4 必须证明 |
|---|---|---|---|
| `START_ATTEMPT` | CLI、RPC、SDK、显式 Extension | **[NOT_PROVEN]** 可表达 | 固定 artifact、隔离配置、Core handshake、workspace/source binding |
| `SEND_INPUT` | RPC `prompt`/`steer`/`follow_up`；SDK `prompt`/`steer`/`followUp` | **[NOT_PROVEN]** 可表达 | request/fingerprint 绑定、接受与最终结果分离 |
| `OBSERVE` | JSON/RPC event stream；SDK `subscribe` | **[NOT_PROVEN]** 可表达 | 严格 envelope、Host-owned cursor、无丢失/重复、未知事件失败方式 |
| `INTERRUPT` | RPC/SDK `abort`，direct bash 的 `abort_bash` | **[NOT_PROVEN]** 部分可表达 | 迟到 event、子进程树、超时与 exact reconciliation |
| `CHECKPOINT` | Session external refs、leaf、Extension custom entry | **[NOT_PROVEN]** 仅提供输入 | Hunter durable checkpoint、Pi ref binding、禁止把 Session 文件当 canonical truth |
| `RECONCILE` | 查询 state/entries/tree + Host journal | **[工程推论]** 由 Host 补齐 | operationId/fingerprint 幂等、unknown outcome、重复 Receipt 拒绝 |
| `RESUME` | `open`、`continueRecent`、`switchSession`、runtime replacement | **[NOT_PROVEN]** 可表达已落盘 Session | fresh process、精确 Session/workspace、截断/不完整状态、重新订阅 |
| `CLOSE` | EOF、runtime/session dispose、外层 process host | **[NOT_PROVEN]** 可组合 | Core shutdown event、handle/child 清理、workspace 无残留 |

## 9. Task 4 实施约束和停止线

基于本次复核，Task 4 应继续，但只能在下列边界内：

1. 精确依赖为 `@earendil-works/pi-coding-agent@0.83.0`，同时检查 lockfile 解析版本、npm integrity 和实际导出。
2. 所有配置和 Session 使用隔离的 `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`；所有会修改文件的探针只运行在自动创建的临时 Git fixture。
3. JSON/RPC 客户端按 LF-only framing，实现唯一 request id；不使用 Node `readline`，不按 stdout 顺序关联 response。
4. Core handshake 必须包含精确 Core artifact identity 与 effective tool graph；只看 active tool name 不足以发现同名 override。
5. 每个 Host process 只允许一个 in-flight mutating Agent operation，直到取消与最终事件完成对账。
6. Pi Session 只作为外部引用；Hunter event store、Checkpoint、operation journal 和 Verification 继续独立持有 canonical state。
7. Provider-independent probe 可以用 Extension command 覆盖启动/handshake/部分 Session 路径；若要驱动完整模型 lifecycle，应使用公开接口下的确定性无网络测试 Provider，并明确这不证明真实 Provider。
8. 登录或真实模型 smoke 留待 owner 单独授权；缺少授权时记录 `NOT_PROVEN`，不阻塞 provider-independent contract。

若出现下列任一实测结果，应按计划停止 Task 5，而不是用源码推论覆盖失败：

- Core active identity 或 effective tool graph 无法通过公开接口证明；
- `abort`/EOF/dispose 后无法精确对账 child、handle 与 workspace cleanup；
- Session/checkpoint/reopen 无法与 Hunter Run/Attempt/source identity 可靠绑定；
- public surface 无法满足 Host 的 operationId/fingerprint 幂等和 unknown-outcome reconciliation。

## 10. 本次未执行

- 未执行 `pi` 或任何 Pi CLI 命令；
- 未下载或安装 npm/Release artifact；
- 未创建 Capability 或 Evidence receipt；
- 未运行 Extension、JSON、RPC 或 SDK probe；
- 未读取 `auth.json`、token、cookie、API key、环境变量全集或用户 Prompt；
- 未运行登录、真实 Provider、模型或付费请求；
- 未验证 Windows/Ubuntu 行为、Session 恢复或进程树清理。

因此，本文件的最终状态是：**候选 `0.83.0` 保留；继续 Task 4 Spike；所有运行时能力仍为 `NOT_PROVEN`。**
