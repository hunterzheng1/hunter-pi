# Hunter Pi

Hunter Pi 的目标是成为一个面向个人开发者、可独立安装和使用的终端编码 Agent。它以固定版本 Pi 为底层引擎，把 Hunter-Harness 的计划、执行、验证、证据、恢复和知识机制有选择地重新实现为自己的工作流内核，同时面向标准 Pi 扩展和 Pi Package 生态。Task 6 已用修正后的精确干净制品在自动创建的临时 Git fixture 中完成一次资源可对账的真实 Managed Change；这仍不代表真实用户仓库或生产使用已安全。

## 当前状态

**Task 6–11 已在各自记录的 provider-neutral、disposable-fixture 或 unsigned developer-preview 边界内合并并通过精确 Windows/Ubuntu 主线门禁；Task 12 的计划、预检和 Evidence evaluator 已实现，但真实 Windows pilot 仍 `NOT_RUN`，daily-use acceptance 仍 `NOT_PROVEN`。当前主分支 `2d6a79579e63102c331769974d0ce33d5ceff280` 的最终 main CI `31064206951` 已通过；这不等于真实用户仓库安全或生产就绪。**

本仓库已建立 Node.js 24、严格 ESM TypeScript、npm workspaces、仓库 Doctor 与 Windows/Ubuntu CI 基线，并实现严格领域 schema、command/event Workflow Kernel、provider-neutral Engine Host contract、确定性 Fake Host、共享 contract suite、不可变事件/Evidence，以及固定 `@earendil-works/pi-coding-agent@0.83.0` 的公共接口探针。Task 6 又增加了临时 fixture 提升、两次 Attempt、独立命令验证、确定性 review 和可移植 Evidence。Task 7 新增隔离 worktree、进程边界租约、Windows Job Object 与 Linux subreaper 进程树适配；这些目前只证明临时 fixture 中的 Hunter 契约，真实仓库入口、恢复、第三方插件兼容和生产发布仍未被证明。

## 安装开发者预览

当前不发布到 npm，也没有 Windows 安装器。可从干净仓库构建一个精确 tarball：

```powershell
npm ci
npm run pack:preview
npm install --global ".\.artifacts\hpi-developer-preview\hunter-pi-cli-0.1.0-dev.0.tgz"
hpi version --json
```

空配置首次使用可直接运行受限向导：

```powershell
cd D:\Projects\your-git-repository
hpi
hpi smoke tui
hpi
```

向导先检查 Node、固定 Pi Engine、临时 Git fixture 与 Core，再显示默认 Provider/模型/权限、离线解析的真实 origin、可能外发的数据类别，以及诚实的 `ExternalRetention=NOT_PROVEN`、`TrainingUse=NOT_PROVEN`、`AccountControls=PROVIDER_OWNED`。只有你分别确认披露和登录步骤后才打开 Provider-owned 登录 TUI；它不会自动认证或发送模型请求。要选择其他目标，可先显式运行 `hpi setup ...`，再运行 `hpi login`、`hpi doctor --json` 和 `hpi smoke tui`。

