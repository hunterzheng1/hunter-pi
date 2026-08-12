# Hunter Pi Windows 操作手册

本手册面向在 Windows x64 上使用 Hunter Pi unsigned developer-preview 的个人开发者。内容覆盖安装、首次配置、Quick Session、Managed Change、插件、更新、故障排查和安全边界。

当前版本已在预注册的真实 Windows pilot 中得到 `GO`，但仍不是签名 Stable 版本。重要项目必须有可恢复的 Git 远端备份，并由开发者最终审查和提交变更。

## 1. 使用前确认

### 1.1 支持范围

- 操作系统：Windows x64。
- 源码构建：Node.js 24、npm 11、Git。
- Engine：固定的 Pi `0.83.0`。
- 产品形态：unsigned `developer-preview` portable 目录或本地 npm tarball。

Ubuntu 是必需 CI 平台，但当前没有通过同等级日用 pilot。其他平台保持 `NOT_PROVEN`。

### 1.2 执行真实项目修改前

1. 将重要提交推送到远端备份。
2. 确认当前分支正确。
3. 确认工作树干净。
4. 确认 `hpi doctor --json` 没有阻断状态。
5. 检查当前启用插件；不确定时使用 Safe Mode。

```powershell
git branch --show-current
git status --short
hpi doctor --json
hpi plugin doctor
```

如果 `git status --short` 有输出，不要启动 Managed Change。先提交、暂存到其他安全位置，或明确处理现有修改。Hunter Pi 不会静默接管脏工作树。

## 2. 安装

### 2.1 构建 portable 目录

当前仓库没有公开 npm 包或签名安装程序。从干净源码构建 portable 目录：

```powershell
git clone https://github.com/hunterzheng1/hunter-pi.git
cd hunter-pi
npm ci
npm run pack:windows-portable
```

输出目录：

```text
.artifacts\hpi-windows-x64-portable\
```

portable 目录包含固定 Node.js 运行时、产品 launcher、当前版本和更新元数据。必须整体复制或移动，不要只复制 `hpi.cmd`。

### 2.2 放到固定位置

以下位置只是示例，可换成其他由当前用户控制的绝对路径：

```powershell
New-Item -ItemType Directory -Force C:\Tools\HunterPi | Out-Null
Copy-Item -Recurse -Force ".\.artifacts\hpi-windows-x64-portable\*" C:\Tools\HunterPi\
```

在当前 PowerShell 会话中创建便捷命令：

```powershell
$HpiRoot = "C:\Tools\HunterPi"
function hpi { & "$HpiRoot\hpi.cmd" @args }
```

如需长期使用，可将 portable 根目录加入用户 `PATH`。不要把内部 `versions` 子目录单独加入 `PATH`；根 launcher 负责选择当前版本和执行回滚。

### 2.3 验证安装

```powershell
hpi version --json
hpi update status --json
```

检查结果：

- `version` 应返回产品版本、源码提交、源码状态和 Engine 版本。
- `update status` 应返回 `status=READY` 和当前 `releaseId`。
- 如果 launcher 返回 `BLOCKED`、`INCOMPATIBLE` 或非零退出码，停止首次配置并检查输出。

### 2.4 配置目录

默认配置目录是：

```text
%USERPROFILE%\.hunter-pi
```

如需使用其他位置，在首次运行前设置绝对路径：

```powershell
$env:HUNTER_PI_HOME = "D:\HunterPiState"
```

`HUNTER_PI_HOME` 必须是绝对路径，且不能是磁盘根目录。不要把配置目录提交到项目仓库。

## 3. 首次配置

### 3.1 配置 Provider 和权限

默认配置使用项目当前固定的 Provider、模型和 `balanced` 权限。运行：

```powershell
hpi setup
```

`setup` 会显示：

- Provider 和精确模型；
- endpoint 类别和解析后的 origin；
- 可能发送给 Provider 的数据类别；
- Provider policy reference；
- Hunter Pi 控制的 telemetry 和启动网络设置；
- 外部 retention、training 和账户控制中仍为 `NOT_PROVEN` 或 `PROVIDER_OWNED` 的事实。

