# dsh-pta —— PTA（pintia.cn）作业工具包

给 DeepSeek Harness 用的 PTA 工具包，架构照 [dsh-toolkit-educoder](https://github.com/blueforst/dsh-toolkit-educoder) 的分层：

| 层 | 本仓库 | 职责 |
| --- | --- | --- |
| 凭据隔离 | `ctx.credentials` + `lib/accounts.js` | 每个账号一条 `grant` 记录（键 `dsh-pta/account-<uuid>`），Cookie 只在 Host 进程内流动 |
| 面板 | `client.js` + `/dsh-pta/api` | 用户在受保护页面贴 PTASession，直接进凭据服务，不经过模型 |
| 手 | `lib/pta.js` + `lib/service.js` | 拉题、状态、压缩题面、整卷交客观题、交编程题并轮询判题 |
| 嘴 | `index.js` 的 `pta_*` 工具 | 模型能调的动作，返回值一律脱敏、只给摘要 |
| 记性 | `skills/pta-cli/SKILL.md` → `~/.dsh/skills/pta-cli/` | 题型规则、确认规则、坑，由 DSH 原生 Skill 发现 |

## 安全边界

- **Cookie 不进对话、不进日志、不落明文磁盘**：`PTASession` 只写进 DSH 凭据服务；工具与 API 的返回、`redact()` 出口都不含它。
- **按账号隔离**：一个账号一条凭据记录 + 一条元数据；删账号连凭据一起删。
- **面板同源 + 已登录校验**：`ctx.connection.requestRejection(req)` 不通过直接 401/403。
- **题目与答案落盘**：`<stateDir>/work/<PSID>/problems.json|md`、`todo.json`、`sol/`，模型只读需要的那一段。

## 状态目录

默认 `~/.dsh/storages/pta/`：

```
accounts.json          账号元数据（id/标签/状态/昵称/时间，0600，无 Cookie）
work/<PSID>/
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

1. 侧栏出现「PTA 作业」，能添加账号并显示「已登录」。
2. `~/.dsh/skills/pta-cli/SKILL.md` 已同步。
3. 新会话里问「PTA 有哪些没结束的作业」，模型应调用 `pta_accounts` / `pta_sets`。

## 与参考实现的差异

- 参考实现把「手」做成**可编辑 Node CLI + `ctx.shellEnv` 注入 + SessionController 常驻会话 + 工具集收紧**，用于无人值守批量通关；本包只做「工具 + Skill + 凭据隔离」，把调度与自动通关留给用户显式发起。
- 账号元数据用 `accounts.json` 而不是 `node:sqlite`（Electron 内置 Node 版本不保证有 `node:sqlite`），写入走临时文件 + rename，0600。
- 没有引入任何 `@deepseek-ai/*` 依赖，配置 schema 手写 Standard Schema，随 profile 布局都能解析。

MIT。
