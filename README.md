# Hunter Pi

Hunter Pi 是一个面向个人开发者的终端编码 Agent。它将固定版本的 Pi Engine、Hunter Pi 自有的 Workflow Kernel、独立验证、恢复、插件策略和更新回滚组合为一个可独立运行的产品，不依赖 Hunter-Harness 或 Hunter Platform。

Pi 0.83 / Hunter Pi `0.1.0-dev.0` 的历史版本已达到记录范围内的 **Windows x64 unsigned developer-preview 日常使用 GO**。当前 `0.1.0-dev.1` 更新到 Pi `0.84.1` 并新增 ZIP 安装分发；它必须完成自己的 Windows/Ubuntu CI、Release 和发布后下载验证，不能继承旧版本的日常使用结论。两个版本都不是已签名的 Stable 版本。

## 从这里开始

- 第一次使用：阅读[操作手册](docs/user-guide.md)。
- 了解已验证范围：阅读[最终日用验收记录](docs/validation/2026-08-12-task12-daily-use-go.md)。
- 了解设计和历史证据：从[文档索引](docs/README.md)开始。
- 参与开发：阅读[贡献指南](CONTRIBUTING.md)。
- 跟踪当前升级：[Pi 0.84.1 与 Windows Release 验证](docs/validation/2026-08-13-pi-0.84.1-windows-release.md)。

## 已验证状态

