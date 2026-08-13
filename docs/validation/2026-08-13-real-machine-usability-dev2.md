# `0.1.0-dev.2` 实机可用性修复验证

## 结论

2026-08-13，本地源码快照完成 `docs/13-real-machine-test-findings.md` 中七项已确认问题的实现与自动化验证。状态为 **IMPLEMENTED，待发布后实机验证**。

不得由本记录推导出以下结论：

- GitHub prerelease `v0.1.0-dev.2` 已发布；
- 原反馈机器已通过新的下载、安装、首次运行、更新或回滚流程；
- Windows 安装包已签名或达到 Stable；
- Pi `0.84.1` 的真实 Provider 请求、真实用户仓库安全或日常使用已验证。

## 已验证行为

- `hpi version`、`hpi doctor`、`hpi update status` 默认输出适合人工阅读；`--json` 保留严格机器输出。
- 裸 `hpi` 使用文档化默认配置，显示非阻塞隐私摘要，进入 Provider 登录，并仅在登录就绪后进入 Quick Session。
- `hpi login` 支持空配置；`hpi config` 和 `hpi privacy` 提供后续配置与边界查看；`hpi setup` 仅保留为迁移别名。
- `hpi update` 只从固定官方 GitHub Release 渠道发现预览版本，使用总超时和最终域名白名单，并拒绝跨渠道候选。
- 自动更新同时验证严格候选、包摘要和与候选及包字节绑定的 Windows portable qualification Evidence，再复用现有原子切换、健康检查和回滚事务。
- 发布资产生成器只在资格状态为 `PASS` 时，从同一冻结快照导出 candidate、bundle 和 qualification Evidence；预资格 CI 不发布可被自动更新消费的三项资产。
- 固定版本的单行安装命令在执行前校验 `install.ps1` SHA-256；安装器保留 ZIP、清单与包内完整性校验，并在 TLS 失败时报告可获得的域名和底层错误类型，不关闭证书验证。

## 自动化证据

定向回归：

```text
Test Files  6 passed (6)
Tests       103 passed (103)
```

完整门禁：

```text
npm run verify
Test Files  74 passed (74)
Tests       766 passed (766)
Strict compiler smoke passed (TS2322, TS2375; NodeNext ESM policy).
External package smoke passed (13 packages).
Single-artifact hpi smoke passed (0.1.0-dev.2, Pi 0.84.1, Doctor BLOCKED, raw Pi unchanged).
Clean npm install smoke passed.
ProviderIndependentProbe=SUPPORTED; RealProvider=NOT_PROVEN
```

完整门禁还包括 lint、类型检查、构建和格式检查。测试未发起真实 Provider 请求，也未修改真实用户仓库。

## 发布后复验

发布 `v0.1.0-dev.2` 后，在原反馈机器至少验证：

1. 从固定 Release URL 执行带安装器 SHA-256 的单行安装命令。
2. 运行 `hpi version`、`hpi doctor` 和裸 `hpi`，确认人工输出、首次登录和 Quick Session 行为。
3. 从 `0.1.0-dev.2` 之后的合格预览版本运行裸 `hpi update`，验证正常更新、无更新、TLS 失败和摘要错误路径。
4. 对更新后的版本运行 `hpi update rollback <release-id> --json`，确认原版本可恢复。
5. 将原始命令、非敏感输出和环境信息追加到实机问题记录；只有对应行为实际通过后，才将条目改为“已验证”。