- `hpi setup` 显示 Provider、endpoint 类别、离线解析的精确 origin、可能外发的数据类别、外部政策引用、未知的 retention/training 事实及 Hunter 可控的 telemetry/startup-network 设置；版本化 acknowledgement 会绑定这些值。拒绝确认会得到 `BLOCKED`，不会启动请求。
- `hpi smoke tui` 只接受带精确产品壳与 Core SHA-256 的打包制品，并以 Safe Mode 打开 Pi。该模式阻断普通 prompt 输入，但 Pi 的部分内建斜杠命令先于 Extension hook 执行，因此所有 Provider 请求仍标记为 `NOT_PROVEN`。不要发送模型请求或运行其他内建命令；只运行 `/hunter-status`、检查 Hunter 头部后退出。退出码本身不算成功，随后明确确认只记录绑定 product/Engine/source/platform/configuration/`hpi.js` SHA/Core SHA 的本机可变人工 smoke acknowledgement，不是正式 Human Receipt；换产品壳或换 Core 后自动失效。
- `hpi login` 打开 Pi 管理的登录界面；在 Pi 内运行 `/login`。Pi Engine 自主管理 credential storage；Hunter host 只接收并持久化 `configured/source` 元数据，不提取、复制或输出 token。真实登录或可能收费的请求需要用户自行决定。
- `hpi managed fixture --json --allow-provider-request` 是 Task 6 的严格验收入口，只会创建并清理 Hunter 自有的临时 Git fixture；它会在显式确认后发起一次真实 Provider 请求，必须使用精确干净制品和已配置登录。没有 `--allow-provider-request` 或拒绝确认时，命令在创建 fixture 前阻断。即使 Task 7–11 已完成各自边界证明，也不要把它解释为真实仓库 Managed Change。
- 普通 `hpi` 在当前 Git 仓库启动 Quick Session。开发者预览会拒绝任何已启用用户插件；先运行 `hpi plugin doctor` 和 `hpi plugin disable <id>`。`hpi --safe-mode` 不加载用户插件、skills、prompt templates、themes 或 context files，只显式加载 Core，并拦截 Agent 工具写入与 `!` 直接 shell；它不是操作系统沙箱。Core 会对 `.envrc`、`secrets.json`、`token.json`、`service-account.json` 等明确的 credential-like 路径要求确认（Safe Mode 阻断），即使选择 Full Access 也不会预批准；但它不能仅凭路径识别任意文件内容，因此界面明确显示 `CredentialGuard=NAMED_PATHS_ONLY / ContentDetection=NOT_PROVEN`。每次 Quick、login、smoke 启动都会先检查隔离 Session 树；但 Pi 的 `/share`、`/import`、`/export`、`/compact`、`/trust`、设置及其他内建命令属于用户直接操作，不受全局 Hunter tool policy 保证，开发者预览中应避免使用这些命令。特别是 `/share` 可通过 GitHub CLI 上传完整会话 HTML，且 Task 5 无法在公开 Extension hook 中插入 Hunter 确认或 Receipt，因此显示为 `ShareCommand=NOT_MEDIATED / RemoteWriteGuarantee=NOT_PROVEN`。
- Quick Session 退出只记录 `PROCESS_EXIT` 和 `VerifiedChange=NOT_CLAIMED`，不会伪装成已验证交付。

其他 Provider 可在 setup 时显式指定，例如 `hpi setup --provider <id> --model <exact-model-id> --policy-reference <https-url> --endpoint-category PROVIDER_MANAGED --permission balanced`。LOCAL endpoint 还必须给出精确 loopback origin，例如 `--endpoint-category LOCAL --destination-origin http://127.0.0.1:11434`；CUSTOM 只接受 HTTPS origin。启动前会解析真实 origin；Provider-managed 配置必须与固定 Pi 原始目录一致，Core 还会固定 Provider/model/origin 并在漂移时终止。切换 Provider、模型、endpoint、目的地或披露政策会在需要时要求重新确认。

## 开发基线

需要 Node.js 24、npm 11 和 Git。克隆仓库后运行：

```powershell
npm ci
npm run doctor
npm run probe:pi
npm run verify
```

根 `npm run doctor` 检查工程仓库前置条件；安装后的 `hpi doctor` 另行检查 Node 24、临时 Git fixture、实际 Pi Engine Release、隔离配置、当前离线解析的 Provider origin、披露、Provider 登录元数据、产品壳/Core 完整性和同时绑定两者 SHA 的 TUI receipt。任何缺项均为 `BLOCKED`、`NOT_PROVEN` 或 `INCOMPATIBLE` 并返回非零。`probe:pi` 仍只证明固定 Pi 的 provider-independent 公共接口，不证明真实 Provider。

## 产品形态

Hunter Pi 当前开发者预览已经提供独立入口：

```powershell
hpi
```

它包含两种主要体验：

- **Quick Session**：像 Pi、Claude Code 或 Codex CLI 一样直接对话和修改代码。
- **Managed Change**：按 Plan → Execute → Verify → Review 的可恢复工作流交付一个有边界的变更。

目标结构：

```text
Hunter Pi (`hpi`)
├─ Product Shell               交互、配置、Doctor、更新
├─ Workflow Kernel             Change、Run、Attempt、验证与恢复
├─ Pi Host                     通过官方 Extension / JSON / RPC / SDK 驱动 Pi
├─ Core Extension Bundle       Hunter 工具、命令、上下文与界面
├─ Plugin Manager              标准 Pi Package 兼容、信任与隔离报告
└─ Evidence & Knowledge        事实、收据、归档与可追溯经验
```

## 与现有项目的关系

