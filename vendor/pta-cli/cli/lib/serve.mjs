// 面板驱动的看板服务：本地 HTTP 服务，只监听 127.0.0.1，不对外暴露。
// 动作全部走 lib/action-registry.mjs（名字、图标、接口、二次确认、运行中能否点），
// 面板按注册表分组渲染按钮；以后加功能只加注册项、不改框架。
// 服务端在后台跑同一套 run 管线（与 CLI 共用 lib/run.mjs、lib/actions.mjs，
// 不写两份）。密码只进内存，调完即丢，不写文件、不记日志。
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { buildSnapshot, renderDashboardHTML, renderReportMarkdown } from './dashboard.mjs';
import { authedClient, loginAccount, logoutAccount } from './actions.mjs';
import { runAll, fetchAllProblems } from './run.mjs';
import { ACTIONS, GROUPS } from './action-registry.mjs';
import { openJobQueue, startMaintenanceLoop, Semaphore, UnrecoverableError } from './job-queue.mjs';
import * as store from './store.mjs';

// 单-flight 任务：同一时间只跑一个全链路任务，避免两个任务抢同一个账号。
// 信号量是并发档位的底层件（vardiya 的 FIFO Semaphore）；currentJob 是实时记录。
let currentJob = null;
const runSemaphore = new Semaphore(1);
// 任务队列（vardiya 机制移植到 node:sqlite）：幂等键落库 + 唯一约束、
// 原子认领、崩溃恢复。state.json 仍是面板的读模型（快照/任务记录），
// 队列是持久账本（去重/恢复）；两者分工见 PLAN.md §11。
let jobQueue = null;
let stopMaintenance = null;

function openQueue() {
  if (jobQueue) return jobQueue;
  jobQueue = openJobQueue(join(store.stateRoot(), 'jobs.sqlite'));
  // 启动扫尾：上次 serve 崩溃/被杀时留下的 active 任务回 pending（attempt 保留），
  // 从未开始的 pending 任务（serve 停机前入队、未认领）记 dead；
  // state.json 里卡在 running/paused 的任务记录也置 failed，别让面板一直显示“跑着”。
  try {
    const reclaimed = jobQueue.reclaimStale(Date.now(), 30000);
    const swept = jobQueue.failStalePending('run', 0, 'interrupted: serve restarted before the job started');
    if (reclaimed + swept > 0) console.log(`job queue recovery: reclaimed ${reclaimed} stale, swept ${swept} never-started`);
  } catch (e) {
    console.log(`job queue recovery failed: ${e.message}`);
  }
  const state = store.readState();
  let touched = false;
  for (const j of (state.jobs || [])) {
    if (j.status === 'running' || j.status === 'paused') {
      j.status = 'failed';
      j.error = 'interrupted: serve restarted';
      j.finishedAt = new Date().toISOString();
      touched = true;
    }
  }
  if (touched) store.writeState(state);
  stopMaintenance = startMaintenanceLoop(jobQueue, { onError: (e) => console.log(`maintenance loop error: ${e.message}`) });
  return jobQueue;
}

// 写接口的 Origin 校验（防本地其他网页 CSRF 点按钮）：
// 没带 Origin 的放行（curl / 面板外调用）；带了的只认本机来源。
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function jobRunning() {
  return currentJob && (currentJob.status === 'running' || currentJob.status === 'paused');
}

// 运行中不允许的接口（注册表里 allowedWhileRunning=false 的动作对应的端点）。
const BLOCKED_WHILE_RUNNING = new Set([
  '/api/account/select', '/api/logout', '/api/cache/clear',
]);

