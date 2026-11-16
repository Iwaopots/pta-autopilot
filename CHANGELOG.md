# Changelog

## 0.3.0 — 2026-11-16

### 新增
- **一键完成直达模型**：面板派发后插件经 `sessionController`（兜底 `agents`）自动开会话并 `followup` 指令，无需在对话里补一句；宿主不支持时自动降级为排队 + 对话开工。
- **多账号并发调度器** `lib/scheduler.js`：账号锁（同账号串行）、全局并发上限（默认 2）、临期优先（2 天内截止）、插队、失败指数退避重试（最多 3 次）、心跳超时崩溃恢复、操作日志。
- **任务状态回写**：新工具 `pta_progress`（进度 + 心跳）；`pta_finish` 支持 `error`，失败自动重排。
- **面板三栏**：KPI 概览｜账号｜题目集完成度（进度条、临期标红、考试标记、一键完成 / 全部完成）｜任务队列（进行 / 完成 / 失败，进度条、立即执行、插队、重试、取消、打开会话）｜操作日志；有任务时 3s 轮询。
- HTTP 动作：`dispatch.all`、`tasks.board/start/cancel/retry/bump/clear`；响应带 `apiVersion: 1`；`/_pta/ping` 带 `version`、`apiVersion`、`launch`。
- 配置项 `maxConcurrent`、`maxAttempts`、`autoLaunch`。
- 测试：`test/scheduler.mjs`（含一键完成端到端）、`test/panel-render.mjs`（jsdom 渲染 + 点击）；`npm test` / `npm run check`。

### 修复
- 提交编程题前去 UTF-8 BOM、CRLF→LF（避免 `'\uFEFFint' does not name a type`）。
- `pta_tasks claim=true` 以前会把**所有** pending 一次性标成 running；现在一次领一个并遵守账号锁 / 并发。
- 任务队列写入改为串行化 + 临时文件 rename，避免并发覆盖；已结束任务最多保留 200 条。
- `accounts.json` / `tasks.json` 遇到更高版本只读拒写，插件回退不毁数据。
- `package.json` 版本号与标签对齐（之前停在 0.2.0）；去掉 PowerShell 写出的非标准缩进。
- 文档与代码对齐：删掉不存在的 `lib/vault.js`、`test/mock-pta.mjs` 引用。

### 安全
- 考试类题集（`isExamSet`）派发默认拒绝，`dispatch.all` 自动跳过；投递给模型的指令只含任务 id / PSID / 账号 id，不含任何凭据。
- 旧版队列里遗留的 pending/running 迁移为 cancelled，升级后不会自动开跑。