确认内容前不要继续。切换 Provider、模型、endpoint、origin 或政策引用后，Hunter Pi 可能要求重新确认。

自定义 Provider 示例：

```powershell
hpi setup --provider <provider-id> --model <exact-model-id> --policy-reference <https-url> --endpoint-category PROVIDER_MANAGED --permission balanced
```

LOCAL endpoint 必须使用精确 loopback origin；CUSTOM endpoint 只接受 HTTPS origin。

### 3.2 登录

```powershell
hpi login
```

该命令打开 Pi 管理的登录界面。在 Pi 中完成 `/login`。Hunter Pi 只保存认证是否已配置等元数据，不提取、复制或输出 token、cookie。

登录和模型请求可能产生外部费用。费用和账户政策由所选 Provider 决定。

### 3.3 验证 TUI

```powershell
hpi smoke tui
```

执行时只做以下操作：

1. 确认 Pi prompt 和 Hunter header 出现。
2. 输入 `/hunter-status`。
3. 确认显示 `HunterStatus=DETECTED Command=/hunter-status`。
4. 退出 Pi。
5. 根据实际观察回答确认问题。

不要在 smoke 中发送普通 prompt 或模型请求。smoke acknowledgement 绑定当前产品壳、Core、源码和配置；相关内容变化后可能需要重新执行。

### 3.4 运行 Doctor

```powershell
hpi doctor --json
```

只有在 Doctor 没有阻断状态时才开始真实项目工作。Doctor 检查安装、固定 Engine、隔离配置、Provider origin、披露确认、认证元数据、产品完整性和 TUI acknowledgement。

## 4. 使用 Quick Session

Quick Session 适合解释代码、探索仓库、小范围修改和交互式排查。

```powershell
cd C:\src\your-project
git status --short
hpi
```

启动前检查界面显示的仓库、分支、模型、Permission Profile 和插件状态。Quick Session 使用当前工作目录，不创建“已独立验证交付”的结论。

常用启动方式：

```powershell
hpi --continue
hpi --resume
hpi --safe-mode
```

- `--continue` 和 `--resume` 将对应会话选择传给固定 Pi Engine。
- `--safe-mode` 禁用用户扩展、skills、prompt templates、themes 和 context files，只显式加载 Core Extension。

退出 Quick Session 只表示进程结束，不表示修改正确。退出后运行项目检查并查看差异：

```powershell
git status --short
git diff --check
git diff
```

## 5. 执行 Managed Change

Managed Change 适合目标、修改路径和验收命令都已明确的工作。当前 CLI 接受严格的 `hpi-managed-change-request.v2` JSON，并生成当前 `hpi-managed-change.v3` Evidence。

### 5.1 前置条件

- 目标必须是实体 Git 仓库根目录。
- 当前工作树必须干净，包括未跟踪文件。
- 目标分支和 Git 配置必须稳定。
- Provider setup 和认证元数据必须就绪。
- 计划必须列出精确相对 `allowedPaths`。
- 计划必须包含一个不修改仓库的独立命令检查。
- 开发者必须明确授权 Provider 请求并确认目标和计划。

Hunter Pi 不会 commit、push、publish 或 deploy。

### 5.2 冻结目标身份

```powershell
hpi pilot target --repo C:\src\your-project --target-id your-project --json
```

预期返回 `status=READY`，并包含：

- `targetId`；
- `selectionMode`；
- `repositoryFingerprint`；
- `sourceFingerprint`；
- `targetReferenceFingerprint`。

虽然命令位于 `pilot` 命名空间，但它只是对显式目标执行只读身份准备，也是当前 Managed Change 计划所需的目标来源。不要手工编造这些指纹。

### 5.3 创建计划

将上一步返回的五个目标字段复制到 `target`。不要复制 `schemaVersion`、`status` 或 `reasons`。

