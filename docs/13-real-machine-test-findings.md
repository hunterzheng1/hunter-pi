# 实机测试问题记录

本文件持续记录 Hunter Pi 在真实用户机器上的测试反馈，并区分功能缺陷、可用性问题、合理设计和外部环境问题。已记录的问题不因修复而删除；状态变化、验证结果和剩余边界以追加方式保留。

## 判定状态

- `待分析`：只有现象，还没有足够证据判断原因或影响。
- `已确认`：现象可以由实现、文档或复现实验解释，确实需要处理。
- `设计选择`：当前行为有明确理由，不直接视为缺陷；仍可评估更好的交互方式。
- `外部环境`：主要原因不在 Hunter Pi，但产品可能仍需改进诊断和恢复指引。
- `已修复待验证`：实现已经修改，尚未在原测试环境复验。
- `已验证`：修复已在原测试环境或等价环境通过。

## 当前测试上下文

- 记录日期：2026-08-13。
- 测试环境：另一台 Windows 机器；Windows 具体版本待记录；PowerShell `7.6.4` 和 Windows PowerShell `5.1` 均已参与安装排查。
- 产品版本：Hunter Pi `0.1.0-dev.1`。
- Engine：`@earendil-works/pi-coding-agent@0.84.1`。
- 精确源码：`d9f2d931b9fc42d23ceae60fada2aee811caf2ec`，运行时报告 `sourceState=CLEAN`。
- 安装结果：远程下载因目标机器的 TLS 证书信任失败而中止；改用已校验的本地 ZIP 后安装成功。
- 当前验证：`hpi version --json` 成功；`hpi update status --json` 返回 `status=READY`；`hpi doctor --json` 返回结构正确但不适合人工阅读的单行 JSON。Provider 登录、真实对话和真实仓库使用不在本轮结论内。

## 问题概览

| ID | 用户反馈 | 初步判定 | 类型 | 建议优先级 | 状态 |
|---|---|---|---|---|---|
| `HP-RU-001` | 安装命令比常见的一行安装复杂 | 真实问题，但不是功能错误 | 首次使用体验 | 高 | 已修复待验证 |
| `HP-RU-002` | `hpi version --json` 输出难以阅读 | 真实问题 | CLI 可读性 | 中 | 已修复待验证 |
| `HP-RU-003` | 多个命令为何必须带 `--json`，能否省略 | 部分是合理设计，部分是接口不一致 | CLI 输出合同 | 中 | 已修复待验证 |
| `HP-RU-004` | 人工检查 Doctor 时被引导使用单行 JSON | JSON 行为正确，人工指引错误 | 文档与诊断体验 | 高 | 已修复待验证 |
| `HP-RU-005` | `setup` 确认前没有显示将保存的模型和权限 | 安全边界合理，确认内容不完整 | 首次配置与披露 | 高 | 已修复待验证 |
| `HP-RU-006` | `setup` 是否应作为首次使用的独立必经步骤 | 必要能力存在，但当前命令流程属于多余仪式 | 首次运行流程 | 高 | 已修复待验证 |
| `HP-RU-007` | 后续版本能否直接运行 `hpi update` 完成更新 | 当前缺少面向普通用户的一键更新入口 | 更新体验 | 高 | 已修复待验证 |

## HP-RU-001：安装入口过于复杂

### 用户观察

当前文档要求先下载安装脚本，再执行带两个参数的安装命令：

```powershell
Invoke-WebRequest `
  https://raw.githubusercontent.com/hunterzheng1/hunter-pi/main/scripts/install.ps1 `
  -OutFile .\install.ps1

powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  -Source Remote `
  -ReleaseTag v0.1.0-dev.1
```

与常见的单行安装方式相比，复制步骤较多，用户还需要理解 `Source`、`ReleaseTag` 和 PowerShell 运行时。

### 判定

这是确认存在的首次使用体验问题，不是安装器功能错误。当前两阶段流程有以下理由：

