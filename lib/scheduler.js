/**
 * PTA 任务调度器（纯用例层，不依赖 DSH，可单独拆出使用）。
 *
 * 职责：任务队列持久化 + 账号锁 + 全局并发上限 + 临期优先 + 失败重试（指数退避）+ 崩溃恢复 + 操作日志。
 *
 * 状态文件 <stateDir>/tasks.json，格式 { version: 2, tasks: [...], events: [...] }。
 *   · v1（旧版裸数组）读入时自动迁移；
 *   · 遇到更高的未知版本：只读不写，抛 state_version 错误，绝不静默覆盖。
 *
 * 任务状态机：
 *   pending ──claim──▶ running ──finish(done)──▶ done
 *      ▲                 │ finish(failed) 且 attempts < maxAttempts ──▶ pending（nextRunAt = 退避）
 *      │                 │ finish(failed) 且已用尽 ──▶ failed
 *      └── recover ──────┘ heartbeat 超时（崩溃/会话丢失）
 *   pending/running ──cancel──▶ cancelled；failed/cancelled ──retry──▶ pending
 *
 * 失败分类（finish 的 reason，见 FAILURE_POLICY）：
 *   · 永久类（auth_required / not_started / exam_guard / invalid_input）不重试，直接 failed；
 *   · auth_required 还会暂停该账号的队列，直到 resume(account)（面板重登 / 校验通过时调用）；
 *   · rate_limited 用长退避（×4，至少 5 分钟）；
 *   · 其余（compile_error / wrong_answer / no_finish / session_error / timeout / other）按普通指数退避。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const STATE_VERSION = 2;
export const TASK_STATUSES = Object.freeze(['pending', 'running', 'done', 'failed', 'cancelled']);
const ACTIVE = new Set(['pending', 'running']);
const FINISHED = new Set(['done', 'failed', 'cancelled']);
const MAX_EVENTS = 300;
const MAX_FINISHED = 200;
const DAY = 86_400_000;

/** 失败原因 → 调度策略。只加不改；未知原因按 other 处理。 */
export const FAILURE_POLICY = Object.freeze({
  auth_required: { retry: false, pause: true, text: '登录失效' },
  not_started: { retry: false, text: '题集未开放 / 无权限' },
  exam_guard: { retry: false, text: '考试类题集' },
  invalid_input: { retry: false, text: '参数错误' },
  rate_limited: { retry: true, factor: 4, minMs: 5 * 60_000, text: 'PTA 限流' },
  compile_error: { retry: true, text: '编译错误' },
  wrong_answer: { retry: true, text: '答案错误' },
  timeout: { retry: true, text: '心跳超时' },
  no_finish: { retry: true, text: '会话未收尾' },
  session_error: { retry: true, text: '会话异常' },
  launch_failed: { retry: true, text: '启动会话失败' },
  other: { retry: true, text: '其他' },
});

/** 从自由文本里猜原因（模型没给 reason 时兜底）。 */
export function classifyFailure(reason, message = '') {
  if (typeof reason === 'string' && Object.hasOwn(FAILURE_POLICY, reason)) return reason;
  const text = String(message ?? '').toLowerCase();
  if (/auth_required|登录已失效|登录失效|重新登录|401/u.test(text)) return 'auth_required';
  if (/rate_limited|限流|429|too many/u.test(text)) return 'rate_limited';
  if (/not_started|未开始|已结束|没有权限|无权限/u.test(text)) return 'not_started';
  if (/exam_guard|考试|监考/u.test(text)) return 'exam_guard';
  if (/compil|编译/u.test(text)) return 'compile_error';
  if (/wrong|答案错误|部分正确|partial/u.test(text)) return 'wrong_answer';
  return 'other';
}

export class SchedulerError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

const clampInt = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
};

const clean = (value, max = 200) => String(value ?? '').replace(/[\r\n\t]+/gu, ' ').slice(0, max);