```json
{
  "schemaVersion": "hpi-managed-change-request.v2",
  "title": "修复用户资料校验",
  "goal": "修复资料校验逻辑并通过现有聚焦测试。",
  "nonGoals": [
    "不提交、不推送、不发布、不部署",
    "不调整无关模块"
  ],
  "constraints": [
    "保持现有公开 API",
    "只修改声明的文件"
  ],
  "allowedPaths": [
    "src/profile/validate.ts",
    "test/profile/validate.test.ts"
  ],
  "check": {
    "label": "资料校验聚焦测试",
    "executable": "npm.cmd",
    "argv": ["test", "--", "test/profile/validate.test.ts"]
  },
  "target": {
    "targetId": "your-project",
    "selectionMode": "EXPLICIT_OPERATOR_SELECTED",
    "repositoryFingerprint": "sha256:<复制实际值>",
    "sourceFingerprint": "sha256:<复制实际值>",
    "targetReferenceFingerprint": "sha256:<复制实际值>"
  }
}
```

`allowedPaths` 使用仓库相对路径和 `/` 分隔符。检查命令从仓库根目录运行。Windows 可执行文件名按项目实际情况填写；示例中的 `npm.cmd` 不是所有项目的通用检查。

### 5.4 执行变更

```powershell
hpi change --repo C:\src\your-project --plan .\hpi-change.json --json --allow-provider-request
```

`--allow-provider-request` 只开放该命令的有界 Provider 请求路径。命令仍会要求确认精确目标和请求范围。拒绝确认时，命令在 Provider 请求前停止。

执行期间不要切换分支、修改目标文件或并发运行另一个写入者。目标、工作树或 target reference 发生漂移时，Hunter Pi 会阻断完成。

### 5.5 检查结果

命令结束后：

1. 保存 JSON Evidence。
2. 检查终端 outcome 和 Verification。
3. 检查工作树差异。
4. 重新运行项目要求的完整检查。
5. 由开发者决定是否提交和推送。

```powershell
git status --short
git diff --check
git diff
npm test
```

`READY` 只表示声明的必需检查和 review 门禁允许完成。它不表示代码已经提交、推送、合并、发布、部署或获得其他人员批准。

如果结果为 `BLOCKED`、`FAILED`、`INCOMPLETE`、`NOT_PROVEN` 或包含 `UNKNOWN` 操作，不要直接重复执行相同请求。先保留输出和 Hunter Pi 状态，按 reason code 排查身份、认证、预算、进程 finality 或工作树漂移。

## 6. 管理插件

### 6.1 查看和诊断

```powershell
hpi plugin list
hpi plugin doctor
```

插件状态分为三个独立维度：

- Compatibility：`VERIFIED`、`UNVERIFIED`、`INCOMPATIBLE`；
- Trust：`BUNDLED`、`USER_APPROVED`、`QUARANTINED`；
- Isolation：`CONTAINED`、`PROCESS_AUTHORITY`、`NOT_PROVEN`。

Compatibility `VERIFIED` 不表示插件安全，也不表示插件受到操作系统隔离。

### 6.2 安装

本地来源：

```powershell
hpi plugin install local C:\src\pi-package --label <name> --acknowledge-provenance --allow-process-authority
```

npm 来源：

```powershell
hpi plugin install npm <name@version> --integrity <registry-SRI> --acknowledge-provenance --allow-process-authority
```

Git 来源：

```powershell
hpi plugin install git <https-url> --commit <sha> --tree-fingerprint <sha256> --acknowledge-provenance --allow-process-authority
```

这些命令要求精确来源、完整性和 provenance acknowledgement。`--allow-process-authority` 表示开发者明确知道普通 Pi extension 可能拥有 Agent 进程的文件、进程、网络和凭据访问权限；它不是沙箱授权。

当前 metadata verifier 只会把没有 executable extension surface 的资源包标记为 Compatibility `VERIFIED`。Executable extension 默认保持 `UNVERIFIED` 和 quarantine，除非未来的独立 verifier 证明精确组合。

### 6.3 禁用、移除和安全启动

```powershell
hpi plugin disable <id>
hpi plugin remove <id>
hpi --safe-mode
```

如果启动因插件损坏、冲突或漂移而阻断，先使用 Safe Mode，再运行 `hpi plugin doctor`。不要通过手工编辑 Hunter Pi 状态文件绕过 quarantine。

## 7. 更新和回滚

查看状态：

```powershell
hpi update status --json
```

