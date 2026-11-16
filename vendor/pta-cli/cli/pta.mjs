#!/usr/bin/env node
// PTA（pintia.cn）CLI for DSH — v0.2。
// 用法：node pta.mjs <command> [options]
// 密码只在登录那一刻用（交互输入或 --password-stdin），不落盘、不进仓库。
// 验证码分支：登录返回 GATEWAY_WRONG_CAPTCHA 时自动走协议求解器（约 63 秒）；
// 求解失败则用 --ticket / --rand-str 带票重试，票从 DSH 浏览器里人手过一次防水墙拿。

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PTAClient, PTAError } from './lib/pta-client.mjs';
import { authedClient, loginAccount } from './lib/actions.mjs';
import * as store from './lib/store.mjs';

const HELP = `pta — 拼题A（pintia.cn）CLI for DSH
  login --user <email|phone> [--label <name>] [--ticket T --rand-str R] [--remember]
  logout [--account <id|label>]
  accounts
  account-remove <id|label> --yes   # 删账号只走 CLI（面板上没有这个按钮）
  problem-sets [--account <id|label>] [--limit N]
  exams --psid <id> [--account <id|label>]
  problems --psid <id> [--type PROGRAMMING] [--account <id|label>]
  status --psid <id> --exam-id E [--account <id|label>]
  submit --exam-id E --type <TYPE> --answers <answers.json> [--account <id|label>] [--yes]
         客观题三格式：--psid <id> --type <TYPE> --answers <answers.json>（["A","BC"] / {"1":"A"} / [{index,answer}]，须覆盖该题型全部题目）
         编程题单题：--program-path <work 内文件> --problem <pspId> [--compiler GCC]
         旧路：--type <TYPE> --answers <details.json>（已拼好的 details 数组）
  account-remove <id|label> --yes     删账号（CLI 与面板都有；面板是双重确认）
  run --account <id|label> [--problem-set <id> | --all] [--mode all|todo|wrong|one] [--only-problem <id>] [--pace slow|normal|fast] [--max-fixes N] [--yes] [--finish]
  serve [--port <n>]                  # 实时看板 http://127.0.0.1:<n>/（SSE 推送，失败退回 5 秒轮询）
  dashboard [--account <id|label>]    # 生成静态看板 dashboard.html
  doctor
状态文件：$PTA_STATE_DIR 或 ~/.pta（accounts.json + accounts/<id>/{session.json,progress/,work/}）
答案生成：DeepSeek（DEEPSEEK_API_KEY 必须配，绝不写进文件；可用 DEEPSEEK_MODEL 覆盖模型；DEEPSEEK_MAX_TOKENS 限总 token，默认 200000）。
节律：读题按中文 300 字/分 × 难度系数；代码分段打字；题间指数分布间隔；两次提交 ≥15 秒。
`;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else out._.push(a);
  }
  return out;
}

// 读 stdin 第一行当密码（不用 readline：readline 在 execFile 的
// input 管道下收不到数据会一直挂起；裸 stdin 的 data 事件最稳）。
// 有换行就按行取，无换行则 EOF 时取整段；密码用完即丢。
function readPasswordStdin() {
  return new Promise((resolve) => {
    let buf = '';
    const done = (v) => {
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      resolve(v);
    };
    process.stdin.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) done(buf.slice(0, i).trim());
    });
    process.stdin.on('end', () => done(buf.trim()));
  });
}

