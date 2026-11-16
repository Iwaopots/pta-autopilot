/**
 * dsh-pta —— PTA（pintia.cn）作业工具包（Host 半边）。
 *
 * 设计照 dsh-toolkit-educoder 的分层：
 *   · 凭据隔离：PTASession 只存在 DSH 凭据服务里（ctx.credentials），按账号一条记录；
 *     模型只看到 id/标签/昵称，Cookie 不进提示词、不进日志、不落明文。
 *   · 下指令：一族 `pta_*` 工具（描述即流程）+ 写入 ~/.dsh/skills/pta-cli/SKILL.md 的原生 Skill。
 *   · 状态落盘：题目、答案、待办写在本插件自己的 state 目录，工具只回摘要。
 *   · 面板输入：/dsh-pta/api 由 Web 面板调用，Cookie 从表单直达凭据服务，不经过模型。
 */
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLauncher } from './lib/launcher.js';
import { createService } from './lib/service.js';
import { redact } from './lib/pta.js';

export const name = 'dsh-pta';
export const inject = ['webServer', 'tools', 'connection'];

const PKG_ROOT = dirname(fileURLToPath(import.meta.url));
const API_PATH = '/dsh-pta/api';
const MAX_BODY = 512 * 1024;
/** HTTP 契约版本：只加不改；破坏性改动才升。 */
export const API_VERSION = 1;
/** 版本号只从 package.json 读，避免手写常量与发布版本不一致（v0.3.1 的 ping 仍报 0.3.0 就是这个原因）。 */
export const PKG_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
})();

const ERRORS = {
  invalid_input: [400, '请求参数无效。'],
  no_account: [409, '还没有绑定 PTA 账号，请先在「PTA 作业」面板里添加。'],
  account_required: [409, '有多个账号，请指定 account。'],
  not_found: [404, '记录不存在。'],
  auth_required: [409, 'PTA 登录已失效，请重新录入该账号。'],
  invalid_credentials: [409, 'PTA 账号或密码不对（也可能被风控）。'],
  captcha_required: [409, 'PTA 这次要求滑块验证码：密码直登过不去，请切到「粘贴 Cookie」登录一次。'],
  credentials_unavailable: [503, '当前 profile 没有可用的凭据服务。'],
  not_pulled: [409, '还没有拉题：先调用 pta_pull。'],
  not_started: [409, '题目集未开始、已结束或没有权限。'],
  rate_limited: [429, 'PTA 限流，稍后再试。'],
  platform_error: [502, 'PTA 返回异常，操作未确认。'],
  cli_failed: [502, 'PTA CLI 执行失败。'],
  unavailable: [503, '网络暂时不可用。'],
  exam_guard: [409, '限时考试/监考类题目集默认不自动做。'],
  launch_unavailable: [409, '当前 DSH 不支持插件直接开会话。'],
  busy: [409, '任务现在不能启动。'],
  invalid_state: [409, '任务状态不允许这个操作。'],
  state_version: [409, '本地状态文件版本过高，已拒绝写入，请升级插件。'],
};

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('请求过大。'), { code: 'invalid_input' });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求格式无效。'), { code: 'invalid_input' });
  }
}

/** Config：手写 Standard Schema，避免依赖 @deepseek-ai/schemastery。 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-pta',
    validate(value) {
      if (value === undefined || value === null) return { value: {} };
      if (typeof value !== 'object') return { issues: [{ message: 'config 必须是对象', path: [] }] };
      const out = {};
      if (typeof value.stateDir === 'string' && value.stateDir !== '') out.stateDir = value.stateDir;
      if (typeof value.syncSkill === 'boolean') out.syncSkill = value.syncSkill;
      if (typeof value.skillDir === 'string' && value.skillDir !== '') out.skillDir = value.skillDir;
      for (const key of ['maxConcurrent', 'maxAttempts', 'perAccountConcurrent']) {
        if (Number.isInteger(value[key]) && value[key] > 0) out[key] = value[key];
      }
      if (typeof value.autoLaunch === 'boolean') out.autoLaunch = value.autoLaunch;
      return { value: out };
    },
  },
};

function defaultStateDir() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'pta');
}

function defaultSkillDir() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'skills');
}

/** 把随包的 SKILL.md 同步到用户级 skills 目录，让 DSH 原生发现。 */
async function syncSkill(skillDir) {
  const source = join(PKG_ROOT, 'skills', 'pta-cli', 'SKILL.md');
  const target = join(skillDir, 'pta-cli', 'SKILL.md');
  const text = await readFile(source, 'utf8');
  let current;
  try {
    current = await readFile(target, 'utf8');
  } catch {
    current = undefined;
  }
  if (current === text) return { path: target, changed: false };
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  return { path: target, changed: true };
}