| 项目 | 关系 |
|---|---|
| [Pi](https://github.com/earendil-works/pi) | Hunter Pi 的可替换上游引擎；优先只使用公开接口，不在第一版 Fork |
| [Hunter-Harness](https://github.com/hunterzheng1/Hunter-Harness) | 工作流机制和真实工程经验来源；Hunter Pi 不在运行时依赖它 |
| [Oh My Pi v17.2.4](https://github.com/can1357/oh-my-pi/blob/v17.2.4/README.md) | 冻结研究所用的功能和实现参考；不作为 Hunter Pi 的基础 Fork |
| Hunter Platform | 已归档的历史控制面设计；不作为本项目运行时依赖 |

迁移原则是“迁移机制、重写适合个人 Agent 的内核、保留来源”，不是复制完整 Harness，也不是把 Harness 作为外挂启动。

## 核心保证

- Agent 返回、进程退出、终端空闲都只是 Observation，不代表任务成功。
- Managed Change 的所有必需自动 Verification 必须通过，预先声明的人工门还必须有精确 Human Receipt；人工确认不能替代自动检查。
- 重试产生新 Attempt；失败历史不可改写成成功。
- 自动循环必须受次数、时间、预算和确定性停止条件约束。
- 上游 Pi 版本固定并经过兼容验证后才进入 Hunter Pi 稳定版。
- 标准 Pi 插件未来可按策略安装，但插件代码可能拥有当前进程权限；Task 5 只提供元数据 doctor/disable，并拒绝实际激活。后续插件管理必须先显示精确来源、版本/ref、scope、兼容性、信任来源和实际隔离状态。
- “本地优先”指规范状态留在本机，并不表示模型请求不联网；首次发送前必须披露可能发给 Provider 的数据类别、目标与外部保留限制。
- 凭据与完整环境内容不得写入 Evidence、日志或仓库。

Task 2 的 Fake contract suite 已在本地证明 operation replay 决定性、冲突 payload 拒绝、完整 target identity/过期 deadline fail-closed、由 harness 安排的 completion-like Observation 不等于成功、严格公开响应 schema、游标续读，以及 UNKNOWN outcome 通过独立 reconciliation receipt 处理。Task 3 的本地 fixture 证明原子写入故障后只能读到此前或新的完整事件流、损坏数据 fail-closed、便携 Evidence 不保留已覆盖的凭据/私有 Prompt/设备绝对路径，以及恢复决策对未重新验证的外部事实保持 `NOT_PROVEN`。这些结果不代表真实 Pi、Provider、真实断电或最终产品已经验证。

## 许可状态

Hunter Pi 原创代码与文档采用 [MIT License](LICENSE)。第三方依赖、上游制品及任何复制或改写的外部内容保留各自条款，并必须遵守 [NOTICE 与来源登记规则](NOTICE.md)。许可证选择解除 Task 1 的代码阻断，但不代表已授权发布 npm 包或安装器。

## 文档入口

从 [docs/README.md](docs/README.md) 开始。关键文档：

- [产品愿景](docs/01-product-vision.md)
- [用户体验](docs/02-user-experience.md)
- [系统架构](docs/03-system-architecture.md)
- [工作流语义](docs/04-workflow-semantics.md)
- [上游与插件兼容](docs/05-upstream-and-plugin-compatibility.md)
- [安全与信任](docs/06-security-and-trust.md)
- [用户故事与验收](docs/07-user-stories-and-acceptance.md)
- [实施计划](docs/plans/2026-08-03-foundation-to-daily-use.md)

## 非声明

本仓库当前没有证明：

- 真实模型 Provider 已登录、产生过成功响应或适合付费日常使用；
- 除精确制品已完成的启动、Core 加载、`/hunter-status` 显示、干净退出及人工确认边界外，登录后的交互 TUI、真实模型响应和广泛日常可用性尚未验证；已记录的 smoke 也不构成正式 Human Receipt；
- Pi Session 可以替代 Hunter durable Checkpoint，或 Pi 退出已经清理完整后代进程树；
- 任一第三方 Pi 插件与 Hunter Pi 兼容；
- Pi 上游升级可以无条件自动应用；
- Windows 安装包、签名、自动更新、npm 发布或生产发布已经完成；
- Hunter-Harness 的全部机制已经迁移。
- Fake Host 通过共享 contract suite 代表真实 Pi Host、Provider 或日常使用产品已经通过。
