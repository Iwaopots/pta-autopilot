---
name: pta-cli
description: 在 DSH 里用账号密码登录拼题A（pintia.cn），面板点按钮全自动像真人一样完成作业，或用 CLI 跑。触发条件：用户提到 PTA、拼题A、pintia、PTA 作业、PTA 刷题、PTA 自动提交、PTA 面板时使用。
---

# PTA CLI Skill

## 一句话
PTA（拼题A，pintia.cn）的作业平台走账号密码登录：密码只在登录那一刻用，不落盘；登录后会话 cookie 存在各账号自己的目录里（0600），过期自动重登。答案由 DeepSeek 生成，提交按拟人节律走。

## 面板驱动（首选）
```bash
node cli/pta.mjs serve --port 18766   # 打开 http://127.0.0.1:18766/
```
面板上有登录框和操作区，点按钮就跑，不用再跟模型对话。按钮全部来自 `cli/lib/action-registry.mjs`（34 个动作，5 组：账号 / 题集 / 做题 / 监控 / 管理），加功能只加注册项。危险动作（删除账号、停止、真提交）有二次确认；删账号与清缓存服务端还要求显式 `confirm: true`。

常用面板动作：
- 🚀 一键完成作业：选账号 + 题集，点一下全自动做完（真提交，有二次确认）
- 📋 只做未完成的 / ❌ 只做错题 / 🎯 单题重做 / 👁️ 只解题不提交（答案预览）
- ⏸️ 暂停 / ▶️ 继续 / ⏹️ 停止
- ⏱️ 节律档位切换（慢/正常/快，运行中换档下一次等待即生效）
- 🧐 查看待复核 / ✅ 验收通过 / 🔧 返工重做（见“待复核队列”）

## 待复核队列
低置信（客观题 3/4 一致率 < 0.75）/ 停表 blocked / 自测失败的题进队列等人处理，
最多返工 5 次（`MAX_REWORK`）。面板上的“待复核”区列出原因与返工次数，下拉框选一道
题，点“验收通过”（人工已看过，不再自动处理）或“返工重做”（再跑一遍，成功后自动验收）。
返工满 5 次置 exhausted。接口：`GET /api/review`、`POST /api/review/accept`、
`POST /api/review/rework`。

## 任务队列
`serve` 的任务走 `cli/lib/job-queue.mjs`（vardiya 机制移植到 `node:sqlite`，MIT，
零新增依赖）：单-flight（同一时间只跑一个全链路任务）、幂等键落库去重（同一 key
重复提交返回同一任务）、原子认领、backoff + 维护循环、崩溃恢复（启动扫尾）、优雅停机。
面板任务失败即 dead、不自动重试，重试由用户点“失败重试”建新任务。

## 命令（工作区 CLI：`node "$DSH_PTA_CLI" <subcommand>`，默认 CLI 在 `plugins/pta/cli/pta.mjs`）

```bash
node cli/pta.mjs doctor                                        # 自检：node 版本、状态目录、账号数
node cli/pta.mjs login --user <邮箱或手机号> --label <名字> [--remember]  # 交互输密码登录（密码不落盘）
node cli/pta.mjs logout [--account <id|label>]                 # 登出（清会话）
node cli/pta.mjs accounts                                      # 列账号（只显示掩码，不输出 cookie）
node cli/pta.mjs problem-sets [--account <id|label>]           # 题集列表
node cli/pta.mjs problems --psid <id> [--type PROGRAMMING]     # 拉题
node cli/pta.mjs status --psid <id> --exam-id <E>              # 每题状态 + 写进度缓存
node cli/pta.mjs submit --exam-id <E> --type <TYPE> --answers <answers.json> [--yes]  # 先预览，不加 --yes 不真交；真交后轮询判题
# 客观题三格式：--psid <id> --type <TYPE> --answers <answers.json>（["A","BC"] / {"1":"A"} / [{index,answer}]，须覆盖该题型全部题目）
# 编程题单题：--program-path <work 内文件> --problem <pspId> [--compiler GCC]（只读账号 work 目录内的文件，越界拒绝）
node cli/pta.mjs run --problem-set <id> [--mode all|todo|wrong|one] [--only-problem <id>] [--pace slow|normal|fast] [--max-fixes N] [--yes] [--finish]
node cli/pta.mjs serve [--port <n>]                            # 实时看板 + 操作接口
node cli/pta.mjs dashboard [--account <id|label>]              # 生成静态看板 dashboard.html
```

