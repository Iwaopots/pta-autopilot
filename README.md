# DSH 适配版 —— PTA（pintia.cn）作业工具包

给 DeepSeek Harness 用的 PTA 工具包，架构照 [dsh-toolkit-educoder](https://github.com/blueforst/dsh-toolkit-educoder) 的分层：

| 层 | 本仓库 | 职责 |
| --- | --- | --- |
| 凭据隔离 | `ctx.credentials` + `lib/accounts.js` | 每个账号一条 `grant` 记录（键 `dsh-pta/account-<uuid>`），Cookie 只在 Host 进程内流动 |
| 面板 | `client.js` + `/dsh-pta/api` | 用户在受保护页面贴 PTASession，直接进凭据服务，不经过模型 |
| 手 | `lib/pta.js` + `lib/service.js` | 拉题、状态、压缩题面、整卷交客观题、交编程题并轮询判题 |
| 嘴 | `index.js` 的 `pta_*` 工具 | 模型能调的动作，返回值一律脱敏、只给摘要 |
| 调度 | `lib/scheduler.js` + `lib/launcher.js` | 任务队列、账号锁、并发、退避重试、崩溃恢复；面板「一键完成」直接开会话投递指令 |
| 记性 | `skills/pta-cli/SKILL.md` → `~/.dsh/skills/pta-cli/` | 题型规则、确认规则、坑，由 DSH 原生 Skill 发现 |

## 安全边界

- **Cookie 不进对话、不进日志、不落明文磁盘**：`PTASession` 只写进 DSH 凭据服务；工具与 API 的返回、`redact()` 出口都不含它。
- **按账号隔离**：一个账号一条凭据记录 + 一条元数据；删账号连凭据一起删。
- **面板同源 + 已登录校验**：`ctx.connection.requestRejection(req)` 不通过直接 401/403。
- **题目与答案落盘**：`<stateDir>/work/<账号>/<PSID>/problems.json|md`、`todo.json`、`sol/`，模型只读需要的那一段。

## 状态目录

默认 `~/.dsh/storages/pta/`：

```
accounts.json          账号元数据（id/标签/状态/昵称/时间，0600，无 Cookie）
tasks.json             任务队列 + 操作日志（version 2）
work/<账号>/<PSID>/
  problems.json        全部题面与配置
  problems.md          可读版
  todo.json            未完成/未 AC 的题目 id
  sol/                 提交过的源码
```

## 安装

在 DSH 的 profile 里安装本目录（工作区绝对路径）：

```
plugin_manager install_bundle target=<本目录绝对路径>
```

或命令行：`dsh plugin --profile desktop add <本目录>`。安装后重启/新开一个会话生效。

## 验证

1. 先 `npm install`（只装测试用的 devDependencies：react / react-dom / jsdom，插件运行时不需要），再跑发版闸门 `npm run gate`（不在本机 DSH 上用 `npm run gate:offline`），最后一行必须是 `ALL GREEN`。面板渲染测试缺依赖会**失败**而不是跳过。Windows 也可以 `pwsh -File scripts\checks-all.ps1`。
2. 重装后 `/_pta/ping`：`tools` 11 个、`toolErrors: []`，`launch.available` 为 `true` 表示「一键完成」可直达模型。
3. 面板顶部显示「一键直达模型」；点某题集「一键完成」→ 会话列表出现「PTA · 题集名」→ 右侧队列走到「完成」。
4. `~/.dsh/skills/pta-cli/SKILL.md` 已同步。

## 发版

```
# 1. 在 CHANGELOG.md 顶部写好 "## x.y.z — 日期"
# 2. 提交改动后：
npm run release -- x.y.z
```

脚本会改版本号 → 跑闸门 → commit → tag → 推送（失败重试 3 次）→ 校验远端 tag。只做普通推送。升级注意事项见 `docs/UPGRADING.md`。

## 配置（cordis.patch.yml）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `maxConcurrent` | 2 | 全局同时执行的任务数（同账号始终串行） |
| `maxAttempts` | 3 | 单任务最多尝试次数（失败指数退避 30s 起，上限 15min；限流至少 5min；登录失效 / 题集未开放不重试） |
| `autoLaunch` | true | 设为 false 则只排队，不自动开会话 |

## Python 离线兜底

本机 `pta/`、`scripts/pta.ps1` 的 Python 版自 v0.3 起降级为**离线应急**，不再与插件同步数据，也不随本仓库发布；日常一律走插件。

## 与参考实现的差异

- 参考实现把「手」做成**可编辑 Node CLI + `ctx.shellEnv` 注入 + SessionController 常驻会话 + 工具集收紧**；本包沿用它的 SessionController 会话注入写法做「一键完成」，但执行只能由用户在面板显式发起，考试类题集默认拒绝。
- 账号元数据用 `accounts.json` 而不是 `node:sqlite`（Electron 内置 Node 版本不保证有 `node:sqlite`），写入走临时文件 + rename，0600。
- 没有引入任何 `@deepseek-ai/*` 依赖，配置 schema 手写 Standard Schema，随 profile 布局都能解析。

MIT。