const text = (value) => ({ type: 'text', text: value });

function accountLine(row, defaultId) {
  const mark = row.id === defaultId ? ' ←默认' : '';
  const status = row.status === 'ready' ? 'ok' : row.status === 'auth_required' ? '需重新登录' : row.status;
  return `${row.id} | ${row.label} | ${status} | ${row.nickname || '-'}${mark}`;
}

function toolsFor(service) {
  const output = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [text(String(value?.text ?? ''))],
  };

  return [
    {
      name: 'pta_accounts',
      description:
        '列出已绑定的 PTA 账号（id | 标签 | 登录状态 | 昵称）。只返回脱敏信息，不含 Cookie。' +
        '做题前先调用它确认用哪个账号；只有一个账号时可省略后续工具的 account 参数。',
      parameters: {},
      output,
      async execute() {
        const data = await service.listAccounts();
        const lines = data.accounts.map((row) => accountLine(row, data.defaultAccount));
        return {
          text: lines.length ? `${lines.join('\n')}\n-- ${lines.length} 个账号；工作区 ${service.workRoot} --` :
            '还没有绑定 PTA 账号。请打开左侧「PTA 作业」面板，粘贴 PTASession 添加（Cookie 不经过我）。',
          accounts: data.accounts,
          defaultAccount: data.defaultAccount,
        };
      },
    },
    {
      name: 'pta_sets',
      description:
        '列出一个 PTA 账号下未结束的题目集（PSID | 名称 | 截止时间）。' +
        '工作流第 2 步：用户说要做的作业若说不清，用这份列表对照确认 PSID，不要猜。',
      parameters: {
        account: { type: 'string', description: '账号 id（可省略：单账号自动选中，多账号时必填）' },
      },
      output,
      async execute(args) {
        const data = await service.sets({ account: args?.account });
        const lines = data.sets.map((row) => `${row.id} | ${row.name} | end ${row.endAtText || '-'}`);
        return { text: lines.length ? `${lines.join('\n')}\n-- ${lines.length} 个未结束题目集 --` : '没有未结束的题目集。', sets: data.sets };
      },
    },
    {
      name: 'pta_pull',
      description:
        '把题目集的全部题面与配置拉到本地（problems.json / problems.md），返回各题型题量与目录。' +
        '工作流第 3 步，之后用 pta_status 看待办、pta_brief 压缩读题。重复调用会覆盖缓存。',
      parameters: {
        psid: { type: 'string', required: true, description: '题目集 ID（pta_sets 返回的数字 ID）' },
        account: { type: 'string', description: '账号 id（可省略）' },
      },
      output,
      async execute(args) {
        const data = await service.pull({ psid: args?.psid, account: args?.account });
        const counts = Object.entries(data.counts).map(([type, count]) => `${type}:${count}`).join(' ');
        return {
          text: `题目集 ${data.psid} 已拉到 ${data.dir}\n题型：${counts}\n共 ${data.total} 题（exam ${data.examId}）`,
          ...data,
        };
      },
    },
    {
      name: 'pta_status',
      description:
        '查题目集每题的作答状态，返回「题型/状态」统计与 todo（没答、答错、部分通过、代码题未 AC）的题目 id。' +
        'todo 为空就直接汇报完成；否则只做 todo 里的题。',
      parameters: {
        psid: { type: 'string', required: true, description: '题目集 ID' },
        account: { type: 'string', description: '账号 id（可省略）' },
      },
      output,
      async execute(args) {
        const data = await service.status({ psid: args?.psid, account: args?.account });
        const stats = Object.entries(data.stats).map(([key, count]) => `${key}=${count}`).join(' ');
        return {
          text: `题目集 ${data.psid}：${stats}\ntodo ${data.todoCount} 题：${data.todo.slice(0, 60).join(' ') || '-'}`,
          ...data,
        };
      },
    },
    {
      name: 'pta_brief',
      description:
        '按题型把题目压成一行一道（id | 题型 | 题号 | 分值 | 题干 | 选项），用于省 token 读题。' +
        '不带 type 时输出全部题型；需要完整题面时再读 problems.md 的那一段。',
      parameters: {
        psid: { type: 'string', required: true, description: '题目集 ID' },
        type: { type: 'string', description: '题型：TRUE_OR_FALSE / MULTIPLE_CHOICE / MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER / FILL_IN_THE_BLANK / FILL_IN_THE_BLANK_FOR_PROGRAMMING / PROGRAMMING / CODE_COMPLETION（可省略）' },
        max: { type: 'number', description: '题干截断长度，默认 400，最大 2000' },
      },
      output,
      async execute(args) {
        const data = await service.brief({ psid: args?.psid, type: args?.type, max: args?.max });
        return { text: `${data.lines.join('\n')}\n-- ${data.count} 题${data.type ? `（${data.type}）` : ''} --`, ...data };
      },
    },
    {
      name: 'pta_submit_obj',
      description:
        '整卷提交一种题型的客观题。answers 必须是 {题目ID: "A" | ["A","C"] | "TRUE"} 的显式字典，且题数要和 pta_brief 一致——' +
        '客观题在同一题型上后交覆盖前交，截止前平台只显示「已提交」，没有试错机会，所以一次交全、逐题核对。' +
        '提交前把「题号→答案」清单给用户确认（除非用户明确说直接交）。',
      parameters: {
        psid: { type: 'string', required: true, description: '题目集 ID' },
        type: { type: 'string', required: true, description: '题型，如 MULTIPLE_CHOICE / TRUE_OR_FALSE / MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER / FILL_IN_THE_BLANK' },
        answers: { type: 'object', additionalProperties: true, required: true, description: '题目ID → 答案；多选/填空用数组，判断题用 "TRUE"/"FALSE"' },
        account: { type: 'string', description: '账号 id（可省略）' },
      },
      output,
      async execute(args) {
        const data = await service.obj({
          psid: args?.psid, type: args?.type, answers: args?.answers, account: args?.account,
        });
        return { text: `已提交 ${data.type} ${data.submitted} 题（题目集 ${data.psid}，submission ${data.submissionId || '-'}）。客观题结果截止前不可见。`, ...data };
      },
    },
    {
      name: 'pta_submit_prog',
      description:
        '提交编程题/函数题源码并轮询判题，返回 status / score / 失败测试点。' +
        '流程：match 题解（有本地题解库时）→ 现写代码 → 用题面样例自测 → 提交 → 看 fails 里的错误码改代码重交（同题最多 4 次）→ 仍不过就停下说明原因。' +
        'Java 主类必须叫 Main；多线程题要 join() 等子线程结束再输出。',
      parameters: {
        psid: { type: 'string', required: true, description: '题目集 ID' },
        pid: { type: 'string', required: true, description: '题目 id（pta_brief 返回的 id，可只给尾号）' },
        code: { type: 'string', required: true, description: '完整源码' },
        compiler: { type: 'string', description: '编译器，默认按题目配置：GCC/GXX/JAVAC/PYTHON3 等' },
        name: { type: 'string', description: '保存用的文件名（可选）' },
        account: { type: 'string', description: '账号 id（可省略）' },
      },
      output,
      async execute(args) {
        const data = await service.prog({
          psid: args?.psid, pid: args?.pid, code: args?.code, compiler: args?.compiler,
          name: args?.name, account: args?.account,
        });
        const fails = data.fails.length ?
          `\n失败测试点：${data.fails.map((fail) => `${fail.caseId}:${fail.result}`).join(' ')}` : '';
        return {
          text: `题目 ${data.pid} → ${data.status}，得分 ${data.score}（submission ${data.submissionId}，源码 ${data.file}）${fails}`,
          ...data,
        };
      },
    },
    {
      name: 'pta_cli',
      description:
        '直接跑随包携带的 PTA CLI（融合自 @iwaopots/dsh-toolkit-pta）。覆盖 pta_* 工具做不到的场景：' +
        '账号密码/验证码登录、批量 `run` 自动解题（DeepSeek 作答，需 DEEPSEEK_API_KEY）、`serve` 实时看板、`doctor` 自检、`dashboard` 静态看板。' +
        'args 是参数数组，例如 ["doctor"]、["problem-sets"]、["run","--problem-set","123","--mode","todo","--pace","normal","--yes"]。',
      parameters: {
        args: { type: 'array', items: { type: 'string' }, required: true, description: 'CLI 参数数组，例如 ["doctor"]' },
      },
      output,
      async execute(args) {
        const result = await service.cli(args?.args);
        return { text: result.text || `(无输出，退出码 ${result.code})`, ...result };
      },
    },
    {
      name: 'pta_tasks',
      description:
        '查看或领取面板派发的 PTA 作业任务。claim=true 领取一个（遵守账号锁：同账号同时只跑一个；全局并发上限；临期优先），可用 id 指定。' +
        '拿到任务后按 pta-cli 流程做：pta_pull → pta_status / pta_brief → 作答提交；过程中用 pta_progress 回写进度，结束用 pta_finish 收尾。',
      parameters: {
        claim: { type: 'boolean', description: '是否领取（标记 running），默认 false 只查看' },
        id: { type: 'string', description: '只领取这个任务 id（可选）' },
        account: { type: 'string', description: '只领取这个账号的任务（可选）' },
      },
      output,
      async execute(args) {
        const data = await service.tasks({ claim: Boolean(args?.claim), id: args?.id, account: args?.account });
        const lines = data.tasks.map((task) => `${task.id} | PSID ${task.psid}${task.setName ? ` ${task.setName}` : ''} | 账号 ${task.account} | ${task.status} | 第 ${task.attempts}/${task.maxAttempts} 次`);
        const empty = data.reason === 'concurrency' ? '并发已满，稍后再领。' : '没有可领取的任务。';
        return {
          text: lines.length ? `${lines.join('\n')}\n-- 共 ${lines.length} 个；做题中用 pta_progress 回写，结束用 pta_finish --` : empty,
          tasks: data.tasks,
        };
      },
    },
    {
      name: 'pta_progress',
      description: '回写任务进度（也是心跳：超过 20 分钟没有心跳的任务会被判定中断并重排）。每完成一个题型或一道编程题调用一次。',
      parameters: {
        id: { type: 'string', required: true, description: '任务 id' },
        done: { type: 'number', description: '已完成题数' },
        total: { type: 'number', description: 'todo 总题数' },
        note: { type: 'string', description: '一句话进度，例如「单选 10 题已交」' },
      },
      output,
      async execute(args) {
        const { task } = await service.taskProgress({ id: args?.id, done: args?.done, total: args?.total, note: args?.note });
        return { text: `任务 ${task.id}：${task.progress.done}/${task.progress.total} ${task.progress.note}`, task };
      },
    },
    {
      name: 'pta_finish',
      description: '把任务标记为完成（done）或失败（failed）。failed 按 reason 分类处理：登录失效 / 题集未开放不重试（登录失效还会暂停该账号队列），限流长退避，其余未用尽次数时指数退避后重试；收尾前先用 pta_status 复核。',
      parameters: {
        id: { type: 'string', required: true, description: '任务 id（pta_tasks 返回）' },
        status: { type: 'string', description: 'done | failed，默认 done' },
        error: { type: 'string', description: 'failed 时写明原因' },
        reason: { type: 'string', description: 'failed 时的原因分类：auth_required | rate_limited | not_started | compile_error | wrong_answer | other。auth_required / not_started 不会重试' },
      },
      output,
      async execute(args) {
        const data = await service.finishTask({ id: args?.id, status: args?.status === 'failed' ? 'failed' : 'done', error: args?.error, reason: args?.reason });
        const tail = data.task.status === 'pending' ? `（将于 ${String(data.task.nextRunAt).slice(11, 19)} 自动重试）` : '';
        return { text: `任务 ${data.task.id} → ${data.task.status}${tail}`, ...data };
      },
    },
  ];
}

