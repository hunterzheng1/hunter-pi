# Hunter Pi

Hunter Pi 的目标是成为一个面向个人开发者、可独立安装和使用的终端编码 Agent。它计划以官方 Pi 为底层引擎，把 Hunter-Harness 的计划、执行、验证、证据、恢复和知识机制有选择地重新实现为自己的工作流内核，同时面向标准 Pi 扩展和 Pi Package 生态。当前已在 `main` 完成双平台契约基线、Task 3 持久事件/脱敏 Evidence/重放，以及 Task 4 固定 Pi 公共接口验证；产品入口、交互 TUI 与真实 Provider 仍未实现或验证。

## 当前状态

**Task 4 固定版本 Pi 公共接口 spike 已在 Windows/Ubuntu 完成 provider-independent Evidence 与跨平台身份对账；`hpi` 尚未实现，因此还不是可日常使用产品。**

本仓库已建立 Node.js 24、严格 ESM TypeScript、npm workspaces、仓库 Doctor 与 Windows/Ubuntu CI 基线，并实现严格领域 schema、command/event Workflow Kernel、provider-neutral Engine Host contract、确定性 Fake Host、共享 contract suite、不可变事件/Evidence，以及固定 `@earendil-works/pi-coding-agent@0.83.0` 的公共接口探针。Task 4 在自动创建的临时 Git fixture 中，以隔离配置、Pi offline 启动/package 模式和确定性 faux provider 实测 Extension 身份/有效工具图、JSON、RPC 取消和 SDK 新进程 Session 恢复；操作系统网络隔离、Hunter canonical Checkpoint、unknown-outcome reconciliation、完整后代进程树清理、真实 Provider 和交互 TUI 均未被该证据证明。`hpi` 命令、插件兼容、安装包和自动更新仍未实现或验证。

## 开发基线

需要 Node.js 24、npm 11 和 Git。克隆仓库后运行：

```powershell
npm ci
npm run doctor
npm run probe:pi
npm run verify
```

`doctor` 在当前阶段只检查操作系统、Node.js、npm、Git 和仓库根标记，不探测模型 Provider、登录或凭据。`probe:pi` 构建后在临时 Git fixture 中运行固定 Pi 的离线公共接口探针，默认只把脱敏 JSON 写入 `.artifacts/pi-probe/`；它不会证明真实 Provider 或 TUI。`verify` 会执行全部本地门禁并包含该探针。

## 产品形态

Hunter Pi 最终提供一个独立入口：

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
- 标准 Pi 插件可按策略安装，但插件代码可能拥有当前进程权限；产品必须分别显示兼容性、信任来源和实际隔离状态。
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

- `hpi` 产品入口、真实模型 Provider 或交互 TUI 已可使用；
- Pi Session 可以替代 Hunter durable Checkpoint，或 Pi 退出已经清理完整后代进程树；
- 任一第三方 Pi 插件与 Hunter Pi 兼容；
- Pi 上游升级可以无条件自动应用；
- Windows 安装包、签名、自动更新或生产发布已经完成；
- Hunter-Harness 的全部机制已经迁移。
- Fake Host 通过共享 contract suite 代表真实 Pi Host、Provider 或日常使用产品已经通过。
