# Hunter Pi

Hunter Pi 的目标是成为一个面向个人开发者、可独立安装和使用的终端编码 Agent。它计划以官方 Pi 为底层引擎，把 Hunter-Harness 的计划、执行、验证、证据、恢复和知识机制有选择地重新实现为自己的工作流内核，同时面向标准 Pi 扩展和 Pi Package 生态；这些能力目前均尚未实现或验证。

## 当前状态

**Documentation baseline / 尚无可运行产品。**

本仓库目前只冻结产品定义、架构、领域语言、用户故事、风险和执行计划。`hpi` 命令、安装包、真实 Pi 集成、插件兼容和自动更新均尚未实现或验证。

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

## 许可状态

本仓库当前只包含设计文档，尚未选择公开许可证，也没有 `LICENSE` 文件。除适用法律另有规定外，当前公开可读不等于授予复制、修改或分发许可。可执行代码、外部代码移植和制品发布在许可证与 NOTICE/来源规则确定前均被计划明确阻断。

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

- Hunter Pi 已能启动或控制真实 Pi；
- 任一第三方 Pi 插件与 Hunter Pi 兼容；
- Pi 上游升级可以无条件自动应用；
- Windows 安装包、签名、自动更新或生产发布已经完成；
- Hunter-Harness 的全部机制已经迁移。
