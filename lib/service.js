/**
 * PTA 作业服务层：把「账号 + 保险箱 + HTTP 客户端 + 本地工作区」拼成一组动作，
 * 同时供 Agent 工具和 Web 面板的 HTTP API 使用。返回值一律是脱敏后的普通对象。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAccounts, AccountError } from './accounts.js';
import { briefLine, CODE_TYPES, createPta, DETAIL, hydrateProblem, passwordLogin, PtaError, redact, todoIds } from './pta.js';

const JUDGE_PENDING = new Set(['WAITING', 'JUDGING', 'SUBMITTED', undefined, null]);
const MAX_CODE_BYTES = 200 * 1024;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sleep() {
  return delay(1500);
}

export function createService({ ctx, stateDir, log }) {
  const accounts = createAccounts({ ctx, stateDir });
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
    async info() {
      await init();
      return {
        stateDir,
        workRoot,
        accounts: accounts.list(),
        defaultAccount: accounts.defaultId(),
      };
    },

    async listAccounts() {
      await init();
      return { accounts: accounts.list(), defaultAccount: accounts.defaultId() };
    },

    /** 面板/API 用：账号密码直登，或粘贴 Cookie。密码只用于这一次登录，不保存。 */
    async addAccount({ label, cookie, login, password }) {
      await init();
      let token = typeof cookie === 'string' ? cookie.trim() : '';
      const accountName = String(login ?? '').trim();
      if (token === '') {
        if (accountName === '') throw new AccountError('invalid_input', '请填账号和密码，或粘贴 PTASession。');
        token = (await passwordLogin({ login: accountName, password })).cookie;
      }
      const account = await accounts.add({
        label: String(label ?? '').trim() || accountName || 'PTA 账号',
        cookie: token,
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
      const source = String(code ?? '');
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

    close() {},
  };

  return service;
}
