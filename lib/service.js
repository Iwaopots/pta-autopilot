/**
 * PTA 作业服务层：把「账号 + 保险箱 + HTTP 客户端 + 本地工作区」拼成一组动作，
 * 同时供 Agent 工具和 Web 面板的 HTTP API 使用。返回值一律是脱敏后的普通对象。
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccounts, AccountError } from './accounts.js';
import { createScheduler } from './scheduler.js';
import { briefLine, CODE_TYPES, createPta, DETAIL, hydrateProblem, passwordLogin, PtaError, redact, todoIds } from './pta.js';

const JUDGE_PENDING = new Set(['WAITING', 'JUDGING', 'SUBMITTED', undefined, null]);
const MAX_CODE_BYTES = 200 * 1024;

/** 源码规范化：去 UTF-8 BOM、CRLF→LF。PTA 遇到 BOM 会报 '\uFEFFint' does not name a type。 */
export function normalizeSource(code) {
  return String(code ?? '').replace(/^\uFEFF+/u, '').replace(/\r\n?/gu, '\n');
}

/** 一键完成投递给模型的指令。只含 id/PSID/账号 id，不含任何凭据。 */
export function buildTaskPrompt(task, accountLabel = '') {
  return [
    `执行 PTA 任务 ${task.id}：题目集 ${task.psid}${task.setName ? `（${task.setName}）` : ''}，账号 ${task.account}${accountLabel ? `（${accountLabel}）` : ''}。`,
    '用户已在「PTA 作业」面板点击「一键完成」，视为对本题目集「直接交 / 全自动」的授权，无需逐题确认；但题集若是限时考试或监考类，立刻停下，用 pta_finish status=failed 说明原因。',
    '按 pta-cli Skill 的流程：pta_pull → pta_status（todo 为空直接收尾）→ pta_brief 分题型读题 → 作答提交（客观题一次交全；编程题样例自测后 pta_submit_prog，同题最多 4 次）。',
    `每做完一个题型或一道编程题，调用 pta_progress id=${task.id} done=<已完成题数> total=<todo 总数> note=<一句话>，面板靠它显示进度。`,
    `全部结束后再跑一次 pta_status 复核，然后 pta_finish id=${task.id} status=done；卡住或做不完则 status=failed 并在 error 写明原因。所有工具调用都带 account: "${task.account}"。`,
  ].join('\n');
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sleep() {
  return delay(1500);
}

export function createService({ ctx, stateDir, log, launcher, scheduler: schedulerOptions = {} }) {
  const accounts = createAccounts({ ctx, stateDir });
  const scheduler = createScheduler({ stateDir, ...schedulerOptions });
  let pumping = false;
  let closed = false;
  let timer;
  const workRoot = join(stateDir, 'work');
  let readyPromise;

  function warn(message, extra) {
    log?.warn?.(`[dsh-pta] ${redact(message)}`, extra);
  }

  async function init() {
    readyPromise ??= accounts.init();
    return readyPromise;
  }

  /** 取某账号的客户端；401 时把账号标记为失效。 */
  async function client(target) {
    const session = await accounts.session(target);
    const pta = createPta({ cookie: session.cookie });
    return { pta, session };
  }

  async function guard(target, fn) {
    const { pta, session } = await client(target);
    try {
      return await fn(pta, session);
    } catch (error) {
      if (error instanceof PtaError && error.code === 'auth_required') await accounts.markAuthRequired(session.id);
      throw error;
    }
  }

  function workDir(psid) {
    return join(workRoot, String(psid));
  }

  async function loadProblems(psid) {
    const file = join(workDir(psid), 'problems.json');
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new AccountError('not_pulled', `还没有拉题：先跑 pta_pull（PSID ${psid}）。`);
      throw error;
    }
  }

  const service = {
    stateDir,
    workRoot,
    scheduler,
    /** 启动后台节拍：每分钟做一次崩溃恢复 + 调度。 */
    startTicker(intervalMs = 60_000) {
      if (timer || closed) return;
      timer = setInterval(() => { void service.pump(); }, intervalMs);
      timer.unref?.();
      setTimeout(() => { void service.pump(); }, 3_000).unref?.();
    },
    async info() {
      await init();
      return {
        stateDir,
        workRoot,
        accounts: accounts.list(),
        defaultAccount: accounts.defaultId(),
        launch: launcher?.capability?.() ?? { available: false, mode: 'none' },
        limits: scheduler.limits,
      };
    },

    async listAccounts() {
      await init();
      return { accounts: accounts.list(), defaultAccount: accounts.defaultId() };
    },

    /** 面板/API 用：账号密码直登，或粘贴 Cookie。密码只用于这一次登录，不保存。 */
    async addAccount({ label, cookie, login, password, ticket, randStr }) {
      await init();
      let token = typeof cookie === 'string' ? cookie.trim() : '';
      const accountName = String(login ?? '').trim();
      if (token === '') {
        if (accountName === '') throw new AccountError('invalid_input', '请填账号和密码，或粘贴 PTASession。');
        token = (await passwordLogin({ login: accountName, password, ticket, randStr })).cookie;
      }
      const account = await accounts.add({
        label: String(label ?? '').trim() || accountName || 'PTA 账号',
        cookie: token,
        login: accountName,
        probe: async (value) => {
          const pta = createPta({ cookie: value });
          return pta.me();
        },
      });
      return { account, accounts: accounts.list(), defaultAccount: accounts.defaultId() };
    },

    /** 用已记录的登录名 + 新密码重新登录（验证码场景带 ticket/randStr）。 */
    async relogin({ id, password, ticket, randStr }) {
      await init();
      const target = accounts.resolve(id);
      const row = accounts.row(target);
      const accountName = row?.login || row?.email || '';
      if (!accountName) throw new AccountError('invalid_input', '这个账号没有记录登录名，请用「添加账号」重新登录。');
      const result = await passwordLogin({ login: accountName, password, ticket, randStr });
      const account = await accounts.add({
        label: row.label || accountName,
        cookie: result.cookie,
        login: accountName,
        probe: async (value) => {
          const pta = createPta({ cookie: value });
          return pta.me();
        },
      });
      return { account, accounts: accounts.list(), defaultAccount: accounts.defaultId() };
    },

    async checkAccount({ id }) {
      await init();
      const target = accounts.resolve(id);
      const account = await accounts.check(target, async (token) => {
        const pta = createPta({ cookie: token });
        return pta.me();
      });
      return { account };
    },

    async removeAccount({ id }) {
      await init();
      const account = await accounts.remove(id);
      return { removed: account.id, accounts: accounts.list(), defaultAccount: accounts.defaultId() };
    },

    async setDefaultAccount({ id }) {
      await init();
      return accounts.setDefault(id);
    },

    /** 每个未结束题目集的完成度（面板用）。 */
    async progress({ account } = {}) {
      await init();
      const target = accounts.resolve(account);
      return guard(target, async (pta) => {
        const sets = await pta.sets({ all: false });
        const rows = [];
        for (const set of sets) {
          let total = -1;
          let todo = 0;
          try {
            const examId = await pta.examId(set.id);
            const statuses = await pta.problemStatus(set.id, examId);
            total = statuses.length;
            todo = todoIds(statuses).length;
          } catch (error) {
            if (error?.code === 'auth_required') throw error;
          }
          const end = set.endAt ? new Date(set.endAt) : null;
          const daysLeft = end && !Number.isNaN(end.getTime())
            ? Math.ceil((end.getTime() - Date.now()) / 86400000) : null;
          rows.push({
            id: set.id, name: set.name, endAt: set.endAt, daysLeft, exam: Boolean(set.exam),
            total, todo, done: total >= 0 ? total - todo : -1,
          });
        }
        return { account: target, sets: rows };
      });
    },

    /**
     * 面板「一键完成 / 交给 Agent」：入队，并在宿主支持时立即开会话执行。
     * 限时考试类题集默认拒绝（红线），allowExam=true 才放行。
     */
    async dispatch({ psid, account, priority = 0, allowExam = false, autoStart = true, setName = '', endAt = '', exam = false } = {}) {
      await init();
      const target = accounts.resolve(account);
      if (!/^\d{1,20}$/u.test(String(psid ?? ''))) throw new AccountError('invalid_input', 'psid 应为数字题目集 ID。');
      if (exam && !allowExam) throw new AccountError('exam_guard', '这是限时考试/监考类题目集，默认不自动做。确认要做请在面板勾选后再派发。');
      const { task, created } = await scheduler.enqueue({ psid: String(psid), account: target, setName, endAt, priority });
      const launch = launcher?.capability?.() ?? { available: false, mode: 'none' };
      if (autoStart && launch.available) void service.pump();
      const { counts } = await scheduler.list();
      return { task, created, pending: counts.pending, running: counts.running, launch };
    },

    /** 某账号下全部未完成题目集一次性派发（跳过考试类与已完成）。 */
    async dispatchAll({ account } = {}) {
      await init();
      const target = accounts.resolve(account);
      const { sets: rows } = await service.progress({ account: target });
      const queued = [];
      const skipped = [];
      for (const row of rows) {
        if (row.total >= 0 && row.todo === 0) continue;
        if (row.exam) { skipped.push({ id: row.id, reason: 'exam' }); continue; }
        const { task, created } = await scheduler.enqueue({ psid: String(row.id), account: target, setName: row.name, endAt: row.endAt });
        if (created) queued.push(task.id);
      }
      const launch = launcher?.capability?.() ?? { available: false, mode: 'none' };
      if (queued.length && launch.available) void service.pump();
      return { account: target, queued, skipped, launch };
    },

    /** 调度泵：在并发上限内不断领取任务并开会话。可重入安全。 */
    async pump() {
      if (pumping || closed || !launcher?.capability?.().available) return { started: 0 };
      pumping = true;
      let started = 0;
      try {
        await init();
        await scheduler.recover();
        for (let guardCount = 0; guardCount < 16; guardCount += 1) {
          const { task } = await scheduler.claim({ launch: launcher.capability().mode });
          if (!task) break;
          started += 1;
          void service.launch(task);
        }
      } catch (error) {
        warn(`调度失败：${error?.message ?? error}`);
      } finally {
        pumping = false;
      }
      return { started };
    },

    /** 为一个已 running 的任务开会话；会话结束而任务没收尾 → 按失败处理（进入重试）。 */
    async launch(task) {
      try {
        const label = accounts.row(task.account)?.label ?? '';
        const { sessionId, done } = await launcher.start({
          taskId: task.id,
          title: `PTA · ${task.setName || task.psid}`,
          prompt: buildTaskPrompt(task, label),
        });
        await scheduler.progress({ id: task.id, sessionId, note: '会话已启动' }).catch(() => {});
        const result = await done;
        const current = await scheduler.get(task.id).catch(() => null);
        if (current?.status === 'running') {
          await scheduler.finish({
            id: task.id,
            status: 'failed',
            error: result.outcome === 'finished' ? '会话结束但未调用 pta_finish 收尾' : `会话异常结束：${result.reason}`,
          });
        }
      } catch (error) {
        const current = await scheduler.get(task.id).catch(() => null);
        if (current?.status === 'running') {
          await scheduler.finish({ id: task.id, status: 'failed', error: `启动会话失败：${redact(error?.message ?? error)}` }).catch(() => {});
        }
        warn(`启动会话失败：${error?.message ?? error}`);
      } finally {
        if (!closed) void service.pump();
      }
    },

    /** 面板队列视图。 */
    async taskBoard() {
      await init();
      const { tasks, counts, limits, readOnly } = await scheduler.list();
      const events = await scheduler.events({ limit: 60 });
      const labels = Object.fromEntries(accounts.list().map((row) => [row.id, row.label]));
      return {
        tasks: tasks.map((task) => ({ ...task, accountLabel: labels[task.account] ?? '' })),
        counts,
        limits,
        readOnly,
        events,
        launch: launcher?.capability?.() ?? { available: false, mode: 'none' },
      };
    },

    async cancelTask({ id }) {
      await init();
      const result = await scheduler.cancel({ id });
      launcher?.cancel?.(String(id));
      return result;
    },

    async retryTask({ id }) {
      await init();
      const result = await scheduler.retry({ id });
      void service.pump();
      return result;
    },

    async bumpTask({ id }) {
      await init();
      const result = await scheduler.bump({ id });
      void service.pump();
      return result;
    },

    async startTask({ id }) {
      await init();
      if (!launcher?.capability?.().available) throw new AccountError('launch_unavailable', '当前 DSH 不支持插件直接开会话，请在对话里说「执行 PTA 任务」。');
      const { task, reason } = await scheduler.claim({ id, launch: launcher.capability().mode });
      if (!task) throw new AccountError('busy', reason === 'concurrency' ? '并发已满，任务会自动排队执行。' : '该任务现在不能启动（账号正忙、退避中或不是待做状态）。');
      void service.launch(task);
      return { task };
    },

    async clearTasks() {
      await init();
      return scheduler.clearFinished();
    },

    /** Agent 领任务：claim=true 时领取一个（遵守账号锁与并发上限）；否则只列 pending/running。 */
    async tasks({ claim = false, id, account } = {}) {
      await init();
      await scheduler.recover();
      if (claim) {
        const { task, reason } = await scheduler.claim({ id, account, launch: 'chat' });
        return { tasks: task ? [task] : [], reason: task ? undefined : reason };
      }
      const { tasks: rows } = await scheduler.list();
      return { tasks: rows.filter((task) => task.status === 'pending' || task.status === 'running') };
    },

    /** Agent 回写进度（同时是心跳）。 */
    async taskProgress({ id, done, total, note }) {
      await init();
      return scheduler.progress({ id, done, total, note });
    },

    /** 任务收尾。failed 且未用尽次数会自动退避重试。 */
    async finishTask({ id, status = 'done', error = '' } = {}) {
      await init();
      const result = await scheduler.finish({ id, status, error });
      void service.pump();
      return result;
    },

    async sets({ account } = {}) {
      await init();
      const target = accounts.resolve(account);
      return guard(target, async (pta) => {
        const rows = await pta.sets({ all: false });
        return {
          account: { id: target, label: accounts.row(target)?.label ?? '' },
          sets: rows.map((row) => ({ ...row, endAtText: (row.endAt ?? '').slice(0, 19) })),
        };
      });
    },

    async pull({ account, psid }) {
      await init();
      const target = accounts.resolve(account);
      if (!/^\d{1,20}$/u.test(String(psid ?? ''))) throw new AccountError('invalid_input', 'psid 应为数字题目集 ID。');
      const id = String(psid);
      return guard(target, async (pta) => {
        const examId = await pta.examId(id);
        const summaries = await pta.summaries(id);
        const problems = [];
        const counts = {};
        for (const [type, summary] of Object.entries(summaries)) {
          if (!summary || !summary.total) continue;
          const items = await pta.problemList(id, examId, type);
          for (const item of items) problems.push(await hydrateProblem(pta, id, examId, item, type));
          counts[type] = items.length;
        }
        const dir = workDir(id);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'problems.json'), JSON.stringify({ psid: id, examId, account: target, problems }, null, 1), 'utf8');
        const md = problems.map((problem) => [
          `## [${problem.type}] ${problem.label} ${problem.title}  id=${problem.id} score=${problem.score}`,
          '',
          problem.content,
          problem.description ? `\n${problem.description}` : '',
          Array.isArray(problem.choices) ? `\n选项: ${JSON.stringify(problem.choices)}` : '',
        ].join('\n')).join('\n\n');
        await writeFile(join(dir, 'problems.md'), md, 'utf8');
        return { psid: id, examId, account: target, counts, total: problems.length, dir };
      });
    },

    async status({ account, psid }) {
      await init();
      const target = accounts.resolve(account);
      const id = String(psid ?? '');
      return guard(target, async (pta) => {
        const examId = await pta.examId(id);
        const rows = await pta.problemStatus(id, examId);
        const stats = {};
        for (const row of rows) {
          const key = `${row.problemType}/${row.problemSubmissionStatus ?? 'UNKNOWN'}`;
          stats[key] = (stats[key] ?? 0) + 1;
        }
        const todo = todoIds(rows);
        await mkdir(workDir(id), { recursive: true });
        await writeFile(join(workDir(id), 'todo.json'), JSON.stringify(todo), 'utf8');
        return { psid: id, examId, stats, todo, todoCount: todo.length };
      });
    },

    async brief({ account, psid, type, max } = {}) {
      await init();
      const data = await loadProblems(psid);
      const limit = Math.min(Math.max(Number(max) || 400, 80), 2000);
      const wanted = type ? String(type).toUpperCase() : null;
      const problems = wanted ? data.problems.filter((problem) => problem.type === wanted) : data.problems;
      return {
        psid: data.psid,
        type: wanted,
        count: problems.length,
        lines: problems.map((problem) => briefLine(problem, limit)),
      };
    },

    async obj({ account, psid, type, answers }) {
      await init();
      const target = accounts.resolve(account);
      const id = String(psid ?? '');
      const problemType = String(type ?? '').toUpperCase();
      if (!DETAIL[problemType]) throw new AccountError('invalid_input', `不认识的题型 ${type}。`);
      if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
        throw new AccountError('invalid_input', 'answers 必须是 {题目ID: "A" | ["A","C"] | "TRUE"} 形式。');
      }
      const data = await loadProblems(id);
      const ofType = data.problems.filter((problem) => problem.type === problemType);
      if (ofType.length === 0) throw new AccountError('invalid_input', `题目集 ${id} 里没有 ${problemType} 题型。`);
      const known = new Set(ofType.map((problem) => problem.id));
      const unknown = Object.keys(answers).filter((key) => !known.has(key));
      if (unknown.length > 0) throw new AccountError('invalid_input', `这些 id 不属于 ${problemType}：${unknown.slice(0, 5).join(', ')}`);
      if (Object.keys(answers).length !== ofType.length) {
        throw new AccountError('invalid_input', `该题型共 ${ofType.length} 题，answers 只给了 ${Object.keys(answers).length} 题（客观题按题型整卷覆盖，必须一次交全）。`);
      }
      const details = Object.entries(answers).map(([problemId, value]) => ({
        problemId: '0',
        problemSetProblemId: problemId,
        [DETAIL[problemType]]: Array.isArray(value) ? { answers: value } : { answer: value },
      }));
      return guard(target, async (pta) => {
        const receipt = await pta.submit(data.examId, { problemType, details });
        return { psid: id, type: problemType, submitted: details.length, submissionId: receipt?.submissionId ?? '', receipt: JSON.parse(redact(JSON.stringify(receipt)).slice(0, 800)) };
      });
    },

    async prog({ account, psid, pid, code, compiler, name } = {}) {
      await init();
      const target = accounts.resolve(account);
      const id = String(psid ?? '');
      const source = normalizeSource(code);
      if (source.trim() === '') throw new AccountError('invalid_input', 'code 不能为空。');
      if (Buffer.byteLength(source, 'utf8') > MAX_CODE_BYTES) throw new AccountError('invalid_input', '代码超过 200KB。');
      const data = await loadProblems(id);
      const problem = data.problems.find((item) => item.id === String(pid) || item.id.endsWith(String(pid)));
      if (!problem) throw new AccountError('not_found', `题目集 ${id} 里没有题目 ${pid}。`);
      if (!CODE_TYPES.has(problem.type)) throw new AccountError('invalid_input', `${pid} 是 ${problem.type}，请用 pta_submit_obj。`);
      const chosen = compiler || problem.compiler || { PROGRAMMING: 'GXX', CODE_COMPLETION: 'GXX' }[problem.type] || 'GXX';
      const key = DETAIL[problem.type];
      const detail = { program: source };
      if (problem.type !== 'SQL_PROGRAMMING') detail.compiler = chosen;
      const extension = name || `${problem.label || pid}`
        .replace(/[^\w.-]+/gu, '_')
        .concat(source.includes('public class') ? '.java' : problem.type === 'SQL_PROGRAMMING' ? '.sql' : '.cpp');
      const file = join(workDir(id), 'sol', extension);
      await mkdir(join(workDir(id), 'sol'), { recursive: true });
      await writeFile(file, source, 'utf8');
      return guard(target, async (pta) => {
        const receipt = await pta.submit(data.examId, {
          problemType: problem.type,
          details: [{ problemId: '0', problemSetProblemId: problem.id, [key]: detail }],
        });
        const submissionId = receipt?.submissionId;
        if (!submissionId) throw new AccountError('platform_error', 'PTA 没有返回 submissionId，结果未确认。');
        await sleep();
        let state = {};
        for (let attempt = 0; attempt < 20; attempt += 1) {
          state = await pta.submission(data.examId, submissionId);
          if (!JUDGE_PENDING.has(state?.status)) break;
          await sleep();
        }
        const fails = [];
        for (const content of state?.judgeResponseContents ?? []) {
          const results = content?.programmingJudgeResponseContent?.testcaseJudgeResults ?? {};
          for (const [caseId, testcase] of Object.entries(results)) {
            if (testcase?.result !== 'ACCEPTED') {
              fails.push({ caseId, result: testcase?.result ?? '', error: redact(testcase?.error ?? '').slice(0, 200) });
            }
          }
        }
        return {
          psid: id,
          pid: problem.id,
          submissionId,
          status: state?.status ?? 'UNKNOWN',
          score: state?.score ?? 0,
          fails,
          file,
        };
      });
    },

    /** 直接跑随包携带的 PTA CLI（@iwaopots/dsh-pta 的 cli/pta.mjs）。 */
    async cli(args = []) {
      await init();
      const list = Array.isArray(args) ? args.map(String) : [String(args)];
      if (list.length === 0) throw new AccountError('invalid_input', 'args 不能为空，例如 ["doctor"]。');
      if (list.length > 40) throw new AccountError('invalid_input', '参数太多。');
      const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'pta-cli', 'cli', 'pta.mjs');
      await mkdir(stateDir, { recursive: true });
      return await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [entry, ...list], {
          cwd: stateDir,
          env: { ...process.env, PTA_STATE_DIR: process.env.PTA_STATE_DIR || stateDir },
          windowsHide: true,
          timeout: 10 * 60 * 1000,
        });
        let out = '';
        let err = '';
        child.stdout?.on('data', (chunk) => { out += chunk; });
        child.stderr?.on('data', (chunk) => { err += chunk; });
        child.on('error', (error) => reject(new AccountError('cli_failed', redact(error?.message ?? error))));
        child.on('close', (code) => {
          resolve({ code, stdout: redact(out.slice(-8000)), text: redact((out + err).slice(-8000)) });
        });
      });
    },

    close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return service;
}