- Task 0–12 已在各自记录的范围内完成。
- 最终 Windows pilot 完成 10/10 个预注册任务，覆盖两个 disposable Git 仓库。
- 3/3 个受控中断保留失败历史并在同一 Run 中恢复。
- 两轮资格更新与回滚通过；五组对抗性插件在 Safe Mode 中未执行用户代码。
- 当前 `0.1.0-dev.1` 本地完整门禁通过 73 个测试文件、748 个测试，以及 lint、类型检查、严格编译、构建、格式、13 个外部包 smoke、干净安装和 Pi `0.84.1` 公共接口探针；历史 `0.83` 日用 Evidence 由严格 v1 读取合同保持可读，但不能据此判定新版本日用 `GO`。
- 验收 PR [#83](https://github.com/hunterzheng1/hunter-pi/pull/83) 和精确合并提交的 [main CI](https://github.com/hunterzheng1/hunter-pi/actions/runs/31584966554) 均通过六个 Windows/Ubuntu 必需作业。
- 最终文档合并提交 `aa2b836ab46a83de2fa01b17a8e203b5515748ac` 的 [main CI](https://github.com/hunterzheng1/hunter-pi/actions/runs/31589912791) 通过全部六个必需作业。

完整身份、性能样本、Provider 用量和保留失败见[最终日用验收记录](docs/validation/2026-08-12-task12-daily-use-go.md)。

## 5 分钟上手

### 1. 安装 Windows x64 预览版

不需要预装 Node.js、npm 或 Pi。下载唯一维护的脚本，并固定到精确预览 tag：

```powershell
Invoke-WebRequest `
  https://raw.githubusercontent.com/hunterzheng1/hunter-pi/main/scripts/install.ps1 `
  -OutFile .\install.ps1

powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  -Source Remote `
  -ReleaseTag v0.1.0-dev.1
```

脚本下载精确 Release 的 ZIP 和 SHA-256 文件，校验后安装到：

```text
%LOCALAPPDATA%\HunterPi
```

关闭当前终端并打开新的 PowerShell，然后确认版本和更新状态：

```powershell
hpi version --json
hpi update status --json
```

预期更新状态为 `READY`。如果系统已有其他来源的 `hpi`，安装脚本只告警，不会删除或覆盖旧命令；用 `Get-Command hpi -All` 检查解析顺序。本地 ZIP 和人工校验步骤见[操作手册](docs/user-guide.md#22-从本地-zip-安装)。

### 2. 完成首次配置

安装脚本会幂等维护用户 `PATH`，因此新终端可以直接运行 `hpi`：

```powershell
hpi setup
hpi login
hpi smoke tui
hpi doctor --json
```

- `setup` 显示 Provider、模型、目标 origin、可能外发的数据类别和权限设置，并要求明确确认。
- `login` 打开 Pi 管理的登录界面。Hunter Pi 不读取或复制 token。
- `smoke tui` 只用于首次完整性检查。按提示运行 `/hunter-status` 后退出，不要在 smoke 中发送模型请求。
- `doctor` 返回非零时，不要开始真实项目修改。先按输出中的状态和 `NextAction` 处理。

### 3. 启动 Quick Session

```powershell
cd C:\src\your-project
git status --short
hpi
```

Quick Session 适合解释代码、小范围编辑和交互式排查。它不会自动产生“已独立验证交付”的声明。遇到插件或启动异常时，使用：

```powershell
hpi --safe-mode
```

### 4. 执行 Managed Change

Managed Change 需要干净的实体 Git 仓库、明确的允许路径、一个独立命令检查，以及由 `hpi pilot target` 生成的目标指纹。最小流程和计划 JSON 示例见[操作手册：Managed Change](docs/user-guide.md#执行-managed-change)。

```powershell
hpi change --repo C:\src\your-project --plan .\hpi-change.json --json --allow-provider-request
```

该命令不会 commit、push、publish 或 deploy。即使结果为 `READY`，仍需人工检查 `git diff`，然后自行决定是否提交。

## 常用命令

```text
hpi                              启动 Quick Session
hpi --safe-mode                  仅加载 Core Extension
hpi setup                        配置 Provider、模型和权限
hpi login                        打开 Provider 登录流程
hpi doctor --json                检查安装、配置、认证和完整性
hpi version --json               查看产品、源码和 Engine 身份
hpi change ...                   执行有边界的 Managed Change
hpi plugin list                  查看已管理插件
hpi plugin doctor                检查插件状态和启动条件
hpi update status --json         查看 portable 更新状态
```

运行 `hpi --help` 查看完整参数。`hpi pilot ...` 是验收与证据捕获接口，不是普通日常入口。

## 两种工作模式

| 模式 | 适用情况 | 完成含义 |
|---|---|---|
| Quick Session | 解释、探索、小范围交互修改 | 只记录观察；不声明已独立验证交付 |
| Managed Change | 有明确目标、路径范围和验收命令的修改 | 必需验证通过后才可能为 `READY` |

`READY` 不表示已提交、推送、合并、发布或部署。这些操作需要独立执行和检查。

## 安全边界

- Hunter Pi 本地保存规范工作流状态，但模型请求仍可能把提示、仓库内容、工具结果和对话上下文发送给所选 Provider。
- Pi 插件可能拥有 Agent 进程的文件、进程、网络和凭据访问权限。Compatibility、Trust 和 Isolation 是三个独立结论。
- `--safe-mode` 和 Permission Profile 不是操作系统沙箱。
- Managed Change 会检查目标、Git 状态、允许路径和验证结果，但当前证据不支持“任意真实仓库绝对安全”的声明。重要项目必须保持远端备份，并在执行前确认工作树干净。
- 当前版本未提供签名安装程序、Stable 更新渠道、广泛第三方插件认证、实体断电验证或非 Windows 日用验收。

## 开发与验证

```powershell
npm ci
npm run doctor
npm run probe:pi
npm run verify
```

根目录的 `npm run doctor` 检查开发仓库前置条件；安装后的 `hpi doctor --json` 检查产品安装、Provider 配置、认证元数据、TUI acknowledgement 和制品完整性。两者用途不同。

### 提交方式

日常的小范围文档、测试或低风险修复直接在 `main` 上完成。提交前运行与改动范围相称的本地检查，然后推送 `main`。默认不创建 Pull Request（PR）。

大型改动、高风险改动或需要隔离实验的改动使用临时分支。完成验证后，在本地合并回 `main`，推送 `main`，再删除临时分支和工作树。仅在分支保护、多人评审、外部协作或明确要求时创建远端 PR；不得绕过仓库保护规则。

### CI 路径

CI 始终提供名称固定的 `CI gate` 结果，但会按改动范围选择执行路径：

- 仅修改 `README.md`、根目录治理文档或 `docs/` 时，运行文档快通道。快通道检查依赖锁定安装、格式和空白错误，不重复构建 portable 制品或运行跨平台 Evidence。
- 修改源码、测试、依赖、脚本或 `.github/` 时，运行完整通道。完整通道保留 Windows/Ubuntu 单元测试、静态检查、平台 Evidence、Task 7 containment 和 Windows x64 portable 构建。
- 手动触发 `workflow_dispatch` 时，无论文件范围如何，都运行完整通道。

完整通道把单元测试、质量检查、Task 7 探针、Windows portable 构建、Windows 外部包检查和 Windows 干净安装检查并行执行。Ubuntu 仍执行外部包和干净安装检查，Windows 覆盖不降级。2026-08-12 的首个优化后完整主线运行 `31604073708` 用时 11 分 37 秒，接近约 10 分钟的目标；优化前同类运行约 30 分钟。GitHub 托管 Runner 的排队和负载仍可能造成波动。

## 架构概览

```text
Hunter Pi (`hpi`)
├─ Product Shell               CLI、配置、Doctor、更新
├─ Workflow Kernel             Change、Plan、Run、Attempt、恢复
├─ Pi Host                     通过公开 Pi 接口驱动固定 Engine
├─ Core Extension Bundle       Hunter 工具、命令和状态显示
├─ Plugin Manager              Compatibility、Trust、Isolation
└─ Evidence & Archive          事实、验证收据、Checkpoint、归档
```

Hunter Pi 原创代码和文档采用 [MIT License](LICENSE)。第三方材料继续受各自许可证约束，详见 [NOTICE.md](NOTICE.md)。