async function handleRun(body) {
  const queue = openQueue();
  const key = body.idempotencyKey || '';
  // 幂等键落库去重（面板 JS 用 crypto.randomUUID 生成，随请求带上）：
  // 同一个 key 重复提交直接返回已有任务，不重复建任务（防双击 / 重连重投递）；
  // 同一个 key 换了 payload 要拒绝。唯一索引在库里兜底，进程重启后去重仍有效。
  if (key) {
    const existing = queue.getJobByDedup('run', key);
    if (existing) {
      const p = existing.payload || {};
      if (p.account !== (body.account || '') || p.problemSet !== (body.problemSet || '') || p.mode !== (body.mode || 'all')) {
        return { code: 409, body: { ok: false, error: 'idempotency key reused with different payload' } };
      }
      const live = existing.id === currentJob?.queueJobId ? currentJob : null;
      const panelJob = store.getJobByQueueId(existing.id);
      return { code: 202, body: { ok: true, jobId: panelJob?.id || existing.id, status: live?.status || panelJob?.status || existing.status, dedup: true } };
    }
  }
  // 单-flight：信号量守卫。注意顺序：幂等去重在前（重复提交返回已有任务，不占信号量）。
  if (!runSemaphore.tryAcquire()) {
    return { code: 409, body: { ok: false, error: 'a run is already in progress', jobId: currentJob.id } };
  }
  const settings = store.readSettings();
  const account = store.resolveAccount(body.account || store.getActiveAccountId() || '');
  const payload = { account: body.account || '', problemSet: body.problemSet || '', mode: body.mode || 'all' };
  let enq;
  try {
    enq = queue.enqueue({ queue: 'run', name: 'run-all', payload, jobId: key || undefined, maxAttempts: 1 });
  } catch (e) {
    runSemaphore.release();
    return { code: 500, body: { ok: false, error: `enqueue failed: ${e.message}` } };
  }
  const qJob = enq.job;
  if (enq.dedup) {
    runSemaphore.release();
    return { code: 202, body: { ok: true, jobId: qJob.id, status: qJob.status, dedup: true } };
  }
  const claimed = queue.claim(qJob.id);
  if (!claimed) {
    runSemaphore.release();
    return { code: 500, body: { ok: false, error: 'failed to claim the enqueued job' } };
  }
  const job = {
    id: randomUUID().slice(0, 8),
    queueJobId: qJob.id,
    status: 'running',
    accountId: account.id,
    accountLabel: account.label,
    problemSet: body.problemSet || '(auto)',
    mode: body.mode || 'all',
    paceRef: { name: body.pace || settings.pace || 'normal' },
    startedAt: new Date().toISOString(),
    finishedAt: '',
    summary: null,
    error: '',
    log: [],
    stopRequested: false,
    paused: false,
  };
  currentJob = job;
  store.recordJob(job);
  const logLine = (m) => {
    job.log.push(`[${new Date().toLocaleTimeString('zh-CN')}] ${m}`);
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
  };
  // 后台跑，不阻塞响应。点“完成作业”类按钮本身就是一次确认（面板 JS 里
  // 先弹二次确认框），yes 默认 true，与 CLI 的 --yes 等价。
  (async () => {
    // 心跳：每 30 秒续一次，维护循环靠它判断任务是否失联（默认 30 秒无心跳回收）。
    const heartbeat = setInterval(() => { try { queue.heartbeat(qJob.id); } catch {} }, 30000);
    try {
      const client = await authedClient(account);
      const summary = await runAll({
        account, client,
        problemSet: body.problemSet || '',
        all: !!body.all,
        mode: body.mode || 'all',
        onlyProblem: body.onlyProblem || '',
        maxFixes: Number(body.maxFixes ?? settings.maxFixes ?? 3),
        model: body.model || settings.model || '',
        pace: job.paceRef.name,
        paceRef: job.paceRef,
        yes: body.yes !== false,
        finish: !!body.finish,
        shouldStop: () => job.stopRequested,
        shouldPause: () => job.paused,
        log: logLine,
      });
      job.summary = summary;
      job.status = job.stopRequested ? 'stopped' : 'done';
      queue.complete(qJob.id, { status: job.status, summary });
    } catch (e) {
      job.status = 'failed';
      job.error = e.message;
      logLine(`run failed: ${e.message}`);
      store.appendAudit(account.id, { action: 'run_failed', reason: e.message });
      // 面板任务不自动重试：失败即 dead（retryable=false，maxAttempts=1），
      // 重试由用户点“失败重试”动作建新任务（vardiya 的 UnrecoverableError 思想）。
      queue.fail({ id: qJob.id, error: e, retryable: false });
    } finally {
      clearInterval(heartbeat);
      job.finishedAt = new Date().toISOString();
      // state.json 里的任务记录跟着更新（面板 /api/jobs/:id 读它）。
      store.updateJob(job.id, { status: job.status, finishedAt: job.finishedAt, error: job.error, queueJobId: qJob.id });
      runSemaphore.release();
    }
  })();
  return { code: 202, body: { ok: true, jobId: job.id, status: 'running' } };
}