- 先保存脚本，允许用户在执行前检查内容。
- 显式传入 `ReleaseTag`，避免不知情地安装不同版本的 payload。
- 安装器继续校验 Release ZIP 的 SHA-256 和包内逐文件清单。
- 当前版本仍是未签名的 `developer-preview`，不适合把 `Invoke-RestMethod <url> | Invoke-Expression` 作为唯一推荐方式。

这些理由可以解释当前设计，但不能替代简洁入口。安装器已经具有 `Source=Auto` 和默认版本，说明参数复杂度可以由产品隐藏。当前文档使用可变的 `main` 脚本 URL，也会让「固定精确版本」的意图不够直观。

本轮出现的 TLS 证书信任失败是关联但独立的问题。把命令压缩成一行不会修复证书链、代理或防火墙问题；安装器仍需访问 `github.com` 和 `release-assets.githubusercontent.com`。

### 建议

1. 保留当前「可审查安装」流程，作为安全和故障排查入口。
2. 增加一个官方便捷入口，让普通用户只复制一条命令；入口应使用版本化 Release 安装器、保留 ZIP 校验，并显示即将安装的版本和目标目录。
3. 不建议直接采用 `irm <mutable-url> | iex`。如果提供单行命令，应先下载到临时文件、验证发布的安装器摘要，再执行。
4. 在安装器中为下载失败输出失败 URL、最终域名、错误类型和最小恢复操作。证书校验不得被自动关闭。
5. Stable 阶段优先评估 WinGet 和代码签名，使安装命令、发布身份与升级路径由系统工具统一管理。

### 验收条件

- Windows x64 用户可以通过一条公开命令启动安装，无需理解 `Source`。
- 命令明确选择产品版本，不静默跟随未知的新版本。
- 安装前或安装回执显示产品版本和安装目录。
- ZIP SHA-256、包内清单和现有失败关闭行为保持不变。
- TLS 失败能指出失败域名及安全的恢复方式。
- 文档继续提供本地 ZIP 安装和脚本检查方式。
- 未签名、预览渠道和未完成的真实使用边界仍被明确披露。

## HP-RU-002：版本输出不适合人工阅读

### 用户观察

`hpi version --json` 输出一行完整 JSON，其中包含长提交 ID 和多个 SHA-256 指纹。该格式适合程序解析，但不适合用户快速确认版本、Engine 和渠道。

### 判定

这是确认存在的 CLI 可读性问题。JSON 内容本身有效，问题在于当前快速上手文档把机器格式作为主要人工检查方式，而且 `hpi version` 不带 `--json` 时仍输出完全相同的 JSON。