/** 排序键：可执行时间到了的任务里，临期（≤ urgentDays）优先，其次 priority 大，其次截止早，其次先来。 */
export function compareTasks(a, b, now = Date.now(), urgentDays = 2) {
  const urgent = (task) => {
    const end = Date.parse(task.endAt ?? '');
    return Number.isFinite(end) && end - now <= urgentDays * DAY ? 1 : 0;
  };
  const diff = urgent(b) - urgent(a);
  if (diff !== 0) return diff;
  if ((b.priority ?? 0) !== (a.priority ?? 0)) return (b.priority ?? 0) - (a.priority ?? 0);
  const endA = Date.parse(a.endAt ?? '') || Number.MAX_SAFE_INTEGER;
  const endB = Date.parse(b.endAt ?? '') || Number.MAX_SAFE_INTEGER;
  if (endA !== endB) return endA - endB;
  return String(a.createdAt).localeCompare(String(b.createdAt));
}

/** 第 n 次失败后的退避（毫秒）：base * 2^(n-1)，上限 maxMs。 */
export function backoffMs(attempts, baseMs = 30_000, maxMs = 15 * 60_000, reason = 'other') {
  const policy = FAILURE_POLICY[reason] ?? FAILURE_POLICY.other;
  const raw = Math.min(baseMs * 2 ** Math.max(0, attempts - 1), maxMs) * (policy.factor ?? 1);
  return Math.max(raw, policy.minMs ?? 0);
}