async function handleLogin(body) {
  // 密码只进内存：loginAccount 用完即丢；这里不记日志、不写文件。
  const { user, password, label, remember } = body || {};
  if (!user || !password) return { code: 400, body: { ok: false, error: 'need user and password' } };
  try {
    const account = await loginAccount({ user, password, label, remember: !!remember, log: () => {} });
    return { code: 200, body: { ok: true, id: account.id, label: account.label, login: account.loginMasked, status: 'ready' } };
  } catch (e) {
    return { code: 200, body: { ok: false, error: e.message } };
  }
}

async function handleProblemSets(query) {
  try {
    const account = store.resolveAccount(query.get('account') || store.getActiveAccountId() || '');
    const client = await authedClient(account);
    const data = await client.problemSets({ limit: 50 });
    const sets = (data.problemSets || data || []).map((s) => ({ id: s.id, name: s.name || s.title || s.id, type: s.type || '' }));
    return { code: 200, body: { ok: true, sets } };
  } catch (e) {
    return { code: 200, body: { ok: false, error: e.message } };
  }
}

async function handleProblems(query) {
  try {
    const account = store.resolveAccount(query.get('account') || store.getActiveAccountId() || '');
    const psid = query.get('psid') || '';
    if (!psid) return { code: 400, body: { ok: false, error: 'need psid' } };
    const client = await authedClient(account);
    const setsData = await client.problemSets({ limit: 50 });
    const examId = (setsData.examIdByProblemSetId || {})[psid] || '';
    const exams = examId ? [] : await client.exams(psid);
    const realExamId = examId || exams[0]?.id || exams[0]?.examId || '';
    // 取题不需要 exam_id，只依赖 problem_set_id；exam_id 只在提交和查判题时用。
    // 题目走 fetchAllProblems：全量 + summaries 数量校验 + 按题型补拉（带缓存）。
    const problemsRaw = await fetchAllProblems(client, psid, { accountId: account.id });
    const statusData = realExamId ? await client.problemStatus(realExamId, psid) : { problemStatus: [] };
    const statusById = new Map((statusData.problemStatus || statusData.status || []).map((s) => [s.problemSetProblemId || s.id, s.status || s.problemStatus]));
    const list = problemsRaw.map((p) => ({
      pspId: p.id, type: p.type, score: p.score ?? 0,
      status: statusById.get(p.id) || 'PROBLEM_NO_ANSWER',
      preview: String(p.content || '').replace(/<[^>]+>/g, ' ').slice(0, 80),
    }));
    return { code: 200, body: { ok: true, psid, examId: realExamId, problems: list } };
  } catch (e) {
    return { code: 200, body: { ok: false, error: e.message } };
  }
}

async function handleRefresh(body) {
  try {
    const account = store.resolveAccount(body.account || store.getActiveAccountId() || '');
    // 手动刷新时缓存失效（题目与题集列表都重新拉）。
    store.invalidateCache(account.id);
    const client = await authedClient(account);
    const setsData = await client.problemSets({ limit: 50 });
    const sets = setsData.problemSets || setsData || [];
    const psid = body.problemSet || '';
    const targets = psid ? sets.filter((s) => s.id === psid) : sets;
    let refreshed = 0;
    for (const s of targets) {
      const examId = (setsData.examIdByProblemSetId || {})[s.id] || '';
      if (!examId) continue;
      const statusData = await client.problemStatus(examId, s.id);
      const list = statusData.problemStatus || statusData.status || [];
      const accepted = list.filter((x) => (x.status || x.problemStatus) === 'PROBLEM_ACCEPTED').length;
      store.writeProgress(account.id, s.id, { fetchedAt: new Date().toISOString(), examId, data: statusData });
      store.updateRunState(account.id, s.id, { name: s.name || s.title || s.id, total: list.length, accepted }, Object.fromEntries(list.map((x) => [(x.problemSetProblemId || x.id), { status: x.status || x.problemStatus }])));
      refreshed++;
    }
    return { code: 200, body: { ok: true, refreshed } };
  } catch (e) {
    return { code: 200, body: { ok: false, error: e.message } };
  }
}