const STATUS_LABEL = {
  PROBLEM_NO_ANSWER: '未答',
  PROBLEM_SUBMITTED: '已提交',
  PROBLEM_ACCEPTED: '通过',
  PROBLEM_WRONG_ANSWER: '答错',
  PARTIAL_ACCEPTED: '部分通过',
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = args(rest);
  try {
    switch (cmd) {
      case 'login': {
        const user = o.user;
        if (!user) throw new Error('login needs --user <email|phone>');
        const password = o.passwordStdin ? await readPasswordStdin() : (process.env.PTA_PASSWORD || '');
        if (!password) throw new Error('no password: pipe it via --password-stdin or set PTA_PASSWORD (never commit it)');
        const account = await loginAccount({
          user, password, label: o.label,
          ticket: o.ticket || '', randStr: o.randStr || '',
          remember: !!o.remember, noCaptcha: !!o.noCaptcha,
          log: (m) => console.log(m),
        });
        console.log(JSON.stringify({ ok: true, id: account.id, label: account.label, login: account.loginMasked, status: 'ready' }));
        break;
      }
      case 'accounts': {
        for (const a of store.loadAccounts()) {
          console.log(`${a.id}  ${a.label}  ${a.loginMasked}  ${a.status}  ${a.updatedAt}`);
        }
        break;
      }
      case 'problem-sets': {
        const account = store.resolveAccount(o.account);
        const client = await authedClient(account);
        const data = await client.problemSets({ limit: Number(o.limit || 20) });
        const sets = data.problemSets || data || [];
        for (const s of sets) console.log(`${s.id}  ${s.name || s.title || ''}  end=${s.endAt || ''}`);
        break;
      }
      case 'exams': {
        const account = store.resolveAccount(o.account);
        const client = await authedClient(account);
        if (!o.psid) throw new Error('exams needs --psid <id>');
        console.log(JSON.stringify(await client.exams(o.psid), null, 2).slice(0, 4000));
        break;
      }
      case 'problems': {
        const account = store.resolveAccount(o.account);
        const client = await authedClient(account);
        if (!o.psid) throw new Error('problems needs --psid <id>');
        // 取题不需要 exam_id，只依赖 problem_set_id。
        const data = await client.examProblems(o.psid, { problemType: o.type || '' });
        const list = data.examProblems || data.problems || [];
        for (const p of list) console.log(`${p.id}  [${p.type || ''}] ${p.score || ''}分  ${(p.content || '').split('\n')[0].slice(0, 60)}`);
        break;
      }
      case 'status': {
        const account = store.resolveAccount(o.account);
        const client = await authedClient(account);
        if (!o.psid || !o.examId) throw new Error('status needs --psid <id> --exam-id <E>');
        const data = await client.problemStatus(o.examId, o.psid);
        store.writeProgress(account.id, o.psid, { fetchedAt: new Date().toISOString(), examId: o.examId, data });
        const items = data.problemStatus || data.status || data || [];
        const counts = {};
        for (const it of items) counts[it.status || it.problemStatus || 'UNKNOWN'] = (counts[it.status || it.problemStatus || 'UNKNOWN'] || 0) + 1;
        const total = items.length;
        const done = counts.PROBLEM_ACCEPTED || 0;
        console.log(`psid=${o.psid} total=${total} accepted=${done} ${JSON.stringify(counts)}`);
        for (const it of items) console.log(`  ${it.problemSetProblemId || it.id}  ${STATUS_LABEL[it.status || it.problemStatus] || it.status}`);
        break;
      }
      case 'submit': {
        const account = store.resolveAccount(o.account);
        const client = await authedClient(account);
        const { isFormalExam, normalizeProblem, buildDetailsFromAnswers, fetchAllProblems } = await import('./lib/run.mjs');
        if (!o.examId) throw new Error('submit needs --exam-id E');
        let details;
        let type = o.type || '';
        if (o.programPath) {
          // 编程题单题提交：代码只从账号 work 目录内读（resolveWithin 越界拒绝），
          // 不接受 work 目录外的路径，防止误交别人电脑上的文件。
          if (!o.problem) throw new Error('submit --program-path needs --problem <pspId>');
          const workDir = join(store.accountDir(account.id), 'work');
          const file = store.resolveWithin(workDir, o.programPath);
          const program = readFileSync(file, 'utf8');
          type = 'PROGRAMMING';
          details = [{ problemId: '0', problemSetProblemId: o.problem, programmingSubmissionDetail: { program, compiler: o.compiler || 'GCC' } }];
        } else if (o.psid && o.answers) {
          // 客观题三格式答案（educoder parseChoicesInput 思想）：
          // ["A","BC"] / {"1":"A"} / [{index,answer}]，按题号映射到该题型题目，
          // 必须覆盖全部题目（整卷 upsert，分批提交会互相覆盖），严格校验。
          if (!type) throw new Error('submit --psid needs --type <TYPE>');
          const problemsRaw = await fetchAllProblems(client, o.psid, { accountId: account.id });
          const problems = problemsRaw.map((p) => normalizeProblem(p));
          const answers = JSON.parse(readFileSync(o.answers, 'utf8'));
          details = buildDetailsFromAnswers(problems, type, answers);
        } else if (o.type && o.answers) {
          // 旧路：直接给原始 details 数组（已拼好的提交体），保持兼容。
          const payload = JSON.parse(readFileSync(o.answers, 'utf8'));
          details = payload.details || payload;
        } else {
          throw new Error('submit needs one of: --psid <id> --type <TYPE> --answers <answers.json> | --program-path <file> --problem <pspId> | --type <TYPE> --answers <details.json>');
        }
        console.log(`preview: ${details.length} detail(s), type=${type}, exam=${o.examId}`);
        console.log(JSON.stringify(details, null, 2).slice(0, 2000));
        if (!o.yes) {
          console.log('dry-run only: re-run with --yes to actually submit');
          store.appendAudit(account.id, { action: 'submit_preview', examId: o.examId, type, count: details.length });
          break;
        }
        // 正式考试 guard：按 examId 反查题集，正式考试直接拒绝。
        const setsData = await client.problemSets({ limit: 50 });
        const examIdBySet = setsData.examIdByProblemSetId || {};
        const psid = Object.keys(examIdBySet).find((k) => examIdBySet[k] === o.examId);
        const setMeta = (setsData.problemSets || []).find((s) => s.id === psid);
        if (setMeta && isFormalExam(setMeta)) {
          console.log(`REFUSED: exam ${o.examId} belongs to formal exam set ${psid}, not submitting`);
          store.appendAudit(account.id, { action: 'exam_refused', psid, examId: o.examId, reason: 'formal exam' });
          process.exitCode = 3;
          break;
        }
        const res = await client.submit(o.examId, type, details);
        console.log(JSON.stringify(res).slice(0, 2000));
        store.appendAudit(account.id, { action: 'submitted', examId: o.examId, type, count: details.length });
        const submissionId = res?.submissionId || res?.id || null;
        if (submissionId) {
          const { judged, detail } = await client.pollSubmission(o.examId, submissionId, { tries: 60, intervalMs: 1000 });
          const { verdictFromDetail } = await import('./lib/run.mjs');
          const verdict = verdictFromDetail(detail);
          console.log(`judged: ${verdict.verdict} (submission ${submissionId}, polled=${judged})`);
          store.appendAudit(account.id, { action: 'judged', examId: o.examId, submissionId, judged, verdict: verdict.verdict });
        } else {
          console.log('no submission id returned, cannot poll judge result');
        }
        break;
      }
      case 'run': {
        const account = store.resolveAccount(o.account);
        const client = await authedClient(account);
        const { runAll } = await import('./lib/run.mjs');
        const settings = store.readSettings();
        const summary = await runAll({
          account, client,
          problemSet: o.problemSet || '',
          all: !!o.all,
          mode: o.mode || 'all',
          onlyProblem: o.onlyProblem || '',
          maxFixes: Number(o.maxFixes ?? settings.maxFixes ?? 3),
          model: settings.model || '',
          pace: o.pace || settings.pace || 'normal',
          yes: !!o.yes,
          finish: !!o.finish,
          log: (m) => console.log(m),
        });
        console.log(JSON.stringify(summary, null, 2));
        if (summary.problems.failed > 0) process.exitCode = 2;
        break;
      }
      case 'logout': {
        const { logoutAccount } = await import('./lib/actions.mjs');
        const account = store.resolveAccount(o.account);
        logoutAccount(account);
        console.log(JSON.stringify({ ok: true, id: account.id, label: account.label, status: 'auth_required' }));
        break;
      }
      case 'account-remove': {
        // 删账号（CLI 与面板都有；面板是双重确认）：状态置 removed、清会话、
        // 删凭据引用；账号目录（审计日志）保留备查。必须加 --yes。
        if (!o.yes) throw new Error('account-remove needs --yes (irreversible, use with care)');
        const ref = o._[0] || o.account;
        if (!ref) throw new Error('account-remove needs <id|label>');
        const account = store.resolveAccount(ref);
        store.removeAccount(account.id);
        store.appendAudit(account.id, { action: 'account_deleted', result: 'ok' });
        console.log(JSON.stringify({ ok: true, id: account.id, label: account.label, status: 'removed' }));
        break;
      }
      case 'serve': {
        const { serveDashboard } = await import('./lib/serve.mjs');
        const port = Number(o.port || 18766);
        await serveDashboard({ port, log: (m) => console.log(m) });
        // 保持进程活着，直到 Ctrl+C。
        await new Promise(() => {});
        break;
      }
      case 'dashboard': {
        const { buildSnapshot, renderDashboardHTML } = await import('./lib/dashboard.mjs');
        const snapshot = buildSnapshot();
        const html = renderDashboardHTML(snapshot, { live: false });
        const account = store.resolveAccount(o.account);
        const out = join(store.accountDir(account.id), 'dashboard.html');
        writeFileSync(out, html);
        console.log(`dashboard written: ${out}`);
        break;
      }
      case 'doctor': {
        console.log(JSON.stringify({ node: process.version, stateDir: store.stateRoot(), accounts: store.loadAccounts().length }, null, 2));
        break;
      }
      default:
        process.stdout.write(HELP);
    }
  } catch (e) {
    if (e instanceof PTAError) {
      console.error(`ERR ${e.code}: ${e.message}`);
      process.exitCode = 2;
    } else {
      console.error(`ERR: ${e.message}`);
      process.exitCode = 2;
    }
  }
}

main();
