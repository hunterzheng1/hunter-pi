# Pi 与 Oh My Pi 上游技术基线

- 调研日期：2026-08-03
- 结论时点：2026-08-03（Asia/Shanghai）
- 调研对象：Pi、Oh My Pi（OMP）
- 来源范围：仅使用项目官方 GitHub 仓库、仓库内文档、源码清单和官方 Release；未使用 Reddit、博客转载或第三方测评
- 用途：为 Hunter Pi 的产品设计、架构决策、兼容策略和实施计划提供可复核的上游事实，不把上游声明等同于 Hunter Pi 本机验证

## 1. 结论摘要

1. **[事实] Pi 本身就是为“无需 Fork 的工作流定制”设计的。** 它公开 TypeScript Extensions、Skills、Prompt Templates、Themes、Pi Packages、RPC 和 SDK，官方 README 明确把这些接口作为适配自定义工作流的主要方式。Pi 也刻意不内置 subagent、plan mode 和权限弹窗，而是要求使用者通过扩展、第三方包或外部隔离实现。[Pi Coding Agent README](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/README.md)
2. **[工程推论] Hunter Pi 的首选地基应是“锁定版本的官方 Pi + Hunter Workflow Kernel + Hunter Extension/SDK Host”，不是立刻 Fork Pi，也不是直接 Fork OMP。** 这样既能迁移 Hunter-Harness 的任务、Attempt、验证和 Evidence 机制，又能保留最直接的 Pi Package 兼容路径。
3. **[事实] “无感更新”不能解释成无条件追随 `latest`。** 截至本次调研，Pi 最新版 `v0.83.0` 本身包含会使部分扩展必须迁移的 TypeBox breaking change；因此 Hunter Pi 必须先做兼容验证，再提升内置 Pi 版本。[Pi v0.83.0 Release](https://github.com/earendil-works/pi/releases/tag/v0.83.0)
4. **[事实] 标准 Pi Package 是可复用的主要生态单位，但它不是安全沙箱。** 包可以包含扩展、技能、提示模板和主题；扩展可以执行任意代码，技能也可指示模型执行本机程序。Pi 官方要求安装前审阅源码。[Pi Packages](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/packages.md)
5. **[事实] OMP 是 Pi 的重度、batteries-included Fork，而不是一组轻量 Pi 配置。** 它包含自己的 `@oh-my-pi/*` monorepo、Bun 运行时假设、Rust/N-API 原生层、工具、任务、subagent、memory、browser、LSP/DAP、MCP、RPC/ACP 等系统。[OMP README](https://github.com/can1357/oh-my-pi/blob/v17.2.4/README.md)
6. **[事实 + 工程推论] OMP 对标准 Pi 扩展做了兼容层，但不能据此承诺“所有 Pi 插件直接可用”。** OMP 接受 `package.json.pi`、重写 `@mariozechner/*` 与 `@earendil-works/*` 导入；然而 `v17.2.1`、`v17.2.2` 仍分别修复了兼容 shim 缺少导出的真实问题。这说明兼容是积极维护的 best-effort，而不是已证明的完整等价。[OMP Extension Loading](https://github.com/can1357/oh-my-pi/blob/v17.2.4/docs/extension-loading.md)、[OMP v17.2.1](https://github.com/can1357/oh-my-pi/releases/tag/v17.2.1)、[OMP v17.2.2](https://github.com/can1357/oh-my-pi/releases/tag/v17.2.2)

## 2. 证据标记

- **[事实]**：可由链接中的官方仓库内容直接验证。
- **[工程推论]**：从一个或多个官方事实推导出的 Hunter Pi 设计含义；不是上游承诺。
- **[NOT_PROVEN]**：没有在本次来源范围内找到足够证据，或必须通过 Hunter Pi 本地/CI/实机验证才能成立。

## 3. 冻结的上游快照

| 项目 | 截至 2026-08-03 的最新 Release | Release 时间（UTC） | Tag commit | 运行时/CLI 清单事实 |
|---|---|---:|---|---|
| Pi | [`v0.83.0`](https://github.com/earendil-works/pi/releases/tag/v0.83.0) | 2026-07-29 22:30:33 | [`845d6ff1f6643aba440341cce877ce1c43ebbc39`](https://github.com/earendil-works/pi/commit/845d6ff1f6643aba440341cce877ce1c43ebbc39) | `@earendil-works/pi-coding-agent@0.83.0`、ESM、Node `>=22.19.0`、命令 `pi`；见 [package.json](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/package.json) |
| Oh My Pi | [`v17.2.4`](https://github.com/can1357/oh-my-pi/releases/tag/v17.2.4) | 2026-08-01 22:58:37 | [`06343fef4200c4e32d18f08df5a6a8bd84dcc710`](https://github.com/can1357/oh-my-pi/commit/06343fef4200c4e32d18f08df5a6a8bd84dcc710) | `@oh-my-pi/pi-coding-agent@17.2.4`、ESM、Bun `>=1.3.14`、命令 `omp`；见 [package.json](https://github.com/can1357/oh-my-pi/blob/v17.2.4/packages/coding-agent/package.json) |

上述版本号、发布时间和 commit 是本研究的可复现锚点。后续设计文档若引用 `main` 的新能力，应重新执行基线核验，而不能把本文件自动解释成对未来版本的证明。

## 4. Pi 技术基线

### 4.1 产品定位与可嵌入方式

- **[事实]** Pi 官方称其为最小化的 terminal coding harness，并明确主张通过扩展适配工作流，而不是修改 Pi 内部。[Pi Coding Agent README](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/README.md)
- **[事实]** Pi 提供四种运行方式：交互 TUI、print/JSON、RPC，以及供 Node/TypeScript 应用嵌入的 SDK。[Pi Coding Agent README：Programmatic Usage](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/README.md#programmatic-usage)
- **[事实]** Pi monorepo 的公共组成包括统一多 Provider API、agent core、coding-agent CLI 和 TUI；根 README 同时明确 Pi 默认继承启动进程的操作系统权限。[Pi 根 README](https://github.com/earendil-works/pi/blob/v0.83.0/README.md)

**对 Hunter Pi 的含义（工程推论）**：

- 日常交互面可以沿用 Pi TUI，并由 `hpi` 启动器注入 Hunter 扩展与隔离配置。
- Hunter Workflow Kernel 若需要完全控制 Session、Tool、验证及恢复，优先使用 SDK；需要进程隔离或让 Hunter-Harness 调用时使用 RPC。
- 不应把 Pi 进程退出、agent loop idle 或最后一条自然语言答复当成 Hunter Step 成功；成功仍由 Hunter verifier 或人工 receipt 决定。

### 4.2 Extension 能力与边界

Pi 的扩展是 TypeScript 模块。官方文档公开的主要能力包括：

- **[事实]** 订阅 session、agent、turn、message、tool 等生命周期事件；`tool_call` 可阻止或修改调用，`tool_result` 可修改结果。[Pi Extensions](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/extensions.md)
- **[事实]** 注册 LLM 可调用工具、斜杠命令、快捷键、CLI flag、消息渲染器和 Provider。[Pi Extensions](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/extensions.md)
- **[事实]** 通过 `appendEntry` 保存不进入模型上下文的扩展状态，并在 Session 事件中重建；扩展也可定制 compaction、UI、system prompt 和 active tools。[Pi Extensions](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/extensions.md)
- **[事实]** 扩展可注册与内置工具同名的实现，因此可以包装或替换默认的 `read`、`write`、`edit`、`bash` 等能力。[Pi Extensions examples](https://github.com/earendil-works/pi/tree/v0.83.0/packages/coding-agent/examples/extensions)
- **[事实]** interactive、RPC、JSON 和 print 模式对扩展 UI 的支持不同；非交互模式不能假定所有 TUI 方法有效。[Pi Extensions：Mode Behavior](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/extensions.md#mode-behavior)

**对 Hunter Pi 的含义（工程推论）**：Extension 足以承载交互命令、工具拦截、Evidence 事件桥和 UI 状态，但“独立验证器”“跨进程恢复”“版本更新器”不应只寄托在单个 in-process 扩展上；这些职责应由外层 Workflow Kernel/Launcher 持有。

### 4.3 Pi Packages 与第三方插件兼容

- **[事实]** Pi Package 可以通过 npm、Git 或本地路径安装，并在 `package.json` 的 `pi` 字段中声明 `extensions`、`skills`、`prompts`、`themes`；没有清单时也会按约定目录发现这些资源。[Pi Packages](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/packages.md)
- **[事实]** 用户级 npm/Git 包分别落在 `~/.pi/agent/npm/` 与 `~/.pi/agent/git/`；项目级包落在 `.pi/npm/` 与 `.pi/git/`。[Pi Packages：Package Sources](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/packages.md#package-sources)
- **[事实]** 带确切版本的 npm spec、带 tag/commit 的 Git ref 被视为固定依赖；常规 package update 不会把它们自动移动到其他版本/ref。[Pi Packages：Install and Manage](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/packages.md#install-and-manage)
- **[事实]** 引用 Pi 核心包的插件应把 `@earendil-works/pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-tui` 和 `typebox` 列为 `peerDependencies: "*"`，并使用宿主提供的副本。[Pi Packages：Dependencies](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/packages.md#dependencies)
- **[事实]** 项目本地 Package 在项目被信任后可由 Pi 启动时自动补装；交互与非交互模式的 trust 行为不同。[Pi Settings：Project Trust](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/settings.md#project-trust)

**兼容结论**：

- **[工程推论]** 只使用公开 Extension API、标准 `pi` manifest、正确 peer dependency 的第三方包，是 Hunter Pi 最有可能直接兼容的一类。
- **[工程推论]** 插件若依赖未公开源码路径、已弃用 API、某个精确 TUI 行为或覆盖 Hunter 的核心工具，就必须单独验证；“能够加载”也不等于“不会破坏 Hunter Evidence”。
- **[NOT_PROVEN]** 没有官方材料保证任意第三方 Pi Package 在未来 Pi 版本上保持二进制或行为兼容。

### 4.4 RPC 与 SDK

#### RPC

- **[事实]** `pi --mode rpc` 通过 stdio 工作；stdin 接收一行一个 JSON command，stdout 输出带关联 id 的 response 与流式 event。[Pi RPC Protocol](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/rpc.md)
- **[事实]** 协议使用严格的 LF 分隔 JSONL；官方特别警告客户端应按 `\n` 分帧，而不是使用会把其他 Unicode 分隔符也当换行的通用 line reader。[Pi Coding Agent README：RPC Mode](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/README.md#rpc-mode)

#### SDK

- **[事实]** SDK 公开 `createAgentSession()`、`SessionManager`、`ModelRuntime`、ResourceLoader、工具选择、自定义工具、扩展加载和 Session 管理等能力。[Pi SDK](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/sdk.md)
- **[事实]** SDK 可以使用内存 Session，也可以创建、继续、打开和枚举持久 Session；可指定 cwd、内置工具 allowlist、自定义扩展路径与 factories。[Pi SDK：Session Management](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/sdk.md#session-management)

**对 Hunter Pi 的含义（工程推论，已由架构决策收敛）**：第一交互路径优先启动固定版 Pi CLI 并显式加载 Core Extension，以保留上游 TUI 与 Package 行为；RPC 用于需要进程隔离的自动化或外部宿主；SDK 仅在 Task 4 证明 CLI/Extension/RPC 无法满足某个具体控制需求时升级采用。所有路径都需要 Hunter 自己定义版本化 envelope，避免公共领域类型直接依赖 Pi 私有事件形状。

### 4.5 配置目录与隔离

- **[事实]** Pi 默认全局配置目录为 `~/.pi/agent`；`PI_CODING_AGENT_DIR` 可以覆盖该目录。[Pi CLI Environment Variables](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/README.md#environment-variables)
- **[事实]** 全局设置在 `~/.pi/agent/settings.json`，项目设置在 `.pi/settings.json`；项目设置覆盖全局设置。[Pi Settings](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/settings.md)
- **[事实]** Session 默认保存在 `~/.pi/agent/sessions/`，也可以用 `PI_CODING_AGENT_SESSION_DIR` 或 `--session-dir` 改写。[Pi Coding Agent README：Sessions](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/README.md#sessions)
- **[事实]** 项目 trust 决策保存在 `~/.pi/agent/trust.json`；未信任项目的本地设置、扩展与 Package 不会按正常受信路径加载。[Pi Settings：Project Trust](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/settings.md#project-trust)

**对 Hunter Pi 的含义（工程推论）**：`hpi` 应设置独立的 `PI_CODING_AGENT_DIR`（例如用户目录下的 `.hunter-pi`），让 Hunter Pi 的固定扩展、插件清单、Session 和 trust 决策不污染普通 Pi。凭据必须继续由上游认证存储管理；Hunter Workflow Kernel 不应调用凭据导出命令或复制明文 token。

### 4.6 更新机制与兼容风险

- **[事实]** Pi CLI 提供 `pi update --self`、`--extensions`、`--models` 和 `--all`；固定 npm 版本或 Git ref 不会被普通 Package 更新自动漂移。[Pi Packages](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/packages.md)
- **[事实]** Pi 启动时会检查新版本；可用 `PI_SKIP_VERSION_CHECK=1` 仅关闭版本检查，或用 `PI_OFFLINE=1`/`--offline` 关闭启动期版本检查、Package 检查及安装/更新遥测。[Pi Settings：Telemetry and update checks](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/settings.md#telemetry-and-update-checks)
- **[事实]** Pi `v0.83.0` 移除了部分已弃用 TypeBox API，并明确要求使用这些 API 的扩展迁移。[Pi v0.83.0 Release](https://github.com/earendil-works/pi/releases/tag/v0.83.0)
- **[事实]** 官方发布既提供 npm 安装材料，也提供 Windows x64/ARM64、Linux 和 macOS 的 standalone assets 及 `SHA256SUMS`。[Pi v0.83.0 Assets](https://github.com/earendil-works/pi/releases/tag/v0.83.0)

**对 Hunter Pi 的含义（工程推论）**：Hunter Pi 应关闭内置 Pi 的独立 self-update，让 Hunter Pi 更新器统一提升锁定版本；升级候选必须通过 extension typecheck、package smoke、RPC/SDK contract、Session resume、Windows 实机和回滚测试后才能进入稳定渠道。

### 4.7 Windows 基线

- **[事实]** Pi 在 Windows 上要求 Bash；搜索顺序包括自定义 `shellPath`、Git Bash，以及 PATH 上的 Cygwin/MSYS2/WSL bash。官方称多数用户安装 Git for Windows 即可。[Pi Windows Setup](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/windows.md)
- **[事实]** Pi `v0.83.0` Release 提供 `pi-windows-x64.zip` 和 `pi-windows-arm64.zip`。[Pi v0.83.0 Release](https://github.com/earendil-works/pi/releases/tag/v0.83.0)
- **[NOT_PROVEN]** 仅凭官方发布资产，不能证明 Hunter Pi 的扩展、安装器、升级/回滚、长期 Session、Git worktree 和第三方插件组合已在本机 Windows 上通过。

### 4.8 权限与插件安全

- **[事实]** Pi 不包含限制文件系统、进程、网络或凭据访问的内置权限系统；默认使用启动它的用户/进程权限。官方建议需要更强边界时采用容器或 sandbox。[Pi 根 README：Permissions & Containerization](https://github.com/earendil-works/pi/blob/v0.83.0/README.md#permissions--containerization)
- **[事实]** Pi Packages 拥有完整系统访问；扩展执行任意代码，技能可诱导模型执行程序。[Pi Packages：Security](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/packages.md#install-and-manage)
- **[事实]** Project Trust 只控制项目本地资源是否加载，不是 OS 级隔离。[Pi Settings：Project Trust](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/settings.md#project-trust)

**对 Hunter Pi 的含义（工程推论）**：第三方 Package 必须显示来源、精确版本/ref、资源类型和信任状态；应提供只加载 Hunter 内置扩展的 safe mode。任何覆盖核心工具、改变验证或阻断 Evidence 的插件，都应使本次 Run 降级为未验证，而不能继续宣称完整 Hunter 保证。

## 5. Oh My Pi 技术基线

### 5.1 Fork 定位与体量

- **[事实]** OMP 官方将自己描述为 Pi 的 Fork，以及带完整 coding workflow 的 batteries-included 版本。[OMP README](https://github.com/can1357/oh-my-pi/blob/v17.2.4/README.md)
- **[事实]** `v17.2.4` README 当时列出 40+ Provider、32 个内置工具、14 项 LSP 操作、28 项 DAP 操作以及约 55k 行 Rust core；这些是上游自报的时变规模，不是 Hunter 验证结果。[OMP README](https://github.com/can1357/oh-my-pi/blob/v17.2.4/README.md)
- **[事实]** OMP monorepo 不只是 coding-agent 包，还包括 catalog、agent core、TUI、native bindings、hashline、SQLite memory、context compression、swarm extension、collaboration web 等包；Rust 层包括 native addon、内嵌 shell、AST、隔离后端及 vendored shell crates。[OMP README：Monorepo Packages / Rust Crates](https://github.com/can1357/oh-my-pi/blob/v17.2.4/README.md#monorepo-packages)
- **[事实]** coding-agent 启动链从 CLI/commands 到 `createAgentSession()`，内部还包含 task/swarm/plan、browser/search、MCP、extensibility/discovery、advisor/autolearn、memory、TUI/collab 等子系统。[OMP Development Map](https://github.com/can1357/oh-my-pi/blob/v17.2.4/packages/coding-agent/DEVELOPMENT.md)

**对 Hunter Pi 的含义（工程推论）**：直接 Fork OMP 可以更快获得大量功能，但会同时继承一套已经成形的 Task、Plan、Memory、Approval、Session 和工具语义；把 Hunter-Harness 核心机制迁入时，概念重叠和替换成本会明显高于在精简 Pi 上建立自己的 Workflow Kernel。

### 5.2 OMP 的扩展与插件模型

- **[事实]** OMP 扩展使用自己的 `@oh-my-pi/pi-coding-agent` API，可注册事件、工具、命令、快捷键、flag、渲染器和 Provider；工具执行统一经过 `tool_call`/`tool_result` 拦截。[OMP Extensions](https://github.com/can1357/oh-my-pi/blob/v17.2.4/docs/extensions.md)
- **[事实]** OMP 的 canonical schema 是注入的 Zod v4；同时提供 TypeBox 风格兼容 shim。[OMP Extensions：Extension API surfaces](https://github.com/can1357/oh-my-pi/blob/v17.2.4/docs/extensions.md#1-registration-and-actions-extensionapi)
- **[事实]** 扩展与宿主同进程、没有 sandbox；原生 timer 或 detached promise 的未处理异常可导致整个 Session 终止。[OMP Extensions：Background work](https://github.com/can1357/oh-my-pi/blob/v17.2.4/docs/extensions.md#background-work-ctxsetinterval--ctxsettimeout)
- **[事实]** OMP Plugin Manager 优先读 `package.json.omp`，回退到 `package.json.pi`；安装使用 Bun 并维护自己的 plugin dependency/lock 状态。没有 `omp`/`pi` manifest 的包可以被安装和列出，但不会作为 runtime plugin 加载。[OMP Plugin Manager](https://github.com/can1357/oh-my-pi/blob/v17.2.4/docs/plugin-manager-installer-plumbing.md)
- **[事实]** OMP native extension root 是 `.omp/extensions` 与 `~/.omp/agent/extensions`；它接受 package manifest 中的 legacy `pi.extensions`，但 `.pi/extensions` 本身不是 OMP 的 native auto-discovery root。[OMP Extension Loading](https://github.com/can1357/oh-my-pi/blob/v17.2.4/docs/extension-loading.md)

### 5.3 与原版 Pi 插件的兼容边界

OMP 做了明确兼容工作：

- **[事实]** 目录解析接受 `omp.extensions`，并回退接受 `pi.extensions`。[OMP Extension Loading：Path and entry resolution](https://github.com/can1357/oh-my-pi/blob/v17.2.4/docs/extension-loading.md#path-and-entry-resolution)
- **[事实]** 加载器会把 legacy `@mariozechner/*`、`@earendil-works/*` 和 bare TypeBox specifier 重写到 OMP 随宿主打包的副本。[OMP Extension Loading：Module import and factory contract](https://github.com/can1357/oh-my-pi/blob/v17.2.4/docs/extension-loading.md#module-import-and-factory-contract)
- **[事实]** `v17.2.1` 修复过兼容 shim 未导出 `createEditTool` / `createWriteTool`，导致标准 Pi 扩展安装验证失败的问题。[OMP v17.2.1 Release](https://github.com/can1357/oh-my-pi/releases/tag/v17.2.1)
- **[事实]** `v17.2.2` 又修复了 shim 未重新导出 `compact`，导致导入该符号的 Pi 扩展验证失败的问题。[OMP v17.2.2 Release](https://github.com/can1357/oh-my-pi/releases/tag/v17.2.2)

因此：

- **[工程推论]** 使用基础、稳定、公开 Extension API 的标准 Pi Package 在 OMP 中有较高概率可用。
- **[工程推论]** 依赖 Pi 根包新增导出、深层路径、TypeBox 细节、默认工具实现或 `.pi` 原生目录发现行为的包，不能假设等价。
- **[NOT_PROVEN]** OMP 官方材料没有承诺覆盖全部当前/未来 Pi Package，也没有提供“所有 Gallery 插件均通过”的兼容矩阵。

### 5.4 配置、RPC/SDK 与 Windows

- **[事实]** OMP 默认全局目录是 `~/.omp/agent`，主设置是 `config.yml`，认证存储为 `agent.db`；`PI_CODING_AGENT_DIR` 会迁移整个 active agent directory。[OMP Settings：Where settings live](https://github.com/can1357/oh-my-pi/blob/v17.2.4/docs/settings.md#where-settings-live)
- **[事实]** OMP SDK 由 `@oh-my-pi/pi-coding-agent` 暴露，RPC 以 `omp --mode rpc` 提供 NDJSON stdio；此外还提供 ACP。[OMP README：SDK / RPC / ACP](https://github.com/can1357/oh-my-pi/blob/v17.2.4/README.md#sdk--embed-in-node)
- **[事实]** OMP 官方 README 支持 Windows PowerShell 安装，要求 Bun `>=1.3.14`；其 native shell/search 目标是在 Windows 上不依赖 WSL。[OMP README：Install / Native Windows](https://github.com/can1357/oh-my-pi/blob/v17.2.4/README.md#install)
- **[事实]** `v17.2.4` Release 提供 `omp-windows-x64.exe`，未在该 Release 的资产列表中提供 Windows ARM64 二进制。[OMP v17.2.4 Release](https://github.com/can1357/oh-my-pi/releases/tag/v17.2.4)
- **[事实]** 近期 `v17.2.2` 仍修复了 Windows 上 Chromium profile 的 `EBUSY` 崩溃及 SQLite 文件锁问题。[OMP v17.2.2 Release](https://github.com/can1357/oh-my-pi/releases/tag/v17.2.2)

**工程推论**：OMP 的 Windows 体验比 stock Pi 的外部 Bash 依赖更一体化，但原生 Rust/N-API、浏览器、SQLite、PTY 和 Bun 增加了发布与回归矩阵。官方“支持 Windows”不能替代 Hunter Pi 自己的 Windows x64 安装、升级、长 Session、插件和恢复实测。

### 5.5 发布与 breaking-change 风险

- **[事实]** OMP `v17.2.0` 删除了若干 Hashline edit 操作（`DEL`、`DEL.BLK`、`COPY`、`COPY.BLK`）。[OMP v17.2.0 Release](https://github.com/can1357/oh-my-pi/releases/tag/v17.2.0)
- **[事实]** 两天后的 `v17.2.2` 又把 legacy `SWAP`、`INS`、`PASTE` 语法替换为统一 `PUT`/`CUT` grammar，并把它列为 breaking change。[OMP v17.2.2 Release](https://github.com/can1357/oh-my-pi/releases/tag/v17.2.2)
- **[事实]** 同一组近邻版本包含 Pi 兼容 shim 补全、RPC 修复、Windows 修复及插件 reload 修复，显示 OMP 的功能面和接口仍在快速演进。[OMP v17.2.1](https://github.com/can1357/oh-my-pi/releases/tag/v17.2.1)、[OMP v17.2.2](https://github.com/can1357/oh-my-pi/releases/tag/v17.2.2)、[OMP v17.2.4](https://github.com/can1357/oh-my-pi/releases/tag/v17.2.4)

**工程推论**：如果 Hunter Pi 直接 Fork OMP，就需要同时承担 OMP 自有语义迁移、原生资产、Bun、Windows 和 Pi 兼容层的回归；这比以官方 Pi 公共接口为边界的维护面更大。

## 6. 对 Hunter Pi 路线的比较

| 维度 | 官方 Pi + Hunter Kernel（推荐） | 直接 Fork Pi | 直接 Fork OMP |
|---|---|---|---|
| Hunter 工作流主权 | 高；Kernel 自己定义 Task/Run/Attempt/Verify | 最高，但会侵入上游核心 | 容易与 OMP 自带 Task/Plan/Memory 语义重叠 |
| Pi 第三方包兼容 | 最直接；仍需版本验证 | 初期接近，分叉后逐渐承担兼容责任 | 有 legacy shim，但已有缺失导出的真实修复历史 |
| 跟随 Pi 更新 | 更新锁定依赖并跑 gate | 持续合并上游源码 | 先等待/合并 OMP，再处理自己的 Fork 差异 |
| 首版功能丰富度 | 需要自行实现 Hunter Kernel，适中 | 与左侧近似 | 最高，已有大量工具/原生功能 |
| 长期维护面 | 最小 | 高 | 最高 |
| Windows 复杂度 | Pi + Git Bash；Hunter 自己验证安装器 | 同左，另加 Fork 构建 | Bun + Rust/N-API + browser/SQLite/PTY 等矩阵 |
| 可替换性 | 最好；Kernel 不依赖 Pi 私有类型即可替换 Host | 较差 | 最差，容易依赖 OMP 私有系统 |

## 7. 建议冻结为 Hunter Pi 的上游策略

以下是基于本研究的**工程建议**，不是上游事实：

1. `hunter-pi` 独立仓库固定 `@earendil-works/pi-coding-agent` 的确切版本，初始候选基线为 `0.83.0`；任何正式采用仍须通过本项目自己的 Spike 和 contract suite。
2. `hpi` 是 Hunter Pi 自己的 Launcher/CLI，不是重命名全局 `pi`。它设置隔离的 `PI_CODING_AGENT_DIR`，加载 Hunter 核心扩展，并把 Pi self-update 交给 Hunter Pi 更新器统一控制。
3. `workflow-kernel` 只依赖 Hunter 自有的 runtime port，不引用 Pi/OMP 私有事件类型。Pi SDK adapter 负责把上游事件规范化成版本化 Hunter receipt。
4. 第一交互版优先复用 Pi CLI/TUI + Hunter Core Extension；自动化、外部 Harness 接入和进程故障隔离优先使用 RPC；SDK 是由 Task 4 的具体缺口触发的升级路径，不是默认主进程接口。
5. 对第三方 Pi Package 分别记录 Compatibility（`VERIFIED`/`UNVERIFIED`/`INCOMPATIBLE`）、Trust（`BUNDLED`/`USER_APPROVED`/`QUARANTINED`）和 Isolation（`CONTAINED`/`PROCESS_AUTHORITY`/`NOT_PROVEN`）。固定来源与版本并通过 smoke/contract 只能证明 Compatibility，不能证明代码安全或隔离。
6. 提供 `hpi --safe-mode`：只加载 Hunter 内置扩展和固定配置，用于插件冲突、兼容回归及证据复核。
7. 建立上游升级流水线：候选版本解析 → lockfile 更新 → typecheck/build → Extension API contract → Package fixtures → RPC framing → SDK Session/resume → Windows x64 实机 → 回滚 → 人工批准发布。
8. OMP 作为功能与实现参考库。Hashline、LSP、browser、subagent、memory 等能力逐项做 license、依赖和语义审查；只有能封装成独立深模块且不污染 Workflow Kernel 时才移植。
9. 若某项 Hunter 核心能力被官方 Pi 接口明确阻断，应先建立最小复现并尝试上游贡献；只有阻断可验证、扩展/SDK/RPC 均无法解决时，才建立最小 patch/Fork。

## 8. 必须通过实现阶段证明的事项

以下事项在本研究中均为 **NOT_PROVEN**：

- Pi `v0.83.0` 与尚未编写的 Hunter Workflow Kernel、Extension、Launcher 完整兼容。
- Pi 的 Project Trust、Extension 拦截和外层验证组合可以覆盖 Hunter 定义的 Evidence 不变量；它们不能单独构成对任意插件代码的操作系统隔离，后者需要独立 sandbox/container 证据。
- 所有 Pi Gallery/npm/Git 第三方包都能在 Hunter Pi 中直接使用。
- 未来 Pi 版本可在无需 Hunter 代码调整的情况下升级。
- Pi SDK/RPC 的所有事件足以表达 restart、recovery、external operation receipt 和 verifier receipt；需由 contract spike 验证。
- Windows x64 安装器、Git Bash 探测、OAuth 登录、插件安装、Session 恢复、更新回滚和长期运行已通过。
- Windows ARM64 的 Hunter Pi 发布可行；虽然 Pi 有 ARM64 资产，但 Hunter 自有 Launcher/installer 尚未验证。
- OMP 的任意代码可在不引入其私有架构和原生依赖的前提下直接移植。
- OMP 会持续、完整、及时地追踪未来 Pi Extension API；官方材料没有给出这种保证。
- “Agent 退出/idle”可作为成功信号；Hunter 产品不变量应继续明确否定这一点。

## 9. 许可事实

- **[事实]** Pi 使用 MIT License。[Pi LICENSE](https://github.com/earendil-works/pi/blob/v0.83.0/LICENSE)
- **[事实]** OMP 使用 MIT License，并在 README 中保留 Mario Zechner 与 Can Bölük 的版权说明。[OMP LICENSE](https://github.com/can1357/oh-my-pi/blob/v17.2.4/LICENSE)、[OMP README](https://github.com/can1357/oh-my-pi/blob/v17.2.4/README.md#license)
- **[工程推论]** 若 Hunter Pi 复制或修改 Pi/OMP 代码，应在具体文件与发布物中保留适用版权和许可证通知，并记录来源 commit；本条不是法律意见。

## 10. 一句话基线

> Hunter Pi 应把官方 Pi 当作经过锁版本和契约验证的可替换执行宿主，把 Hunter-Harness 的核心机制重新实现为独立 Workflow Kernel；标准 Pi Package 是优先兼容目标，OMP 是高价值参考实现而非默认地基。所有上游更新和第三方插件都必须先验证，再对用户表现为“无感”。