export function apply(ctx, config = {}) {
  const stateDir = config.stateDir ?? defaultStateDir();
  const skillDir = config.skillDir ?? defaultSkillDir();
  const log = ctx.logger;

  ctx.effect(() => {
    const launcher = config.autoLaunch === false ? undefined : createLauncher(ctx, { cwd: join(stateDir, 'work'), log });
    const service = createService({
      ctx, stateDir, log, launcher,
      scheduler: { maxConcurrent: config.maxConcurrent ?? 2, maxAttempts: config.maxAttempts ?? 3, perAccountConcurrent: config.perAccountConcurrent ?? 1 },
    });
    const disposers = [];
    const registered = [];
    const toolErrors = [];

    // 1) 面板 API（同源、已登录才能访问）
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/_pta/ping',
      handler: async (req, res) => {
        json(res, 200, {
          ok: true, plugin: 'dsh-pta', version: PKG_VERSION, apiVersion: API_VERSION, pid: process.pid,
          stateDir, tools: registered, toolErrors,
          launch: launcher?.capability() ?? { available: false, mode: 'disabled' },
          at: new Date().toISOString(),
        });
      },
    }));
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: API_PATH,
      async handler(req, res) {
        try {
          const denied = ctx.connection?.requestRejection?.(req);
          if (denied !== undefined) {
            json(res, denied, { ok: false, error: { code: 'invalid_scope', message: '需要通过已登录的 DSH 页面访问。' } });
            return;
          }
          if (req.method !== 'POST') {
            json(res, 405, { ok: false, error: { code: 'invalid_input', message: '请用 POST。' } });
            return;
          }
          let input;
          try {
            input = await readBody(req);
            const data = await dispatch(service, input);
            json(res, 200, { ok: true, apiVersion: API_VERSION, data });
          } catch (error) {
            const code = typeof error?.code === 'string' && ERRORS[error.code] ? error.code : 'agent_failed';
            const [status, message] = ERRORS[code] ?? [500, '操作未完成。'];
            if (code === 'agent_failed') {
              log?.warn?.('[dsh-pta] API 请求失败', {
                action: typeof input?.action === 'string' ? input.action : undefined,
                errorName: error?.name ?? 'Error',
              });
            }
            json(res, status, { ok: false, error: { code, message: redact(error?.message ?? message) } });
          }
        } catch (error) {
          log?.warn?.(`[dsh-pta] API 处理异常：${error?.message ?? error}`);
          json(res, 500, { ok: false, error: { code: 'handler_failed', message: redact(error?.message ?? error) } });
        }
      },
    }));

    // 2) Agent 工具
    for (const definition of toolsFor(service)) {
      try {
        disposers.push(ctx.tools.register(definition));
        registered.push(definition.name);
      } catch (error) {
        const message = String(error?.message ?? error);
        toolErrors.push(`${definition.name}: ${message}`);
        log?.warn?.(`[dsh-pta] 工具 ${definition.name} 注册失败：${message}`);
      }
    }

    // 3) 调度节拍：崩溃恢复 + 自动开会话（宿主不支持时 pump 直接返回）
    service.startTicker();

    // 4) 原生 Skill：同步到 ~/.dsh/skills/pta-cli/SKILL.md
    if (config.syncSkill !== false) {
      void syncSkill(skillDir).then((result) => {
        if (result.changed) log?.info?.(`[dsh-pta] 已同步 Skill 到 ${result.path}`);
      }).catch((error) => log?.warn?.(`[dsh-pta] Skill 同步失败：${error?.message ?? error}`));
    }

    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* 忽略卸载异常 */
        }
      }
      service.close();
    };
  }, 'PTA 作业工具包');
}

