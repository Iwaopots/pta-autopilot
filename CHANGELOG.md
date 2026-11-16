# Changelog

## 0.5.0 — 2026-11-16

### 多账号
- **工作区分区**：拉题结果、源码、todo 一律写到 `<stateDir>/work/<account>/<psid>/`。两个账号挂同一门课的同一个 PSID 时不再互相覆盖；v0.4 及更早的共享目录 `work/<psid>/` 保留为只读兜底（不用重新拉题）。
- **账号级并发配额**：新增 `perAccountConcurrent`（默认 1，clamp 1~4）。默认同一账号同时只跑一个任务（防风控与状态互踩），调度器按账号 running 数判断，取代原先硬编码的账号锁。
- **跨账号批量派发**：`dispatch.all` 支持 `{ all: true }`，遍历所有 ready 账号各自入队；登录失效的账号跳过并标注原因。
- **任务看板按账号计数**：`tasks.board` 新增 `byAccount`（每账号 pending/running/done/failed/cancelled/total），面板 KPI 与账号行可直接读取。

### 契约（只加不改）
- 新动作参数：`dispatch.all` 的 `all`；新响应字段：`tasks.board.byAccount`、`limits.perAccountConcurrent`。
- 工具签名不变；`pta_*` 的 `account` 语义与之前一致。

### 测试
- 冒烟 12 项（新增：工作区按账号分区 + 旧共享目录只读兜底）。
- 调度 19 项（新增：`perAccountConcurrent=2` 时同账号可并行两个）。

## 0.4.0 — 2026-11-16

### 界面
- **单账号布局**：只有一个账号时，账号收成顶部一条横条（昵称、状态、校验 / 重登 / 添加 / 删除），完成度和任务队列两栏铺开；KPI 去掉「账号已登录」。多账号时仍是三栏。
- **题目格**：点题集名展开每题状态（已通过 / 部分正确 / 答案错误 / 未做），一眼看出哪题没过。
- **完成度筛选**：「全部 / 未完成 n」；标题旁显示「已完成 x/y」。
- **无权限题集**：显示「未开放」和原因，不再挂一个灰掉的「一键完成」；「全部完成」也会跳过它们。
- **任务队列**：分「进行 / 完成 / 失败 / 已取消」四页，已取消不再算进失败；失败带原因标签（登录失效、限流、未收尾…）；每个任务可展开「详情」看自己的时间线；取消执行中的任务要二次确认。
- **登录失效提示条**：队列因登录失效暂停时置顶提示，可直接「重登」或「直接继续」。
- **操作日志**：「全部 / 异常」筛选、按类型着色、一键复制（不含凭据）。
- **KPI**：「已完成任务」改为「今日完成任务」。
- **骨架屏与空状态**：首屏加载显示骨架；空列表给出下一步提示。
- **窄屏**：改用容器查询，按面板实际宽度折叠成两栏 / 单栏，侧栏里打开也不挤。

### 调度
- **按失败原因处理**：`pta_finish` 新增可选 `reason`。登录失效 / 题集未开放 / 考试类不重试；登录失效还会暂停该账号的队列，重登或校验通过后自动继续；限流长退避（至少 5 分钟）；其余照常指数退避。没给 reason 时从错误文本推断。
- **防重复提交**：重试时投递的指令带上次失败原因，并要求先 `pta_status`、只做 todo、已 AC 的不重交。
- 新增 HTTP 动作 `tasks.resume`；`tasks.clear` 支持按状态清理；`tasks.board` 带 `paused`。

### 工程
- `lib/orchestrator.js`：任务编排从 `service.js` 拆出（service 564 → 425 行）。
- **发版闸门** `scripts/gate.mjs`（跨平台）：语法 → 全部离线测试（skip 也算红）→ 版本号与 CHANGELOG 对齐 →（可选）本机 ping 版本一致。`scripts/checks-all.ps1` 改成只含 ASCII 的包装，Windows PowerShell 5.1 不再乱码。
- **一键发版** `scripts/release.mjs`：改版本 → 闸门 → commit → tag → 推送重试 → 校验远端 tag。
- **CI**：`.github/workflows/ci.yml`，push / PR 自动跑 `gate --offline`。
- `test/panel-render.mjs` 缺依赖改为失败；react / react-dom / jsdom 进 devDependencies；面板测试扩到 8 项（单 / 多账号布局、题目格、筛选、队列分页、日志筛选、暂停提示）。
- 调度测试新增 4 项（失败分类、暂停与恢复、重试指令、按状态清理）；冒烟新增版本一致、无 BOM / CRLF 检查。
- 文档：`docs/UPGRADING.md`、`CONTRIBUTING.md`，README 与 ARCHITECTURE 同步。

### 修复
- `/_pta/ping` 的版本号改为读 `package.json`。之前写死常量，v0.3.1 装上后 ping 仍报 0.3.0。
- `package.json` 恢复两空格缩进（v0.3.1 被 PowerShell 改写成了非标准格式）；`scripts/checks-all.ps1` 去掉 BOM。

## 0.3.1 — 2026-11-16

- 新增 `scripts/checks-all.ps1` 发版闸门（Windows）。
- 修 `test/smoke.mjs` 在 Windows CRLF 检出下断言失败；新增 `.gitattributes`（`* text=auto eol=lf`）。
- 版本号升到 0.3.1。注意：远端 tag `v0.3.1` 指向 `9061a8b`，而版本号提交是 `c287494`。

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