## 账号与空间
- 状态根目录：`$PTA_STATE_DIR` 或 `~/.pta`；每账号独立目录 `accounts/<id>/`，下有 `session.json`、`progress/`（进度缓存 + `audit.jsonl`）、`work/`。
- 账号表 `accounts.json` 只存 id / label / 登录名 / 登录名掩码 / 状态，不存密码、不存原始 cookie。
- 切号即切空间：所有命令接受 `--account <id|label>`；不传时只有一个账号自动选中，多个必须指明；面板上有“切换账号”。
- `login --remember` 只记凭据引用（key `dsh-pta/account-<id>`），不记密码。重登时按 `lib/credentials.mjs` 找密码：`PTA_PASSWORD` + `PTA_PASSWORD_ACCOUNT`（须匹配该账号）、`PTA_CREDENTIAL_CMD`（如 `dsh credentials get {key}`）、`DSH_CREDENTIALS_DIR`；都找不到就停下报人工。

## 答案生成（DeepSeek）
- key 只从环境变量 `DEEPSEEK_API_KEY` 读，绝不写进文件；模型默认 `deepseek-chat`，可用 `DEEPSEEK_MODEL` 覆盖（面板设置里也能改）；`DEEPSEEK_MAX_TOKENS` 默认 200000，超了就停。
- 客观题：3 次采样 + 1 次选项重排，多数投票，一致率当置信度代理；**阈值 0.75 只是初值、无文献依据**，需在目标题库 + DeepSeek 上用 100–400 道题校准（自动提交桶准确率目标 ≥90%）；低于阈值不提交、进待复核队列。
- 编程题：生成代码后本地编译/跑题目样例，失败把“最后 30 行报错 + 最多 3 个失败用例”喂回模型，先解释再改；停表：轮数上限（`--max-fixes` 默认 3，最多 5）、连续 2 轮报错完全相同、连续 2 轮通过样例数零增长。
- 本地自测支持 GCC / GXX / PYTHON3（本机有 gcc、python3；JAVAC 需本机有 JDK，无 JDK 时走服务端自定义测试 `customTestData` 先验）。

## 做题流程（run 全链路）
1. 会话复用检查（过期自动走凭据重登）→ 拉题集 → 拉题 → 拉每题状态，只做未通过的。
2. 客观题：DS 解题，按题型分组整卷一次提交；编程题：DS 解题 → 本地自测 → 按账号种子做代码差异化（改名/空行/注释，变换后重跑样例，失败回退原代码）→ 提交 → 轮询判题；判不过把判题反馈喂回模型改一次再交，只重试 1 次。
3. 全程拟人节律：读题按中文 300 字/分基准（已验证的保守基准）× 难度系数 × 对数正态抖动；粘贴分段打字；提交前停顿对数正态采样；题间间隔指数分布；两次提交间隔 ≥15 秒；全部是真实 sleep。档位 slow/normal/fast（fast 只用于测试）。
4. 每步写 `state.json`（看板数据源）+ 每账号 `progress/audit.jsonl` 审计日志。
5. `run` 不加 `--yes` 只解题不提交（dry-run）；加 `--yes` 才真交；`--finish` 才调交卷接口（触发客观题判题）。
6. 低置信 / 停表 / 自测失败的题进待复核队列，不自动提交，等人工验收或返工。

## 登录与验证码
- 登录接口：`POST passport.pintia.cn/api/users/sessions`，body `{email|phone, password, rememberMe, ticket, randStr}`。
- 先无票发一次；网关回 `GATEWAY_WRONG_CAPTCHA` 时走纯协议滑块求解器（`lib/captcha.mjs` + `lib/locate.py`，约 60 秒/次，依赖 Python 3 + Pillow + numpy）；求解失败则带 `--ticket <T> --rand-str <R>` 手工重试。
- 会话复用判定走 `GET /api/u/current`；失效先试凭据重登，拿不到密码就停下报人工，不要反复登录触发风控（登录限频 20s）。

## 红线
- 只做平时练习 / 作业题集，**不碰正式考试**（PTA 正式考试接 OMS 监考，自动化提交可能被记违规）。题集 type 为 EXAM / FORMAL / OMS 或带监考标记时直接拒绝并记日志。
- 提交前必须确认；编程题必须先本地自测通过才交；自测不过不交。
- 凭据不进仓库：`~/.pta/`、`session.json` 一律 gitignore。
- 接口来自第三方逆向笔记，未实测的调用标 `TODO(verify)`；实测一轮后再消标记。
- 保守兜底（RESEARCH.md §13.5）：代码差异化默认开、节律默认 slow/normal 不开 fast、00:00–06:00 不批量跑、单账号单 IP、同一题集单日全量跑 ≤2 次、低置信不自动交、JSONL 审计日志；一旦平台出现明确反作弊提示或警告，立即停跑、人工处理。
- 交卷自研状态：`PUT /api/exams/{exam_id}/end` 全网无人实现，只能先在 mock/练习 exam 上实测；交卷不可逆，默认不交卷（`--finish` 显式开启）；禁止盲重试；7 条小心事项与验证方案见 PLAN.md §11.4。
- 浏览器兜底（HZ Fiber 链）选择器层未验证：RESEARCH.md §13.3 有 10 条实测清单，须在已登录浏览器会话里按条执行；第 1 或第 3 条失败则 Fiber 链已死，不再往 DOM 路线投时间。