export function serveDashboard({ port = 18766, log = console.log }) {
  // 启动时开队列 + 维护循环 + 崩溃扫尾（openQueue 里做）。
  openQueue();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = url.pathname;

      // 写接口 Origin 校验（防本地其他网页 CSRF 点按钮）。
      if (req.method === 'POST' && !originAllowed(req)) {
        return sendJson(res, 403, { ok: false, error: 'origin not allowed' });
      }

      if (req.method === 'GET' && path === '/api/registry') {
        return sendJson(res, 200, { groups: GROUPS, actions: ACTIONS });
      }
      if (req.method === 'GET' && path === '/api/state') {
        const snap = buildSnapshot();
        snap.job = currentJob;
        snap.settings = store.readSettings();
        snap.activeAccountId = store.getActiveAccountId();
        return sendJson(res, 200, snap);
      }
      // SSE 推送：重连先发全量 snapshot，之后每 5 秒发一次。
      // 前端优先用 EventSource，失败再退回 5 秒轮询 /api/state。
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        let n = 0;
        const sendSnapshot = () => {
          // try/catch：快照失败不能把 serve 进程拖垮（定时器回调里抛错会成未捕获异常）。
          try {
            const snap = buildSnapshot();
            snap.job = currentJob;
            snap.settings = store.readSettings();
            snap.activeAccountId = store.getActiveAccountId();
            res.write(`id: ${++n}\nevent: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
          } catch (e) {
            try { res.write(`event: error\ndata: ${JSON.stringify({ error: String(e.message || e) })}\n\n`); } catch { /* socket closed */ }
          }
        };
        sendSnapshot();
        const timer = setInterval(sendSnapshot, 5000);
        req.on('close', () => clearInterval(timer));
        return;
      }
      // 单个任务：面板按钮轮询 / 重连后恢复用，读 state.json 里的任务记录。
      if (req.method === 'GET' && path.startsWith('/api/jobs/')) {
        const id = path.slice('/api/jobs/'.length).split('/')[0];
        if (id === currentJob?.id) return sendJson(res, 200, { ok: true, job: currentJob });
        const rec = store.getJob(id);
        if (!rec) return sendJson(res, 404, { ok: false, error: `job not found: ${id}` });
        return sendJson(res, 200, { ok: true, job: rec });
      }
      // 取消任务：运行中置停止标志（下一题检查点停），已结束的任务无操作。
      // 控制意图写进任务记录（dsh-idle-scheduler 的控制/任务分离思想），
      // 不只留在内存，serve 重启后也能看到最后一次控制动作。
      if (req.method === 'POST' && /^\/api\/jobs\/[^/]+\/cancel$/.test(path)) {
        const id = path.split('/')[3];
        if (currentJob && currentJob.id === id && jobRunning()) {
          currentJob.stopRequested = true;
          store.updateJob(id, { stopRequested: true });
          return sendJson(res, 200, { ok: true, jobId: id, status: 'stopping' });
        }
        return sendJson(res, 200, { ok: false, error: 'no such running job' });
      }
      // 重试任务：只对已结束（done/failed/stopped）的任务新建一个 job，
      // 只跑未通过题（mode=wrong），不是复用旧 job。
      if (req.method === 'POST' && /^\/api\/jobs\/[^/]+\/retry$/.test(path)) {
        const id = path.split('/')[3];
        const rec = id === currentJob?.id ? currentJob : store.getJob(id);
        if (!rec) return sendJson(res, 404, { ok: false, error: `job not found: ${id}` });
        if (rec.status === 'running' || rec.status === 'paused') {
          return sendJson(res, 409, { ok: false, error: 'job is still running' });
        }
        const r = await handleRun({ account: rec.accountId || rec.accountLabel, problemSet: rec.problemSet, mode: 'wrong', yes: true });
        return sendJson(res, r.code, r.body);
      }
      // ---- 待复核队列（dsh-task-panel 验收/返工闭环的参考思路重写，见 PLAN §11）----
      // 低置信 / 停表 / 自测失败的题进这里等人处理；返工最多 5 次（MAX_REWORK）。
      if (req.method === 'GET' && path === '/api/review') {
        const account = store.resolveAccount(url.searchParams.get('account') || store.getActiveAccountId() || '');
        const items = store.getReviewItems(account.id, { status: url.searchParams.get('status') || '' });
        return sendJson(res, 200, { ok: true, account: account.id, items });
      }
      if (req.method === 'POST' && path === '/api/review/accept') {
        const body = await readJsonBody(req);
        const account = store.resolveAccount(body.account || store.getActiveAccountId() || '');
        const item = store.getReviewItems(account.id).find((r) => r.key === body.key);
        if (!item) return sendJson(res, 404, { ok: false, error: `review item not found: ${body.key}` });
        store.updateReviewItem(body.key, { status: 'accepted' });
        store.appendAudit(account.id, { action: 'review_accepted', psid: item.psid, problemId: item.pspId, reason: item.reason });
        return sendJson(res, 200, { ok: true, key: body.key, status: 'accepted' });
      }
      if (req.method === 'POST' && path === '/api/review/rework') {
        const body = await readJsonBody(req);
        const account = store.resolveAccount(body.account || store.getActiveAccountId() || '');
        const item = store.getReviewItems(account.id).find((r) => r.key === body.key);
        if (!item) return sendJson(res, 404, { ok: false, error: `review item not found: ${body.key}` });
        if (item.status === 'exhausted' || (item.reworkCount || 0) >= store.MAX_REWORK) {
          store.updateReviewItem(body.key, { status: 'exhausted' });
          return sendJson(res, 409, { ok: false, error: 'rework limit reached (5), item exhausted' });
        }
        const r = await handleRun({ account: account.id, problemSet: item.psid, mode: 'one', onlyProblem: item.pspId, yes: true, pace: body.pace || '' });
        if (r.code === 202) {
          store.updateReviewItem(body.key, { status: 'rework', reworkCount: (item.reworkCount || 0) + 1 });
          store.appendAudit(account.id, { action: 'review_rework', psid: item.psid, problemId: item.pspId, reason: item.reason, reworkCount: (item.reworkCount || 0) + 1 });
        }
        return sendJson(res, r.code, r.body);
      }
      if (req.method === 'GET' && path === '/api/problem-sets') {
        const r = await handleProblemSets(url.searchParams);
        return sendJson(res, r.code, r.body);
      }
      if (req.method === 'GET' && path === '/api/problems') {
        const r = await handleProblems(url.searchParams);
        return sendJson(res, r.code, r.body);
      }
      if (req.method === 'GET' && path === '/api/audit') {
        const account = store.resolveAccount(url.searchParams.get('account') || store.getActiveAccountId() || '');
        return sendJson(res, 200, { ok: true, audit: store.readAudit(account.id, Number(url.searchParams.get('limit') || 100)) });
      }
      if (req.method === 'GET' && path === '/api/audit/download') {
        const account = store.resolveAccount(url.searchParams.get('account') || store.getActiveAccountId() || '');
        const lines = store.readAudit(account.id, 10000);
        res.writeHead(200, { 'Content-Type': 'application/jsonl', 'Content-Disposition': `attachment; filename="pta-audit-${account.label}.jsonl"` });
        res.end(lines.map((l) => JSON.stringify(l)).join('\n'));
        return;
      }
      if (req.method === 'GET' && path === '/api/report') {
        const account = store.resolveAccount(url.searchParams.get('account') || store.getActiveAccountId() || '');
        const md = renderReportMarkdown(buildSnapshot(), account);
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="pta-report-${account.label}.md"` });
        res.end(md);
        return;
      }
      if (req.method === 'GET' && path === '/api/settings') {
        return sendJson(res, 200, { ok: true, settings: store.readSettings() });
      }
      if (req.method === 'POST' && path === '/api/settings') {
        const body = await readJsonBody(req);
        const patch = {};
        if (body.pace && ['slow', 'normal', 'fast'].includes(body.pace)) patch.pace = body.pace;
        if (body.maxFixes !== undefined) patch.maxFixes = Math.max(0, Math.min(5, Number(body.maxFixes) || 3));
        if (typeof body.model === 'string') patch.model = body.model.trim();
        const settings = store.writeSettings(patch);
        if (jobRunning() && patch.pace) currentJob.paceRef.name = patch.pace;
        return sendJson(res, 200, { ok: true, settings });
      }
      if (req.method === 'POST' && path === '/api/pace') {
        const body = await readJsonBody(req);
        if (!['slow', 'normal', 'fast'].includes(body.pace)) return sendJson(res, 400, { ok: false, error: 'pace must be slow|normal|fast' });
        const settings = store.writeSettings({ pace: body.pace });
        if (jobRunning()) currentJob.paceRef.name = body.pace; // 运行中的任务下一次等待即用新档位
        return sendJson(res, 200, { ok: true, pace: body.pace, settings });
      }
      if (req.method === 'POST' && path === '/api/run') {
        const body = await readJsonBody(req);
        const r = await handleRun(body);
        return sendJson(res, r.code, r.body);
      }
      if (req.method === 'POST' && path === '/api/pause') {
        if (jobRunning() && currentJob.status === 'running') {
          currentJob.paused = true;
          currentJob.status = 'paused';
          store.updateJob(currentJob.id, { status: 'paused', paused: true });
          return sendJson(res, 200, { ok: true, jobId: currentJob.id, status: 'paused' });
        }
        return sendJson(res, 200, { ok: false, error: 'no running job to pause' });
      }
      if (req.method === 'POST' && path === '/api/resume') {
        if (currentJob && currentJob.status === 'paused') {
          currentJob.paused = false;
          currentJob.status = 'running';
          store.updateJob(currentJob.id, { status: 'running', paused: false });
          return sendJson(res, 200, { ok: true, jobId: currentJob.id, status: 'running' });
        }
        return sendJson(res, 200, { ok: false, error: 'no paused job to resume' });
      }
      if (req.method === 'POST' && path === '/api/stop') {
        if (jobRunning()) {
          currentJob.stopRequested = true;
          store.updateJob(currentJob.id, { stopRequested: true });
          return sendJson(res, 200, { ok: true, jobId: currentJob.id, status: 'stopping' });
        }
        return sendJson(res, 200, { ok: false, error: 'no running job' });
      }
      if (req.method === 'POST' && path === '/api/login') {
        const body = await readJsonBody(req);
        const r = await handleLogin(body);
        return sendJson(res, r.code, r.body);
      }
      if (req.method === 'POST' && path === '/api/logout') {
        if (jobRunning()) return sendJson(res, 409, { ok: false, error: 'a run is in progress' });
        const body = await readJsonBody(req);
        const account = store.resolveAccount(body.account || store.getActiveAccountId() || '');
        logoutAccount(account);
        return sendJson(res, 200, { ok: true, id: account.id, label: account.label });
      }
      if (req.method === 'POST' && path === '/api/account/select') {
        if (jobRunning()) return sendJson(res, 409, { ok: false, error: 'a run is in progress' });
        const body = await readJsonBody(req);
        const account = store.resolveAccount(body.account || '');
        store.setActiveAccountId(account.id);
        return sendJson(res, 200, { ok: true, id: account.id, label: account.label });
      }
      if (req.method === 'POST' && path === '/api/account/toggle-enabled') {
        const body = await readJsonBody(req);
        const account = store.resolveAccount(body.account || store.getActiveAccountId() || '');
        const enabled = typeof body.enabled === 'boolean' ? body.enabled : !store.isAccountEnabled(account);
        store.setAccountEnabled(account.id, enabled);
        store.appendAudit(account.id, { action: enabled ? 'account_enabled' : 'account_disabled', result: 'ok' });
        return sendJson(res, 200, { ok: true, id: account.id, label: account.label, enabled });
      }
      // 删账号（危险动作）：面板二次确认 + 服务端显式 confirm:true 双保险；
      // 运行中 409。只清账号表状态、会话与凭据引用，账号目录（审计日志）保留备查。
      if (req.method === 'POST' && path === '/api/account/delete') {
        if (jobRunning()) return sendJson(res, 409, { ok: false, error: 'a run is in progress' });
        const body = await readJsonBody(req);
        if (body.confirm !== true) return sendJson(res, 400, { ok: false, error: 'delete account needs {confirm: true}' });
        const account = store.resolveAccount(body.account || store.getActiveAccountId() || '');
        const removed = store.removeAccount(account.id);
        if (!removed) return sendJson(res, 404, { ok: false, error: `account not found: ${account.id}` });
        if (store.getActiveAccountId() === account.id) store.setActiveAccountId('');
        store.appendAudit(account.id, { action: 'account_deleted', result: 'ok' });
        return sendJson(res, 200, { ok: true, id: account.id, label: account.label });
      }
      // 单题跳过 / 取消跳过：写进 state.json 的跳过清单，run 每题开始前检查。
      if (req.method === 'POST' && path === '/api/problem/skip') {
        const body = await readJsonBody(req);
        const account = store.resolveAccount(body.account || store.getActiveAccountId() || '');
        const psid = body.problemSet || '';
        const pspId = body.problem || body.problemId || '';
        if (!psid || !pspId) return sendJson(res, 400, { ok: false, error: 'need problemSet and problem' });
        const skipped = store.skipProblem(account.id, psid, pspId, body.skip !== false);
        store.appendAudit(account.id, { action: body.skip === false ? 'problem_unskipped' : 'problem_skipped', psid, problemId: pspId, reason: 'panel' });
        return sendJson(res, 200, { ok: true, skipped });
      }
      // 单题详情：题面 + 状态 + 最近一次判题（不跳平台页面就能判断是题难还是程序 bug）。
      if (req.method === 'GET' && path === '/api/problem') {
        const account = store.resolveAccount(url.searchParams.get('account') || store.getActiveAccountId() || '');
        const psid = url.searchParams.get('psid') || url.searchParams.get('problemSet') || '';
        const pspId = url.searchParams.get('problem') || url.searchParams.get('problemId') || '';
        if (!psid || !pspId) return sendJson(res, 400, { ok: false, error: 'need psid and problem' });
        try {
          const client = await authedClient(account);
          const setsData = await client.problemSets({ limit: 50 });
          const examId = (setsData.examIdByProblemSetId || {})[psid] || '';
          const exams = examId ? [] : await client.exams(psid);
          const realExamId = examId || exams[0]?.id || exams[0]?.examId || '';
          const problemsRaw = await fetchAllProblems(client, psid, { accountId: account.id });
          const list = problemsRaw;
          const raw = list.find((p) => p.id === pspId);
          if (!raw) return sendJson(res, 404, { ok: false, error: `problem not found: ${pspId}` });
          let status = 'PROBLEM_NO_ANSWER';
          let last = null;
          if (realExamId) {
            const statusData = await client.problemStatus(realExamId, psid);
            const row = (statusData.problemStatus || statusData.status || []).find((s) => (s.problemSetProblemId || s.id) === pspId);
            status = row?.status || row?.problemStatus || status;
            try {
              const subs = await client.lastSubmissions(realExamId, psid);
              const arr = subs.submissions || subs.lastSubmissions || [];
              last = Array.isArray(arr) ? arr.find((s) => (s.problemSetProblemId || s.problemId) === pspId) || arr[0] || null : null;
            } catch { /* last submission optional */ }
          }
          return sendJson(res, 200, {
            ok: true,
            problem: {
              pspId: raw.id, type: raw.type, score: raw.score ?? 0,
              content: String(raw.content || '').replace(/<[^>]+>/g, ' ').slice(0, 2000),
              compiler: raw.compiler || '', status,
              skipped: store.isSkipped(account.id, psid, pspId),
              lastSubmission: last,
            },
          });
        } catch (e) {
          return sendJson(res, 200, { ok: false, error: e.message });
        }
      }
      if (req.method === 'POST' && path === '/api/account/ping') {
        const body = await readJsonBody(req);
        try {
          const account = store.resolveAccount(body.account || store.getActiveAccountId() || '');
          const client = await authedClient(account);
          const me = await client.current();
          return sendJson(res, 200, { ok: true, alive: true, user: me?.user || null });
        } catch (e) {
          return sendJson(res, 200, { ok: false, alive: false, error: e.message });
        }
      }
      if (req.method === 'POST' && path === '/api/refresh') {
        const body = await readJsonBody(req);
        const r = await handleRefresh(body);
        return sendJson(res, r.code, r.body);
      }
      if (req.method === 'POST' && path === '/api/cache/clear') {
        if (jobRunning()) return sendJson(res, 409, { ok: false, error: 'a run is in progress' });
        const body = await readJsonBody(req);
        if (body.confirm !== true) return sendJson(res, 400, { ok: false, error: 'clear cache needs {confirm: true}' });
        const account = store.resolveAccount(body.account || store.getActiveAccountId() || '');
        const removed = store.clearProgressCache(account.id);
        return sendJson(res, 200, { ok: true, removed });
      }
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        const html = renderDashboardHTML(buildSnapshot(), { live: true, job: currentJob, registry: { groups: GROUPS, actions: ACTIONS } });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log(`pta dashboard: http://127.0.0.1:${port}/  (JSON: /api/state, 5s refresh)`);
      // 优雅停机（vardiya release() 思想）：运行中的任务放回队列 pending
      // （attempt 扣回、不写 lastError、不烧重试次数），停维护循环、关库，
      // 再关 HTTP 服务。被 kill -9 时走不了这条路，靠下次启动的扫尾兜底。
      const shutdown = () => {
        try {
          if (currentJob && jobRunning() && currentJob.queueJobId) jobQueue?.release(currentJob.queueJobId);
        } catch {}
        try { stopMaintenance?.(); } catch {}
        try { jobQueue?.close(); } catch {}
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      resolve(server);
    });
  });
}