普通使用者只需在没有已资格化候选时运行状态命令。`check` 和 `apply` 要求匹配的 candidate metadata 与 artifact，通常来自精确通过的 Hunter Pi CI 或受控本地构建：

```powershell
hpi update check --candidate <candidate-file> --artifact <artifact-file> --json
hpi update apply --candidate <candidate-file> --artifact <artifact-file> --json
```

回滚到安装历史中的已知 release：

```powershell
hpi update rollback <release-id> --json
```

不要把任意 tarball 与 candidate 文件组合后强制应用。资格证据、artifact digest、源码身份或 journal 无法验证时，更新必须保持阻断。

## 8. 故障排查

### Doctor 返回非零

1. 保存完整 JSON 输出。
2. 找到第一个 `BLOCKED`、`INCOMPATIBLE` 或 `NOT_PROVEN` 项。
3. 按该项的 `NextAction` 处理。
4. 再次运行 `hpi doctor --json`。

不要把 `NOT_PROVEN` 当成 `PASS`。

### Quick Session 无法启动

```powershell
hpi --safe-mode
hpi plugin doctor
hpi version --json
```

Safe Mode 能启动时，优先检查插件 quarantine、绑定漂移和 Core 冲突。Safe Mode 仍不是操作系统沙箱。

### Managed Change 报 `DIRTY_WORKTREE`

```powershell
git status --short
```

处理所有 staged、unstaged 和 untracked 内容。不要删除无法确认归属的文件，也不要为了通过预检而手工改 Hunter Pi 状态。

### Managed Change 报 `TARGET_IDENTITY_MISMATCH`

确认仓库、分支和源码没有变化。目标确实变化时，重新运行 `hpi pilot target` 并创建新的计划；不要把新指纹写入已经开始执行的旧 Run。

### Provider 登录或请求阻断

```powershell
hpi setup
hpi login
hpi doctor --json
```

重新检查 Provider、模型、origin 和披露内容。不要把 token 粘贴到终端日志、Issue、Evidence 或计划 JSON。

### 更新状态异常

```powershell
hpi update status --json
```

保留输出和 `.hpi-update` 管理状态，不要手工编辑 journal、active pointer 或 candidate metadata。只有已有已知 release 时才执行 rollback。

### GitHub API 限流

限流主要影响 CI 观察和资格更新，不影响本地 Quick Session。CI 操作应使用单一 observer、至少 60 秒间隔和 reset/retry header 退避。详见 [CI 操作说明](ci-operations.md)。

## 9. 日常使用建议

推荐顺序：

1. `git pull --ff-only` 并确认目标分支。
2. `git status --short`。
3. 运行 `hpi doctor --json` 或至少确认最近一次 Doctor 仍适用于当前配置。
4. 小范围探索使用 Quick Session。
5. 有精确范围和验收命令的修改使用 Managed Change。
6. 结束后检查 `git diff --check`、完整 diff 和项目测试。
7. 人工提交和推送。

不要让多个 Agent 或人工编辑器同时写入同一 Managed Change 工作树。不要在重要项目中关闭 Git 备份。

## 10. 非日常命令

以下命令用于 Task 12 验收、Evidence 捕获或内部资格流程：

```text
hpi pilot compile ...
hpi pilot preflight ...
hpi pilot capture ...
hpi pilot evaluate ...
hpi managed fixture ...
```

普通项目日常使用不需要这些命令。不要照搬 pilot interruption 参数；`TERMINAL_CLOSE_SIMULATION` 和 `POWER_LOSS_SIMULATION` 是受控 Pi 进程边界模拟，不代表实体终端或整机断电。

## 11. 当前未声明的能力

当前版本不声明：

- 已签名 Windows 安装程序；
- Stable 更新渠道或公开 npm 发布；
- 任意第三方 executable Plugin 的通用安全性；
- 操作系统级插件 containment；
- 实体整机断电恢复；
- 非 Windows 平台日用验收；
- 任意真实用户仓库的绝对安全；
- 自动 commit、push、merge、publish 或 deploy。

详细证据和边界见[最终日用验收记录](validation/2026-08-12-task12-daily-use-go.md)。
