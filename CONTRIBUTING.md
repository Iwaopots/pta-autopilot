# 贡献约定

- 改代码后跑 `npm run gate:offline`，最后一行必须是 `ALL GREEN`；在装了插件的机器上再跑 `npm run gate`（带本机 ping）。
- 文本文件一律 UTF-8 无 BOM + LF（`.gitattributes` 已强制，`test/smoke.mjs` 会检查）。PowerShell 脚本只写 ASCII，中文放进 `.mjs`。
- 工具和 HTTP 动作**只加不改**；破坏性改动才升 `API_VERSION`。状态文件带 `version`，遇到更高版本只读不写。
- DSH 服务一律 `ctx.get(name, false)` 按需取，不写进 `inject`，保证旧版 DSH 上插件也能加载。
- Cookie / 密码不进文件、日志、对话、命令参数；投递给模型的指令只含任务 id / PSID / 账号 id。
- 发版：先在 `CHANGELOG.md` 写好 `## x.y.z`，提交后 `npm run release -- x.y.z`。只做普通推送，不 force、不 reset。
