# dsh-pta 架构（模块边界 / 稳定性 / 版本策略）

目标：**面板点、模型做**；每个模块可单独拆出使用；DSH 升级 / 插件升级不互相拖垮。

## 1. 分层（每层只依赖下一层，禁止反向依赖）

```
client.js                 ← 仅 UI：调用 HTTP API，不直接碰 PTA / 凭据
  │  POST /dsh-pta/api   {action, ...}  →  {ok, apiVersion, data}
index.js                  ← DSH 适配层：路由 / 工具 / Skill 同步 / 错误映射 / 调度节拍
  │
lib/launcher.js           ← DSH 会话端口：sessionController / agents 能力探测 → 开会话 → followup
  │  （以 port 形式注入 service；缺能力时 available=false，其余功能照常）
lib/service.js            ← 用例层：账号动作、完成度、拉题、判题、派发 / 调度泵（不 import DSH）
  ├── lib/scheduler.js    ← 任务队列：账号锁 / 并发上限 / 临期优先 / 退避重试 / 崩溃恢复 / 操作日志（纯 Node）
  ├── lib/accounts.js     ← 账号目录：accounts.json 元数据 + 凭据端口（ctx.credentials）
  └── lib/pta.js          ← 协议层：pintia HTTP、题型、脱敏、密码登录（纯函数 + fetch）
```

拆走单用：
- `lib/pta.js`、`lib/scheduler.js` 不依赖 DSH，可被 CLI / 测试 / 其他宿主直接 import。
- `lib/service.js` 只依赖 `pta + accounts + scheduler` 和一个可选的 `launcher` 端口，可套到 HTTP / MCP / CLI 任意入口。
- DSH 耦合只在 `index.js`（ctx.webServer / tools / connection / credentials）和 `lib/launcher.js`（sessionController / agents / sessions）两处。
- `client.js` 只认 `/dsh-pta/api` 契约。
- `vendor/pta-cli/` 是第三方快照，可整目录删除，只影响 `pta_cli` 工具。

## 2. 一键完成（会话注入）

```
面板「一键完成」 → dispatch → scheduler.enqueue → service.pump
  → scheduler.claim（并发 ≤ maxConcurrent，同账号串行，临期优先）
  → launcher.start：sessionController.create({sessionId, cwd}) → resolveAgent → agent.followup(createUserMessage(指令))
  → 模型按 Skill 执行，pta_progress 回写进度（心跳），pta_finish 收尾
  → whenIdle 后若任务仍 running：判失败 → 退避重试（30s·2^(n-1)，上限 15min，最多 3 次）
```

- 写法对照 `blueforst/dsh-toolkit-educoder` 的 `plugins/educoder/agent.js`。运行时 `@deepseek-ai/dsh-session`（SessionId）、`@deepseek-ai/dsh-llm`（createUserMessage）从 DSH 宿主解析，本包不声明依赖。
- 能力优先级：`sessionController`（会话出现在 UI 列表，可「打开会话」）→ `agents`（后台会话）→ 不可用（面板提示在对话里说「执行 PTA 任务」，`pta_tasks claim=true` 领取）。
- 服务一律用 `ctx.get(name, false)` 按需取，**不写进 `inject`**：旧版 DSH 缺服务时插件仍能加载。
- 崩溃恢复：每 60s 一次节拍，`running` 超过 20 分钟无心跳 → 按失败处理（进入重试）。
- 红线：考试类题集（`isExamSet`）`dispatch` 默认拒绝（`exam_guard`），`dispatch.all` 直接跳过；模型指令里也要求遇到考试类立即停止。

## 3. 稳定性与版本策略

1. **HTTP 契约版本化**：响应带 `apiVersion: 1`；动作只加不改。v0.3 新增 `dispatch.all / tasks.board / tasks.start / tasks.cancel / tasks.retry / tasks.bump / tasks.clear`，`dispatch` 只加了可选参数。
2. **工具只加不改**：v0.3 新增 `pta_progress`；`pta_tasks` / `pta_finish` 只加可选参数。旧 Skill 仍可用。
3. **状态文件带 `version`**：`accounts.json {version:1}`、`tasks.json {version:2}`。读旧版自动迁移（v1 队列里遗留的 pending/running 迁为 cancelled，不会升级后自动开跑）；遇到更高版本**只读、拒写**（`state_version`），插件回退不会毁新数据。
4. **插件 semver**：`0.MINOR.PATCH`；MINOR 加功能，PATCH 修 bug；见 `CHANGELOG.md`。
5. **能力探测而非版本绑定**：不在模块里 `import '@deepseek-ai/*'`；缺能力时关闭该功能，不崩插件。
6. **回归护栏**（每次发版全跑，`npm test`）：
   - `test/smoke.mjs`：装配、11 个工具、路由、ping 无工具错误、凭据读写、错误映射；
   - `test/scheduler.mjs`：调度器全部规则 + 一键完成端到端（假 sessionController）；
   - `test/client-contract.mjs`：slot 契约；
   - `test/panel-render.mjs`：jsdom + 真 React 渲染面板、点击派发（缺依赖自动跳过）；
   - `test/live-probe.mjs`：真实协议 + 脱敏（需联网）。
7. **文件编码**：所有源码 UTF-8 **无 BOM**、LF。提交给 PTA 的源码经 `normalizeSource` 去 BOM / CRLF。

## 4. 目录

```
dsh-pta/
├── index.js            DSH 适配层
├── client.js           面板（三栏：账号｜完成度｜任务队列 + 操作日志）
├── lib/pta.js          协议层
├── lib/accounts.js     账号目录 + 凭据端口
├── lib/scheduler.js    任务调度器
├── lib/launcher.js     DSH 会话启动器
├── lib/service.js      用例层
├── vendor/pta-cli/     第三方 CLI 快照（可整体删除）
├── skills/pta-cli/     原生 Skill
├── test/               回归测试
└── docs/               DETAIL + 本文件
```