/** HTTP API 动作表（面板用；工具不走这里）。 */
async function dispatch(service, input) {
  const action = String(input?.action ?? '');
  switch (action) {
    case 'info':
      return service.info();
    case 'accounts.list':
      return service.listAccounts();
    case 'accounts.add':
      return service.addAccount({ label: input.label, cookie: input.cookie, login: input.login, password: input.password, ticket: input.ticket, randStr: input.randStr });
    case 'accounts.relogin':
      return service.relogin({ id: input.id, password: input.password, ticket: input.ticket, randStr: input.randStr });
    case 'accounts.check':
      return service.checkAccount({ id: input.id });
    case 'accounts.remove':
      return service.removeAccount({ id: input.id });
    case 'accounts.default':
      return service.setDefaultAccount({ id: input.id });
    case 'sets':
      return service.sets({ account: input.account });
    case 'progress':
      return service.progress({ account: input.account });
    case 'dispatch':
      return service.dispatch({
        psid: input.psid, account: input.account, priority: input.priority, allowExam: input.allowExam === true,
        autoStart: input.autoStart !== false, setName: input.setName, endAt: input.endAt, exam: input.exam === true,
      });
    case 'dispatch.all':
      return service.dispatchAll({ account: input.account, all: input.all === true });
    case 'tasks.board':
      return service.taskBoard();
    case 'tasks.start':
      return service.startTask({ id: input.id });
    case 'tasks.cancel':
      return service.cancelTask({ id: input.id });
    case 'tasks.retry':
      return service.retryTask({ id: input.id });
    case 'tasks.bump':
      return service.bumpTask({ id: input.id });
    case 'tasks.clear':
      return service.clearTasks({ status: typeof input.status === 'string' ? input.status : undefined });
    case 'tasks.resume':
      return service.resumeQueue({ account: input.account });
    default:
      throw Object.assign(new Error(`不认识的 action：${action}`), { code: 'invalid_input' });
  }
}
