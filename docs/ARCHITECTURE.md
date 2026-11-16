# dsh-pta 架构（模块边界 / 稳定性 / 版本策略）

目标：**面板点、模型做**；每个模块可单独拆出使用；DSH 升级/插件升级不互相拖垮。

## 1. 分层（每层只依赖下一层，禁止反向依赖）

```
client.js                 ← 仅 UI：调用 HTTP API，不直接碰 PTA/凭据
  │  POST /dsh-pta/api   {action, ...}
index.js                  ← DSH 适配层：注册路由/工具/Skill、能力探测、错误映射
  │  调用 use-case
lib/service.js            ← 用例层：进度/拉题/判题/账号动作编排（不依赖 DSH）
  │
  ├── lib/pta.js          ← 协议层：pintia HTTP、题型、脱敏（纯函数 + fetch，无状态）
  ├── lib/accounts.js     ← 账号目录：元数据 JSON + 凭据端口（下方）
  └── lib/vault.js        ← 端口定义 + 适配器（DSH credentials / 内存 / 文件）
```

拆走单用：
- `lib/pta.js` 可被 CLI / 测试 / 其他宿主直接 import，不需要 DSH。
- `lib/service.js` 只依赖 `pta + accounts + vault`，可套到任何入口（HTTP、MCP、CLI）。
- `index.js` 是唯一的 DSH 耦合点（`ctx.webServer/tools/connection/credentials`），换宿主只改这一层。
- `client.js` 只认 `/dsh-pta/api` 契约，可独立部署成任何前端。

## 2. 端口与适配器（避免绑定某个 DSH 版本）

| 端口 | 用途 | 适配器 |
| --- | --- | --- |
| `CredentialStore` | 读/写/删账号凭据 | `dshCredentials`（ctx.get('credentials')）、`memory`（测试）、`file`（离线） |
| `PlatformClient` | PTA 请求 | `createPta({cookie, fetchImpl})`，可注入 mock |
| `Clock/Timer` | 判题轮询 | 默认真实实现，测试可注入 |

规则：
- 不在模块里 `import '@deepseek-ai/*'`；DSH 能力一律从 `ctx` 取，取不到就降级并明确报错。
- 能力探测用可选链 + 类型检查，缺能力时**关闭该功能**而不是崩整个插件。

## 3. 稳定性与版本策略

1. **HTTP API 契约版本化**：请求/响应带 `apiVersion: 1`；新增动作只加不改，旧动作保留到主版本。
2. **状态文件带 `version`**：`accounts.json {version:1}`；读旧版自动迁移，写新版本号；未知高版本拒写并报错，不静默覆盖。
3. **插件 semver**：`0.MINOR.PATCH`；MINOR 加功能，PATCH 修 bug；破坏性改动才升主版本并写迁移说明（CHANGELOG）。
4. **对 DSH 的兼容声明**：`package.json` 不写死 `engines.dsh` 精确版本；用能力探测，兼容 0.2.x；升级 DSH 后跑 `test/` 即可判定。
5. **回归护栏**：`test/smoke.mjs`（装配/工具/路由/凭据）、`test/client-contract.mjs`（slot 契约）、`test/live-probe.mjs`（真实协议+脱敏）、`test/mock-pta.mjs`（离线场景）。每次发版全跑。
6. **vendor 隔离**：`vendor/pta-cli/` 是第三方快照，带版本号与 LICENSE；升级只替换该目录，不散落到业务代码。
7. **Skill 与面板解耦**：Skill 只描述"怎么用工具"，不写死 UI 细节；面板改版不影响 Skill。

## 4. 目录

```
dsh-pta/
├── index.js            DSH 适配层（唯一宿主耦合点）
├── client.js           面板（只依赖 HTTP 契约）
├── lib/pta.js          协议层（可独立复用）
├── lib/accounts.js     账号目录（依赖 vault 端口）
├── lib/vault.js        凭据端口 + 适配器
├── lib/service.js      用例层
├── vendor/pta-cli/     第三方 CLI 快照（可整体删除，功能降级）
├── skills/pta-cli/     原生 Skill
├── test/               四层测试
└── docs/               DETAIL + 本文件
```

## 5. 演进顺序

P2 面板「交给 Agent」（dispatch 动作，经 `ctx.sessions/agents`，能力缺失时按钮隐藏）
→ P3 面板三栏化（账号｜完成度｜任务队列）
→ P4 会话保活 + 移除 Python 离线兜底（保留文档）