当前实现无条件调用 `JSON.stringify`，没有人工可读分支：[CLI 实现](../apps/cli/src/cli.ts#L3459-L3464)。相比之下，`hpi doctor` 已经实现「默认人工格式，`--json` 输出机器格式」的模式：[Doctor 输出](../apps/cli/src/cli.ts#L1524-L1545)。

### 建议

让 `hpi version` 默认输出紧凑的人工摘要，例如：

```text
Hunter Pi 0.1.0-dev.1
Engine: Pi 0.84.1
Channel: developer-preview
Source: d9f2d931b9fc (CLEAN)
```

`hpi version --json` 继续输出完整、单行、稳定且可解析的 JSON。完整提交 ID、包名和完整性指纹保留在 JSON 中；人工摘要无需默认展示所有长指纹。

### 验收条件

- `hpi version` 在普通终端中可以快速读出产品版本、Pi 版本、渠道和源码状态。
- `hpi version --json` 保留现有字段和值，不破坏脚本、安装探针和更新验证。
- 人工输出不把摘要截断值冒充完整身份；需要精确身份时明确提示使用 `--json`。
- `--help`、README、用户指南和 CLI 测试使用同一命令合同。

## HP-RU-003：`--json` 的必要性和命令间不一致

### 用户观察

- `hpi version --json` 和 `hpi version` 当前输出相同。
- `hpi update status --json` 成功。
- `hpi update status` 被判为无效参数并打印完整帮助。
- 其他部分命令也要求 `--json`，用户无法判断该参数何时必要。

### 判定

`--json` 有保留必要，但不应对所有命令采用同一强制规则。

JSON 输出用于脚本、CI、Evidence、更新收据和跨版本解析。显式 `--json` 可以避免脚本误解析面向用户、以后可能调整的文字，因此不能全局删除。

当前实现同时存在真实不一致：

- `version` 参数校验允许不带参数，也允许 `--json`：[参数校验](../apps/cli/src/cli.ts#L1346-L1349)。
- `version` 的执行路径不检查该标志，始终输出 JSON。
- 帮助文本却只列出 `version --json`：[帮助文本](../apps/cli/src/cli.ts#L2760-L2769)。
- `update status` 强制要求且只接受 `--json`：[更新参数校验](../apps/cli/src/cli.ts#L1199-L1204)。
- `doctor [--json]` 已经采用更符合用户预期的可选格式。

因此，这不是简单的「删除 `--json`」问题，而是需要统一输出合同。

### 建议规则

| 命令类型 | 默认输出 | `--json` 行为 |
|---|---|---|
| 面向用户的只读命令，如 `version`、`doctor`、`update status` | 人工可读摘要 | 输出完整、稳定的机器格式 |
| 更新、执行和 Evidence 命令，如 `update apply`、`change`、`pilot capture` | 在单独设计人工合同前保持当前严格行为 | 继续输出可持久化的结构化收据 |
| 交互命令，如无参数 `hpi`、`setup`、`login` | 交互或人工文本 | 仅在确有自动化需求时增加 JSON 模式 |

### 验收条件

- `hpi version`、`hpi doctor` 和 `hpi update status` 均可直接执行并提供人工可读输出。
- 对应命令加 `--json` 后只输出一个可解析的 JSON 文档，不混入提示文本。
- 帮助文本明确说明 `--json` 是输出格式选择，不是权限确认或安全开关。
- 现有 JSON schema、枚举、退出码和更新 Evidence 合同不被静默改变。
- 不支持的参数只打印相关命令用法和具体错误，不因一个缺失的输出格式参数打印整份长帮助。

## HP-RU-004：人工 Doctor 检查被引导到机器输出

### 用户观察

按照当前指引运行 `hpi doctor --json` 后，终端显示一行包含多个嵌套检查项的 JSON。用户无法快速区分已通过项、阻断项和下一步操作。

本次输出包含以下事实：

- `overallStatus=BLOCKED`。
- `node`、`git_fixture`、`engine_release` 和 `core_extension` 为 `DETECTED`。
- `configuration` 和 `provider_disclosure` 为 `BLOCKED`，因为尚未运行 `hpi setup`。
- `provider_auth` 为 `BLOCKED`，因为有效配置尚不存在，Doctor 还不能检查 Provider 认证。
- `interactive_tui` 为 `NOT_PROVEN`，需要单独运行真实终端 smoke。

### 判定

Doctor 的状态判断没有显示出功能错误。首次配置尚未完成时返回 `BLOCKED` 符合检查结果，且每个阻断项都提供了 `nextAction`。

单行 JSON 也是 `--json` 的预期机器格式。真实问题是面向普通用户的 README 和用户指南反复要求执行 `hpi doctor --json`，把 Evidence/自动化格式作为人工诊断入口。仓库中的 `hpi doctor` 已经支持逐项人工输出，因此基础修复不需要先重写 Doctor 检查器。

当前人工输出仍可进一步改进：按「需要处理」「已检测」「尚未证明」分组，并把有依赖关系的下一步合并成有序操作，减少用户逐项解释状态的负担。

### 建议

1. 将 README 和用户指南中的普通人工检查命令改为 `hpi doctor`。
2. 只在自动化、Evidence 保存和故障报告附件中使用 `hpi doctor --json`，并明确标注其用途。
3. 保留现有 `hpi-doctor.v1` JSON schema 和单文档输出，避免破坏脚本。
4. 优化人工输出的分组和操作顺序，但不把 `BLOCKED`、`NOT_PROVEN` 或 `DETECTED` 改写成更乐观的状态。

建议的人工操作顺序为：

```powershell
hpi setup
hpi login
hpi smoke tui
hpi doctor
```

`hpi smoke tui` 只验证真实终端启动、Core 加载和退出，不应发送模型请求。实际 Provider 请求仍需要单独授权和明确的测试范围。

### 验收条件

- 快速上手和首次配置流程默认展示 `hpi doctor`，不再要求用户阅读单行 JSON。
- 人工输出把阻断项和对应下一步放在已检测项之前或单独分组。
- 多个检查项依赖同一个动作时，只给出一次清晰、有序的恢复步骤。
- `hpi doctor --json` 继续输出一个符合 `hpi-doctor.v1` 的 JSON 文档。
- `overallStatus`、各检查状态、退出码和未验证边界保持不变。

## HP-RU-005：`setup` 确认内容没有完整显示配置选择

### 用户观察

首次运行 `hpi setup` 时，Hunter Pi 显示 Provider、endpoint、目的地、政策引用、可能发送的数据类别和外部政策边界，然后要求确认版本 `2026-08-03.2`。画面没有显示将被保存的精确模型和权限档位。

### 判定

要求执行 `setup` 本身是合理且必要的安全设计，不是多余步骤。Hunter Pi 的 canonical workflow state 存在本地，不代表模型交互也在本地。首次模型请求前，产品需要说明哪些数据可能离开机器、发送到哪里、哪些外部政策不受 Hunter Pi 控制，并保存一次可撤销、可重新要求的版本化确认。

`setup` 不执行 Provider 登录，不发送模型请求，也不保存 token。首次配置时选择 `N` 会停止流程而不写入配置；选择 `y` 后，产品保存 Provider、模型、endpoint、权限档位、披露版本、解析后的目的地和确认时间。默认配置位于 `%USERPROFILE%\.hunter-pi\config.json`，凭据仍由后续的 Pi 登录流程管理。

本次输出中的以下内容与实现一致：

- 默认 Provider 为 `openai-codex`。
- 当前固定模型离线解析到 `https://chatgpt.com`。
- 可能发送的数据类别包括 prompt、对话上下文、仓库内容、工具结果和请求元数据；Agent 选择文件后，完整文件可能进入模型上下文。
- Hunter Pi telemetry 为关闭状态，Pi 启动时禁止模型目录网络发现；这不表示后续模型请求离线。
- `ExternalRetention=NOT_PROVEN`、`TrainingUse=NOT_PROVEN` 和 `AccountControls=PROVIDER_OWNED` 是保守且正确的边界。Hunter Pi 没有当前账户、套餐、区域和管理设置的绑定证据。

同时确认存在三个实质缺口：

1. 默认配置会保存模型 `gpt-5.6-sol` 和权限 `BALANCED`，但 [披露输出](../apps/cli/src/cli.ts#L1452-L1475) 没有显示这两项。[用户指南](user-guide.md#L114-L131) 却说明 `setup` 会显示精确模型。确认前的信息与实际保存内容不完整一致。
2. 默认 `PolicyReference` 当前指向 [ChatGPT Work 管理员 FAQ](https://learn.chatgpt.com/docs/enterprise/work-admin-faq#how-does-chatgpt-work-support-enterprise-privacy-and-data-commitments)。该页面说明隐私、保留和训练规则取决于套餐、配置、功能和区域，不能作为所有 `openai-codex` 账户的账户级证明。现有 `NOT_PROVEN` 避免了错误承诺，但默认引用的适用范围仍需说明或调整。
3. `ProviderRequests=ENABLED_AFTER_CONSENT` 容易被解释成确认后立即发送或仅凭确认即可发送。实际仍需 Provider 登录和明确的用户操作；Managed Change 与 Pilot 还需要单独的 Provider 请求授权。

### 建议

1. 在确认问题前显示 `Model=<exact-id>` 和 `Permission=<profile>`。
2. 将政策链接标为「参考资料」，并明确账户实际政策取决于套餐和账户控制；如无法获得账户绑定证据，继续保持 `NOT_PROVEN`。
3. 把 Provider 请求状态拆成清晰的独立条件：披露已确认、认证待完成、尚未发送请求。
4. 保持 `setup`、`login` 和首次模型请求为三个独立动作，不把确认视为登录或请求授权。

### 验收条件

- 确认前显示将保存的 Provider、精确模型、endpoint、解析后目的地和权限档位。
- 政策引用说明适用范围，不把企业或特定套餐承诺外推到未知账户。
- 选择 `N` 不保存首次配置、不打开登录、不发送 Provider 请求。
- 选择 `y` 只保存配置和版本化确认，随后明确提示运行 `hpi login`。
- 配置文件不包含 token、cookie、Authorization header 或其他凭据。
- Provider、endpoint、解析后目的地、政策引用或实质披露发生变化时，旧确认失效并要求重新确认。

### 后续复核

`HP-RU-005` 中“`setup` 本身合理且必要”的表述过强。当前安全合同要求的是：在首次外部发送前，产品能说明目的地和数据类别，并阻止未经授权的自动发送。该要求不等于必须保留一个公开、独立且阻塞首次使用的 `hpi setup` 命令。是否继续要求版本化确认，属于产品合同选择；命令组织方式则可以独立简化。后续建议以 `HP-RU-006` 为准。

## HP-RU-006：`setup` 不应是首次使用的独立必经步骤

### 用户观察

Hunter Pi 的默认 Provider、模型、endpoint 和权限档位已经由产品确定。用户仍需先阅读较长披露、确认一个内部版本号，再运行 `hpi login`。这一流程与常见 Agent 工具“运行主命令、登录、开始使用”的体验不一致。用户希望默认接受普通交互所需的 Provider 发送能力，并移除 `setup` 必经步骤。

### 判定

这是确认存在的首次运行流程问题。可以移除 `setup` 作为独立必经步骤；不建议把“移除命令”扩大为“所有能力永久无条件放行”。

当前实现已经说明 `setup` 不是一个独立业务阶段：

- 新配置不存在时，裸命令 `hpi` 会进入七步首次运行流程，并在内部直接调用 `setupCommand`：[首次运行实现](../apps/cli/src/cli.ts#L2204-L2274)。
- `setup` 不执行 Provider 登录，也不发送模型请求。它主要把已知默认值和版本化确认写入配置；自定义参数只是修改这些默认值。
- 用户指南和 Doctor 仍把 `hpi setup` 作为独立恢复动作，导致内部实现已经合并的步骤再次暴露给用户。
- `HP-US-010` 要求 Quick Session 保持低仪式感，但 `HP-US-005` 又要求独立的版本化确认。当前七步向导放大了两个 P0 目标之间的张力。

主流 Agent CLI 的官方流程也不支持“独立 setup 是必要惯例”这一判断：

| 产品 | 普通首次入口 | 仍保留的风险确认 |
|---|---|---|
| [OpenAI Codex CLI](https://developers.openai.com/codex/cli) | 运行 `codex`，选择登录方式，开始任务 | 模型和权限在产品内选择；高权限模式仍有独立边界 |
| [Claude Code](https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust) | 运行主命令并认证 | 首次代码库和新增 MCP Server 需要信任确认，工具动作受权限规则控制 |
| [Gemini CLI](https://geminicli.com/docs/get-started/authentication/) | 运行 `gemini` 并登录 | [Trusted Folders](https://geminicli.com/docs/cli/trusted-folders/) 对项目配置的加载单独确认 |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview) | 运行主命令或单独登录 | 首次目录信任和具体工具动作仍需确认 |

这些产品的共同模式是：默认配置不单独询问；认证进入主流程；确认绑定具体风险对象，例如目录、工具动作、自定义服务或自动化请求。Hunter Pi 当前把 Provider 说明、默认配置、版本化审计和首次认证拆成多个用户步骤，界面成本高于产生的额外控制价值。

“默认允许”可以按以下边界实现：

- 默认 Provider、精确模型、Provider-managed endpoint 和 `BALANCED` 权限自动写入，不要求确认内部披露版本号。
- 用户在交互界面主动提交 prompt，即表示允许该次请求把必要上下文发送给当前显示的 Provider。首次界面仍应以非阻塞摘要说明 Provider、模型、目的地和可能发送的内容，并提供完整说明入口。
- 登录、切换 Provider、自定义 endpoint、自动化 Provider 请求和高风险工具动作继续使用各自的明确操作或授权参数。不能把一次默认配置解释为对以后任意目的地和任意本地操作的永久授权。
- Quick Session 可以取消版本化 Provider 披露确认；Managed Change、Pilot 和非交互执行仍保留现有的 `--allow-provider-request` 等作用域授权。

完全取消版本化确认在技术上可行，但不是删除一个 CLI 分支即可完成。当前 [安全合同](06-security-and-trust.md#model-provider-data-egress) 和 [`HP-US-005`](07-user-stories-and-acceptance.md#hp-us-005--provider-data-disclosure-p0) 把它定义为 P0 验收条件，配置加载和产品启动也会检查该确认。实施前必须先修改产品决策、验收合同和测试，不能让实现静默偏离现有文档。

### 建议流程

普通用户的首次流程改为：

1. 运行 `hpi`。
2. Hunter Pi 自动创建默认配置，并显示一段非阻塞摘要：当前 Provider、精确模型、目的地、权限档位，以及 prompt、所选仓库内容和工具结果可能发送到该目的地。
3. 未登录时直接进入 Provider 登录；用户取消登录时，不发送模型请求。
4. 登录完成后进入交互界面。只有用户提交 prompt 后，才允许首次模型请求。

同时调整命令边界：

- 增加 `hpi config` 或等价的产品内设置入口，用于查看和修改 Provider、模型、endpoint 与权限。
- `hpi setup` 先作为 `hpi config` 的兼容别名保留一个迁移周期，再从帮助和普通文档中移除。
- 增加 `hpi privacy` 或等价帮助页，展示当前完整数据披露、外部政策边界和 Hunter-controlled network/telemetry 状态；该页面不阻断普通启动。
- Doctor 在新配置上不再以“未运行 setup”为阻断原因。未认证时只报告认证所需的下一步。
- 自定义 endpoint、目的地变化、自动化 Provider 请求、插件进程权限和危险工具动作继续单独确认，不继承普通 Quick Session 的默认发送许可。

### 验收条件

- 新用户只运行 `hpi` 即可完成默认配置、登录并进入交互界面，不需要先执行 `hpi setup`。
- 默认配置自动保存 Provider、精确模型、Provider-managed endpoint 和 `BALANCED` 权限。
- 首次界面清楚显示请求目的地和可能发送的数据类别，但不要求确认内部版本号。
- 登录前、用户取消登录后，以及用户尚未提交 prompt 时，均不发送模型请求。
- `hpi config` 可以查看和修改原 `setup` 支持的配置项；现有配置可以无损迁移。
- `hpi privacy` 可以查看完整披露和当前外部政策边界。
- Provider、自定义 endpoint 或解析后目的地变化不会静默继承旧目的地的授权。
- Managed Change、Pilot、非交互请求和高风险工具动作继续要求各自现有的作用域授权。
- 安全合同、用户故事、CLI 帮助、Doctor、配置 schema 和测试在同一变更中更新。

## HP-RU-007：`hpi update` 应直接完成更新

### 用户观察

用户预期在新版本发布后直接运行：

```powershell
hpi update
```

当前版本不支持该入口。`hpi update` 会因缺少子命令而返回参数错误。现有更新流程要求用户自行准备 candidate metadata 和 artifact，再传入两个文件路径：

```powershell
hpi update check --candidate <candidate-file> --artifact <artifact-file> --json
hpi update apply --candidate <candidate-file> --artifact <artifact-file> --json
```

`hpi update status --json` 返回 `status=READY` 只表示更新管理器已就绪、当前安装可管理，不表示已经发现新版本。

### 判定

这是确认存在的更新体验问题。现有 `check`、`apply` 和 `rollback` 已经提供候选验证、artifact 摘要验证、原子切换、历史记录和失败恢复能力，但公开接口仍要求普通用户理解内部发布文件和机器输出合同。底层更新模块较深，面向用户的接口过浅。

普通更新不应要求用户：

- 打开 GitHub Release 页面并判断需要下载哪些内部文件；
- 手工解压并定位 `portable-release-candidate.json` 和 `update.bundle.tgz`；
- 理解 candidate、artifact、qualification 或 release ID；
- 为正常终端操作添加 `--json`；
- 重新运行安装脚本来覆盖已有安装。

`hpi update` 应成为完整的用户级更新操作。现有带 `--candidate` 和 `--artifact` 的命令可以保留为开发、离线恢复和受控验证接口，但不应继续作为普通更新路径。

### 目标行为

运行 `hpi update` 后，Hunter Pi 应按顺序完成：

1. 读取当前产品版本、安装身份和更新渠道。
2. 从该渠道的官方更新源查询最新候选版本。
3. 没有可用更新时，显示当前版本已是最新版本，并保持退出状态成功。
4. 有可用更新时，显示当前版本、目标版本、渠道和下载来源。
5. 下载 candidate metadata 和 artifact。
6. 验证发布身份、版本兼容性、qualification、SHA-256、字节长度和包内清单。
7. 使用现有更新事务安装并原子切换 active release。
8. 对新 release 执行版本、Engine、launcher 和基本健康检查。
9. 更新失败时保持原版本可用；如果 active release 已切换，则自动恢复到更新前版本。
10. 显示最终版本和更新结果。

默认命令不应要求额外参数：

```powershell
hpi update
```

配套命令建议为：

```powershell
hpi update check
hpi update status
hpi update rollback <release-id>
```

`--json` 继续作为可选的机器输出格式。自动化需要跳过交互确认时，可以另行设计明确的非交互参数；不应通过强制 `--json` 来表达更新授权。

### 安全与兼容边界

- 更新只能来自当前配置渠道的官方来源，不能静默跨渠道。
- 更新不能自动降级；降级只通过明确的 rollback 操作完成。
- TLS 或证书验证失败时必须停止，不能自动关闭证书验证。
- candidate、artifact 或 qualification 验证失败时不得修改 active release。
- 用户配置、Provider 凭据、插件登记、会话和更新历史不得随产品版本目录删除。
- 更新过程不得要求 Provider 登录，也不得发送模型请求。
- 旧版本无法识别未来候选 schema 或 Engine 约束时，应返回兼容性错误和恢复指引，不能部分安装。
- 如果发布渠道暂时不可访问，应保留当前版本并显示失败阶段、目标域名和可重试操作。

### 验收条件

- 已安装用户可以只运行 `hpi update` 检查并安装当前渠道的最新合格版本。
- 用户无需下载、解压或传入 candidate 与 artifact 文件。
- 没有更新时，命令明确显示“当前已是最新版本”，并且不修改安装状态。
- 有更新时，命令显示当前版本、目标版本、渠道、下载和验证进度。
- 更新完成后，当前终端和新终端中的 `hpi version` 都解析到目标版本。
- 更新完成后，`hpi update status` 显示新的 active release，并保留可回滚的历史 release。
- 下载、验证、安装或健康检查失败时，原版本仍可启动。
- `hpi update check --candidate ... --artifact ... --json` 和 `hpi update apply --candidate ... --artifact ... --json` 继续作为高级离线接口兼容现有合同，除非通过版本化迁移明确替代。
- Windows 实机测试覆盖无更新、正常更新、网络中断、摘要错误、candidate 不兼容、切换中断、健康检查失败和更新后 rollback。

## 建议处理顺序

1. 先确定 `HP-RU-006` 的产品合同，移除独立 `setup` 必经步骤；不要先美化准备弃用的向导。
2. 把 `HP-RU-005` 中仍有价值的 Provider、模型、目的地、权限和政策边界信息迁移到首次摘要、`hpi config` 和 `hpi privacy`。
3. 实现 `hpi update` 的渠道发现、自动下载、验证、切换和恢复流程，复用现有更新事务。
4. 把人工 Doctor 指引从 `hpi doctor --json` 改为 `hpi doctor`，并优化人工输出的分组。
5. 统一 `version`、`doctor` 和 `update status` 的输出规则，并修正文档、帮助和测试。
6. 在同一改动中实现 `hpi version` 的人工摘要，保留 `--json` 兼容性。
7. 设计并验证单命令安装入口，同时补充 TLS 下载诊断；不要以关闭证书校验换取安装成功。
8. 在原测试机器上复验安装入口、首次配置、版本显示、更新和回滚，再把对应状态改为 `已验证`。

## 修复记录：`0.1.0-dev.2`

2026-08-13 已完成实现和定向自动化验证，尚未在最初反馈机器复验，因此所有条目保持“已修复待验证”：

- `HP-RU-001`：README 和操作手册改为固定 Release 的单行安装入口；安装器下载失败会给出目标域名、底层错误类型、TLS 信任与 HTTPS 检查代理指引，并明确禁止关闭证书校验。本地 ZIP 和可审查脚本流程继续保留。
- `HP-RU-002`：`hpi version` 默认显示产品、Pi Engine、渠道和源码状态的四行摘要；`hpi version --json` 保留完整机器身份。
- `HP-RU-003`：`version`、`doctor` 和 `update status` 统一为默认人工输出、可选 `--json`；无效参数不再自动打印整份长帮助，只提示运行 `hpi --help`。
- `HP-RU-004`：Doctor 人工输出按“需要处理、尚未证明、已检测”分组并合并重复操作；普通文档不再把 JSON 作为人工入口。
- `HP-RU-005`：兼容配置界面和隐私详情同时显示 Provider、精确模型、目的地和权限。政策链接继续只作为参考，未知账户事实保持 `NOT_PROVEN`。
- `HP-RU-006`：裸 `hpi` 自动保存文档化默认值、显示非阻塞隐私摘要、打开登录并进入 Quick Session；`hpi login` 也支持空配置。新增 `hpi config` 和 `hpi privacy`，`hpi setup` 仅作为迁移别名。Managed Change、Pilot 和其他高风险能力的作用域授权没有放宽。
- `HP-RU-007`：`hpi update` 从固定官方 GitHub Release 渠道发现最新预览版本，下载严格候选清单、更新包和绑定的资格 Evidence，并复用现有摘要、原子切换及回滚事务。请求有总超时，最终来源限制在 GitHub 官方域名，且拒绝跨渠道候选。无更新时成功退出；发现、TLS、资格或完整性失败时不修改当前 active release。发布资产新增 `portable-release-candidate.json`、`update.bundle.tgz` 和 `windows-portable-qualification-evidence.json`。

定向自动化覆盖 CLI 人工/JSON 输出、首次运行、直接登录、隐私查看、自动更新发现/无更新/网络失败/元数据漂移，以及安装器与 CI 资产合同。2026-08-13 的完整本地门禁通过 74 个测试文件、766 个测试，以及 lint、类型检查、严格编译、构建、格式、13 个外部包 smoke、单产物 smoke、干净安装和 Pi `0.84.1` 公共接口探针。新 Release 的真实下载、安装、更新和回滚结果仍应在发布后追加，不能提前标为“已验证”。

## 后续问题模板

新增问题时复制以下结构，并保留原始命令、输入和错误文本中的非敏感部分：

```markdown
## HP-RU-NNN：简短标题

### 用户观察

记录操作、期望和实际结果。

### 判定

标记为功能缺陷、可用性问题、设计选择或外部环境，并列出证据。

### 建议

记录最小安全改动及不应破坏的现有合同。

### 验收条件

列出可在原环境复验的成功条件。
```
