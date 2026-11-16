# @iwaopots/dsh-pta（DSH 拼题A作业平台插件）

在 DSH 里跑的拼题A（pintia.cn）作业平台：账号密码登录、多账号隔离、
进度可视化、DS（DeepSeek）自动解题、拟人化节律提交。

> 注意：`main` 现在指向 CLI 入口 `cli/pta.mjs`。
> 真正的 DSH 插件入口（`index.js` + `registerApi` + scheduler/worker +
> DSH 原生面板）是 v0.3 的工作，见仓库根目录 `PLAN.md` §11。
> 当前形态是 CLI + skill + 本地 `serve` 面板，可在 DSH 工作区终端里跑。

## 快速开始

```bash
node cli/pta.mjs login --user <邮箱或手机号> --label <名字> --password-stdin
node cli/pta.mjs run --problem-set <题集ID> --yes --pace normal
node cli/pta.mjs serve --port 18767   # 打开 http://127.0.0.1:18767 看面板
```

完整用法见仓库根目录 `README.md`；命令参考见 `skills/pta-cli/SKILL.md`。

## 红线

- 只做平时练习 / 作业题集，正式考试（exam 类型或带 OMS 标记）直接拒绝，绝不碰。
- 密码只在登录那一刻用，永不落盘；会话 cookie 只存账号自己的目录（0600）。
- 编程题提交前必须本地自测通过；客观题整卷一次提交；真交要 `--yes` 或面板二次确认。