export function createScheduler({
  stateDir,
  maxConcurrent = 2,
  maxAttempts = 3,
  perAccountConcurrent = 1,
  staleMs = 20 * 60_000,
  backoffBaseMs = 30_000,
  urgentDays = 2,
  now = () => Date.now(),
} = {}) {
  if (typeof stateDir !== 'string' || stateDir === '') throw new TypeError('scheduler 需要 stateDir');
  const file = join(stateDir, 'tasks.json');
  const limits = {
    maxConcurrent: clampInt(maxConcurrent, 1, 8, 2),
    maxAttempts: clampInt(maxAttempts, 1, 10, 3),
    perAccountConcurrent: clampInt(perAccountConcurrent, 1, 4, 1),
    staleMs: clampInt(staleMs, 10_000, 24 * 3_600_000, 20 * 60_000),
  };
  let state = null;
  let readOnly = false;
  let queue = Promise.resolve();
  const listeners = new Set();

  async function load() {
    if (state !== null) return state;
    await mkdir(stateDir, { recursive: true });
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      parsed = undefined;
    }
    if (Array.isArray(parsed)) {
      // v1 → v2 迁移：旧版只有 id/psid/account/status/createdAt/finishedAt
      state = {
        version: STATE_VERSION,
        tasks: parsed.filter((task) => task && typeof task === 'object').map((task) => {
          const row = normalize(task);
          // 旧版遗留的 pending/running 不自动开跑（避免升级后插件一加载就开会话），改为已取消，面板可一键重试
          if (row.status === 'pending' || row.status === 'running') {
            row.status = 'cancelled';
            row.error = '从旧版队列迁移，未自动执行；需要的话点「重试」';
            row.finishedAt = new Date(now()).toISOString();
          }
          return row;
        }),
        events: [],
        paused: {},
      };
      state.events.push(event('migrate', null, `从 v1 迁移 ${state.tasks.length} 个任务`));
    } else if (parsed && typeof parsed === 'object') {
      const version = Number(parsed.version ?? 0);
      if (version > STATE_VERSION) {
        readOnly = true;
        state = { version, tasks: (parsed.tasks ?? []).map((task) => normalize(task)), events: parsed.events ?? [], paused: parsed.paused ?? {} };
      } else {
        state = {
          version: STATE_VERSION,
          tasks: (Array.isArray(parsed.tasks) ? parsed.tasks : []).map((task) => normalize(task)),
          events: Array.isArray(parsed.events) ? parsed.events.slice(-MAX_EVENTS) : [],
          paused: normalizePaused(parsed.paused),
        };
      }
    } else {
      state = { version: STATE_VERSION, tasks: [], events: [], paused: {} };
    }
    return state;
  }

  function normalizePaused(value) {
    const out = {};
    if (!value || typeof value !== 'object') return out;
    for (const [account, row] of Object.entries(value)) {
      if (account && row && typeof row === 'object') out[account] = { reason: clean(row.reason, 40), at: String(row.at ?? ''), message: clean(row.message, 200) };
    }
    return out;
  }

  function normalize(task) {
    const status = TASK_STATUSES.includes(task.status) ? task.status : 'pending';
    return {
      id: String(task.id ?? `t${randomUUID()}`),
      psid: String(task.psid ?? ''),
      account: String(task.account ?? ''),
      setName: clean(task.setName, 120),
      endAt: task.endAt ? String(task.endAt) : '',
      priority: clampInt(task.priority, -10, 10, 0),
      status,
      attempts: clampInt(task.attempts, 0, 100, 0),
      maxAttempts: clampInt(task.maxAttempts, 1, 10, limits.maxAttempts),
      nextRunAt: task.nextRunAt ?? null,
      progress: task.progress && typeof task.progress === 'object'
        ? { done: clampInt(task.progress.done, 0, 100_000, 0), total: clampInt(task.progress.total, 0, 100_000, 0), note: clean(task.progress.note, 160) }
        : { done: 0, total: 0, note: '' },
      sessionId: task.sessionId ? String(task.sessionId) : '',
      launch: task.launch ? String(task.launch) : '',
      error: task.error ? clean(task.error, 300) : '',
      reason: task.reason && Object.hasOwn(FAILURE_POLICY, task.reason) ? task.reason : '',
      lastError: task.lastError ? clean(task.lastError, 300) : '',
      createdAt: task.createdAt ?? new Date(now()).toISOString(),
      startedAt: task.startedAt ?? null,
      heartbeatAt: task.heartbeatAt ?? null,
      finishedAt: task.finishedAt ?? null,
    };
  }

  function event(kind, task, message) {
    return {
      at: new Date(now()).toISOString(),
      kind,
      task: task?.id ?? null,
      account: task?.account ?? null,
      psid: task?.psid ?? null,
      message: clean(message, 240),
    };
  }

  async function persist() {
    if (readOnly) throw new SchedulerError('state_version', `tasks.json 版本 ${state.version} 高于本插件支持的 ${STATE_VERSION}，已拒绝写入。请升级插件。`);
    const finished = state.tasks.filter((task) => FINISHED.has(task.status));
    if (finished.length > MAX_FINISHED) {
      const drop = new Set(finished
        .sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)))
        .slice(0, finished.length - MAX_FINISHED)
        .map((task) => task.id));
      state.tasks = state.tasks.filter((task) => !drop.has(task.id));
    }
    state.events = state.events.slice(-MAX_EVENTS);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 1)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
  }

  /** 串行化所有读-改-写，避免并发请求互相覆盖。 */
  function mutate(fn) {
    const next = queue.then(async () => {
      const data = await load();
      const result = await fn(data);
      await persist();
      return result;
    });
    queue = next.catch(() => {});
    return next.then((result) => {
      for (const listener of listeners) {
        try { listener(); } catch { /* 监听器异常不影响调度 */ }
      }
      return result;
    });
  }

  function find(data, id) {
    const task = data.tasks.find((item) => item.id === String(id ?? ''));
    if (!task) throw new SchedulerError('not_found', `没有任务 ${id}。`);
    return task;
  }

  function log(data, kind, task, message) {
    data.events.push(event(kind, task, message));
  }

  const runningOf = (data) => data.tasks.filter((task) => task.status === 'running');

  function ready(data, task, at) {
    if (task.status !== 'pending') return false;
    if (task.nextRunAt && Date.parse(task.nextRunAt) > at) return false;
    if (data.paused?.[task.account]) return false;
    // 账号级并发配额（默认 1：同一账号同时只跑一个任务，防止风控与状态互踩）
    const running = data.tasks.filter((other) => other.status === 'running' && other.account === task.account).length;
    return running < limits.perAccountConcurrent;
  }

  function failTask(data, task, at, reason, message, kind = 'retry') {
    const policy = FAILURE_POLICY[reason] ?? FAILURE_POLICY.other;
    task.error = message;
    task.reason = reason;
    if (policy.pause && task.account) {
      data.paused ??= {};
      data.paused[task.account] = { reason, at: new Date(at).toISOString(), message };
      log(data, 'pause', task, `账号暂停：${policy.text}，重登后继续`);
    }
    if (policy.retry && task.attempts < task.maxAttempts) {
      const wait = backoffMs(task.attempts, backoffBaseMs, undefined, reason);
      task.status = 'pending';
      task.nextRunAt = new Date(at + wait).toISOString();
      log(data, kind, task, `${policy.text}，${Math.round(wait / 1000)}s 后重试：${message}`);
    } else {
      task.status = 'failed';
      task.finishedAt = new Date(at).toISOString();
      log(data, 'failed', task, policy.retry ? `已用尽 ${task.maxAttempts} 次：${message}` : `${policy.text}，不重试：${message}`);
    }
  }

  function summary(data) {
    const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
    for (const task of data.tasks) counts[task.status] += 1;
    return counts;
  }

  return {
    file,
    limits,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async list({ status, account } = {}) {
      const data = await load();
      const at = now();
      const tasks = data.tasks
        .filter((task) => (!status || task.status === status) && (!account || task.account === account))
        .slice()
        .sort((a, b) => {
          const order = TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status);
          if (order !== 0) return order;
          if (a.status === 'pending') return compareTasks(a, b, at, urgentDays);
          return String(b.startedAt ?? b.createdAt).localeCompare(String(a.startedAt ?? a.createdAt));
        });
      return { tasks, counts: summary(data), limits, readOnly, paused: { ...(data.paused ?? {}) } };
    },

    async events({ limit = 50 } = {}) {
      const data = await load();
      return data.events.slice(-clampInt(limit, 1, MAX_EVENTS, 50)).reverse();
    },

    async get(id) {
      return find(await load(), id);
    },

    /** 入队；同账号同题目集已有 pending/running 时返回已有任务（幂等）。 */
    enqueue({ psid, account, setName = '', endAt = '', priority = 0 } = {}) {
      if (!/^\d{1,20}$/u.test(String(psid ?? ''))) throw new SchedulerError('invalid_input', 'psid 应为数字题目集 ID。');
      if (typeof account !== 'string' || account === '') throw new SchedulerError('invalid_input', '缺少 account。');
      return mutate((data) => {
        const existing = data.tasks.find((task) => ACTIVE.has(task.status) && task.psid === String(psid) && task.account === account);
        if (existing) return { task: existing, created: false };
        const task = normalize({
          id: `t${Date.now().toString(36)}${randomUUID().slice(0, 6)}`,
          psid: String(psid), account, setName, endAt, priority,
          status: 'pending', maxAttempts: limits.maxAttempts,
        });
        data.tasks.push(task);
        log(data, 'enqueue', task, `入队：${task.setName || task.psid}`);
        return { task, created: true };
      });
    },

    /**
     * 领取下一个可执行任务（标记 running）。
     * 遵守：全局并发上限、账号锁、退避时间、临期优先。可限定 account / id。
     */
    claim({ account, id, launch = '' } = {}) {
      return mutate((data) => {
        const at = now();
        if (runningOf(data).length >= limits.maxConcurrent) return { task: null, reason: 'concurrency' };
        let candidates = data.tasks.filter((task) => ready(data, task, at));
        if (account) candidates = candidates.filter((task) => task.account === account);
        if (id) candidates = candidates.filter((task) => task.id === String(id));
        candidates.sort((a, b) => compareTasks(a, b, at, urgentDays));
        const task = candidates[0];
        if (!task) return { task: null, reason: 'empty' };
        task.status = 'running';
        task.attempts += 1;
        task.startedAt = new Date(at).toISOString();
        task.heartbeatAt = task.startedAt;
        task.nextRunAt = null;
        if (task.error) task.lastError = task.error;
        task.error = '';
        task.launch = clean(launch, 40);
        log(data, 'start', task, `开始第 ${task.attempts}/${task.maxAttempts} 次（${task.launch || 'agent'}）`);
        return { task };
      });
    },

    /** 进度回写（同时刷新心跳）。 */
    progress({ id, done, total, note, sessionId } = {}) {
      return mutate((data) => {
        const task = find(data, id);
        if (task.status !== 'running') throw new SchedulerError('invalid_state', `任务 ${task.id} 当前是 ${task.status}，不能回写进度。`);
        if (done !== undefined) task.progress.done = clampInt(done, 0, 100_000, task.progress.done);
        if (total !== undefined) task.progress.total = clampInt(total, 0, 100_000, task.progress.total);
        if (note !== undefined) task.progress.note = clean(note, 160);
        if (sessionId) task.sessionId = String(sessionId);
        task.heartbeatAt = new Date(now()).toISOString();
        if (note) log(data, 'progress', task, `${task.progress.done}/${task.progress.total} ${task.progress.note}`);
        return { task };
      });
    },

    /**
     * 收尾：done，或 failed。failed 按 reason 走 FAILURE_POLICY：可重试且次数未用尽 → 退避后回到 pending；
     * 否则 failed。reason=auth_required 时暂停该账号队列。
     */
    finish({ id, status = 'done', error = '', reason } = {}) {
      return mutate((data) => {
        const task = find(data, id);
        if (FINISHED.has(task.status)) return { task, unchanged: true };
        const at = now();
        task.heartbeatAt = new Date(at).toISOString();
        if (status === 'done') {
          task.status = 'done';
          task.finishedAt = task.heartbeatAt;
          task.error = '';
          task.reason = '';
          if (task.progress.total > 0) task.progress.done = Math.max(task.progress.done, task.progress.total);
          log(data, 'done', task, `完成：${task.setName || task.psid}`);
          return { task };
        }
        failTask(data, task, at, classifyFailure(reason, error), clean(error || '执行失败', 300));
        return { task };
      });
    },

    /** 解除账号暂停（重登 / 校验通过后调用）。 */
    resume({ account } = {}) {
      return mutate((data) => {
        if (!account || !data.paused?.[account]) return { resumed: false };
        delete data.paused[account];
        log(data, 'resume', { account }, '账号已恢复，队列继续');
        return { resumed: true };
      });
    },

    cancel({ id } = {}) {
      return mutate((data) => {
        const task = find(data, id);
        if (!ACTIVE.has(task.status)) return { task, unchanged: true };
        task.status = 'cancelled';
        task.finishedAt = new Date(now()).toISOString();
        log(data, 'cancel', task, '已取消');
        return { task };
      });
    },

    retry({ id } = {}) {
      return mutate((data) => {
        const task = find(data, id);
        if (ACTIVE.has(task.status) || task.status === 'done') return { task, unchanged: true };
        task.status = 'pending';
        task.attempts = 0;
        task.nextRunAt = null;
        task.finishedAt = null;
        if (task.error) task.lastError = task.error;
        task.error = '';
        task.reason = '';
        log(data, 'requeue', task, '手动重试');
        return { task };
      });
    },

    /** 插队：提升优先级并清掉退避。 */
    bump({ id } = {}) {
      return mutate((data) => {
        const task = find(data, id);
        if (task.status !== 'pending') return { task, unchanged: true };
        task.priority = 10;
        task.nextRunAt = null;
        log(data, 'bump', task, '插队到最前');
        return { task };
      });
    },

    /** 清理已结束任务；status 可限定只清 done / failed / cancelled。 */
    clearFinished({ status } = {}) {
      const only = FINISHED.has(status) ? status : null;
      return mutate((data) => {
        const before = data.tasks.length;
        data.tasks = data.tasks.filter((task) => !(only ? task.status === only : FINISHED.has(task.status)));
        const removed = before - data.tasks.length;
        if (removed) log(data, 'clear', null, `清理 ${removed} 个已结束任务`);
        return { removed };
      });
    },

    /** 崩溃恢复：running 超过 staleMs 没心跳的任务按 timeout 失败处理（可重试）。 */
    recover() {
      return mutate((data) => {
        const at = now();
        const stale = data.tasks.filter((task) => task.status === 'running' &&
          at - (Date.parse(task.heartbeatAt ?? task.startedAt ?? '') || 0) > limits.staleMs);
        for (const task of stale) failTask(data, task, at, 'timeout', '心跳超时（会话中断或插件重启）', 'recover');
        return { recovered: stale.length };
      });
    },

    /** 当前还能再并发启动几个。 */
    async capacity() {
      const data = await load();
      return Math.max(0, limits.maxConcurrent - runningOf(data).length);
    },
  };
}
