// 任务队列：vardiya（MIT，Copyright (c) 2026 vardiya contributors）的机制
// 移植到 node:sqlite（Node ≥22 内置，零新增依赖）。移植片段见 RESEARCH.md §13.2：
// 五态状态机、fixed/exponential backoff + jitter、幂等键唯一索引、WAL +
// UPDATE ... RETURNING 原子认领、AdaptivePoller、FIFO 信号量、维护循环、
// UnrecoverableError、release() 优雅停机、5-field cron 解析。
// 许可证文本见 ../LICENSE-vardiya-MIT.txt（原仓库 LICENSE 的复制件）。
// 未移植（见 PLAN.md §11）：repeatables/cron 定时物化——定时全量跑是红线，
// 维护循环的物化一步因此空缺；WorkerRuntime 全套——serve 的 IIFE 就是 worker，
// AbortSignal 由 run 的 shouldStop 承担，心跳由 touch() 承担。
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY NOT NULL,
  queue TEXT NOT NULL,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'active', 'completed', 'delayed', 'dead')
  ),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  run_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT,
  heartbeat_at INTEGER,
  backoff_json TEXT,
  result_json TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  dedup_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_claim
  ON jobs (queue, status, priority DESC, run_at, id);

CREATE INDEX IF NOT EXISTS idx_jobs_promote
  ON jobs (status, run_at)
  WHERE status = 'delayed';

CREATE INDEX IF NOT EXISTS idx_jobs_stale
  ON jobs (status, heartbeat_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_jobs_cleanup
  ON jobs (status, updated_at)
  WHERE status IN ('completed', 'dead');

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedup
  ON jobs (queue, dedup_key)
  WHERE dedup_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
`;

// ---- backoff（vardiya src/storage/sqlite.ts 的 computeBackoffMs，逐行移植）----
export const DEFAULT_BACKOFF = { type: 'exponential', delayMs: 1000, maxDelayMs: 60000, jitter: true };

export function computeBackoffMs(backoff, attempt) {
  const safeAttempt = Math.max(1, attempt);
  let delay;
  if (backoff.type === 'fixed') {
    delay = backoff.delayMs;
  } else {
    delay = backoff.delayMs * 2 ** (safeAttempt - 1);
    if (backoff.maxDelayMs !== undefined) {
      delay = Math.min(delay, backoff.maxDelayMs);
    }
  }
  if (backoff.jitter) {
    delay = Math.floor(Math.random() * (delay + 1));
  }
  return Math.max(0, delay);
}

// ---- AdaptivePoller（vardiya src/worker/poller.ts，逐行移植）----
// 命中后延迟重置为 minMs（负载下保持灵敏）；空命中每次 ×2 直到 maxMs。
export class AdaptivePoller {
  #minMs;
  #maxMs;
  #factor;
  #delayMs;

  constructor({ minMs, maxMs, factor = 2 } = {}) {
    if (!Number.isFinite(minMs) || minMs < 0) throw new Error('AdaptivePoller minMs must be a non-negative number');
    if (!Number.isFinite(maxMs) || maxMs < minMs) throw new Error('AdaptivePoller maxMs must be >= minMs');
    if (!Number.isFinite(factor) || factor < 1) throw new Error('AdaptivePoller factor must be >= 1');
    this.#minMs = minMs;
    this.#maxMs = maxMs;
    this.#factor = factor;
    this.#delayMs = minMs;
  }

  get delayMs() { return this.#delayMs; }
  onHit() { this.#delayMs = this.#minMs; }
  onMiss() {
    const wait = this.#delayMs;
    const next = this.#delayMs === 0 ? Math.max(1, this.#minMs) : this.#delayMs * this.#factor;
    this.#delayMs = Math.min(this.#maxMs, next);
    return wait;
  }
  reset() { this.#delayMs = this.#minMs; }
}

// ---- Semaphore（vardiya src/worker/semaphore.ts，逐行移植）----
// 计数信号量，等待者按先进先出唤醒。
export class Semaphore {
  #available;
  #waiters = [];

  constructor(count) {
    if (!Number.isInteger(count) || count < 1) throw new Error('Semaphore count must be a positive integer');
    this.#available = count;
  }

  get available() { return this.#available; }
  get pending() { return this.#waiters.length; }

  tryAcquire() {
    if (this.#available > 0) {
      this.#available -= 1;
      return true;
    }
    return false;
  }

  acquire() {
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise((resolve) => { this.#waiters.push(resolve); });
  }

  release() {
    const next = this.#waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.#available += 1;
  }
}

// ---- UnrecoverableError（vardiya src/worker/worker.ts）----
// handler 抛此错时任务直接进 dead，不重试、不走 backoff。
export class UnrecoverableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

// ---- cron 解析（vardiya src/scheduler/cron.ts 的语义，改写后用）----
// 5-field cron + @hourly/@daily/@weekly/@monthly；月份/星期支持英文名；
// 星期 7 归一为 0（周日）；day-of-month 与 day-of-week 按标准 cron 的 OR 语义
// （两者都不是 * 时任一命中即算；其一为 * 时只看另一方）。
const CRON_ALIASES = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
};
const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseCronField(field, min, max, names) {
  const out = new Set();
  const add = (v) => {
    if (v < min || v > max) throw new SyntaxError(`cron field value ${v} out of range ${min}-${max}`);
    out.add(v);
  };
  for (const part of String(field).split(',')) {
    let range = part;
    let step = 1;
    const slash = part.indexOf('/');
    if (slash >= 0) {
      range = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) throw new SyntaxError(`bad cron step: ${part}`);
    }
    const resolve = (s) => {
      const lower = String(s).toLowerCase();
      if (names && lower in names) return names[lower];
      const n = Number(s);
      if (!Number.isInteger(n)) throw new SyntaxError(`bad cron value: ${s}`);
      return n;
    };
    if (range === '*' || range === '') {
      for (let v = min; v <= max; v += step) add(v);
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      const lo = resolve(a);
      const hi = resolve(b);
      if (lo > hi) throw new SyntaxError(`bad cron range: ${range}`);
      for (let v = lo; v <= hi; v += step) add(v);
    } else {
      add(resolve(range));
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr) {
  const trimmed = String(expr || '').trim();
  if (!trimmed) throw new SyntaxError('cron expression is empty');
  const expanded = CRON_ALIASES[trimmed.toLowerCase()] ?? trimmed;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) throw new SyntaxError(`cron expression must have 5 fields (got ${fields.length}): ${expr}`);
  const [minF, hourF, domF, monF, dowF] = fields;
  const domAny = domF === '*';
  const dowAny = dowF === '*';
  const minutes = parseCronField(minF, 0, 59);
  const hours = parseCronField(hourF, 0, 23);
  const doms = parseCronField(domF, 1, 31);
  const months = parseCronField(monF, 1, 12, MONTH_NAMES);
  const rawDows = parseCronField(dowF, 0, 7, DOW_NAMES);
  const dows = [...new Set(rawDows.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  return { minutes, hours, doms, months, dows, domAny, dowAny, expression: expanded };
}

export function nextRun(expr, from) {
  const s = typeof expr === 'string' ? parseCron(expr) : expr;
  const start = new Date(from);
  // 从下一分钟开始逐分钟找，最多找 366 天（防无解表达式死循环）。
  const limit = start.getTime() + 366 * 24 * 3600 * 1000;
  const t = new Date(start.getTime() + 60000);
  t.setSeconds(0, 0);
  while (t.getTime() <= limit) {
    const domMatch = s.doms.includes(t.getUTCDate());
    const dowMatch = s.dows.includes(t.getUTCDay());
    const dayMatch = s.domAny && s.dowAny ? true : s.domAny ? dowMatch : s.dowAny ? domMatch : (domMatch || dowMatch);
    if (s.minutes.includes(t.getUTCMinutes()) && s.hours.includes(t.getUTCHours()) && s.months.includes(t.getUTCMonth() + 1) && dayMatch) {
      return t;
    }
    t.setTime(t.getTime() + 60000);
  }
  throw new Error(`no next cron run within a year for: ${s.expression}`);
}

// ---- 队列存储（vardiya src/storage/sqlite.ts 的机制，node:sqlite 同步 API 平移）----
function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    queue: row.queue,
    name: row.name,
    payload: JSON.parse(row.payload || '{}'),
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: row.run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
    heartbeatAt: row.heartbeat_at,
    backoff: row.backoff_json ? JSON.parse(row.backoff_json) : null,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    cancelRequested: row.cancel_requested === 1,
    dedupKey: row.dedup_key,
  };
}

export class JobQueue {
  #db;
  #closed = false;

  constructor(dbPath) {
    if (dbPath && dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath || ':memory:');
    // WAL + synchronous NORMAL（vardiya 的配置；多进程安全靠 WAL + 原子 UPDATE）。
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA_SQL);
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  #assertOpen() {
    if (this.#closed) throw new Error('job queue is closed');
  }

  // 入队：jobId 是幂等键（存 dedup_key，行 id 永远是生成的唯一主键）；
  // 同一 queue + 同一 dedup_key 已存在时返回已有任务，不重复建。
  enqueue({ queue = 'default', name = '', payload = {}, jobId = null, priority = 0, delayMs = 0, runAt = null, maxAttempts = 3, backoff = null } = {}) {
    this.#assertOpen();
    const now = Date.now();
    const runAtMs = runAt ?? (delayMs ? now + delayMs : now);
    const status = runAtMs > now ? 'delayed' : 'pending';
    const id = randomUUID();
    try {
      this.#db.prepare(`
        INSERT INTO jobs (id, queue, name, payload, status, priority, attempts, max_attempts,
          run_at, created_at, updated_at, last_error, heartbeat_at, backoff_json, result_json,
          cancel_requested, dedup_key)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, NULL, ?, NULL, 0, ?)
      `).run(id, queue, name, JSON.stringify(payload), status, priority, maxAttempts, runAtMs, now, now, backoff ? JSON.stringify(backoff) : null, jobId);
    } catch (e) {
      // 唯一索引冲突：幂等键已存在，返回已有任务。
      if (jobId != null && /UNIQUE constraint failed/i.test(e.message)) {
        const existing = this.getJobByDedup(queue, jobId);
        if (existing) return { job: existing, dedup: true };
      }
      throw e;
    }
    return { job: this.getJob(id), dedup: false };
  }

  // 原子认领：单条 UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *，
  // 两个 worker 不会抢到同一行；认领时 attempts +1、刷心跳。
  claimNext(queues = [], now = Date.now()) {
    this.#assertOpen();
    const q = queues.length
      ? `queue IN (${queues.map(() => '?').join(',')}) AND `
      : '';
    const row = this.#db.prepare(`
      UPDATE jobs SET status = 'active', attempts = attempts + 1,
        heartbeat_at = ?, updated_at = ?
      WHERE id = (
        SELECT id FROM jobs
        WHERE ${q}status = 'pending' AND run_at <= ?
        ORDER BY priority DESC, run_at ASC, id ASC LIMIT 1
      )
      RETURNING *
    `).get(now, now, ...queues, now);
    return row ? { job: rowToJob(row) } : null;
  }

  // 按 id 定向认领：面板 run 刚入队的那个任务（claimNext 按优先级取队首，
  // 崩溃恢复后可能有更旧的 pending 任务，不能让它抢跑用户刚点的任务）。
  claim(id, now = Date.now()) {
    this.#assertOpen();
    const row = this.#db.prepare(`
      UPDATE jobs SET status = 'active', attempts = attempts + 1,
        heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND run_at <= ?
      RETURNING *
    `).get(now, now, id, now);
    return rowToJob(row);
  }

  // 启动扫尾：把从未开始的 pending 任务记 dead（serve 停机前入队、未认领的）。
  // 只扫指定队列、指定时间以前创建的，避免误删刚入队还没认领的任务。
  failStalePending(queue, olderThanMs = 0, error = 'never started', now = Date.now()) {
    this.#assertOpen();
    const r = this.#db.prepare(`
      UPDATE jobs SET status = 'dead', last_error = ?, updated_at = ?
      WHERE queue = ? AND status = 'pending' AND created_at <= ?
    `).run(error, now, queue, now - olderThanMs);
    return r.changes;
  }

  complete(id, result) {
    this.#assertOpen();
    const now = Date.now();
    this.#db.prepare(`
      UPDATE jobs SET status = 'completed', updated_at = ?, result_json = ?
      WHERE id = ? AND status = 'active'
    `).run(now, result === undefined ? null : JSON.stringify(result), id);
  }

  // 失败：UnrecoverableError 或 attempts 已满 → dead；否则按 backoff 回 delayed/pending。
  // retryable=false 也直接进 dead。非 active 行是 no-op，返回当前任务。
  fail({ id, error = '', retryable = true, nextRunAt = undefined } = {}) {
    this.#assertOpen();
    const now = Date.now();
    const row = this.#db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!row) throw new Error(`fail: job not found: ${id}`);
    if (row.status !== 'active') return rowToJob(row);
    const isUnrecoverable = error instanceof UnrecoverableError;
    const attemptsRemain = row.attempts < row.max_attempts;
    if (isUnrecoverable || !retryable || !attemptsRemain) {
      this.#db.prepare(`UPDATE jobs SET status = 'dead', last_error = ?, updated_at = ? WHERE id = ?`)
        .run(error instanceof Error ? error.message : String(error), now, id);
      return this.getJob(id);
    }
    let next = nextRunAt;
    if (next === undefined) {
      const backoff = row.backoff_json ? JSON.parse(row.backoff_json) : DEFAULT_BACKOFF;
      next = now + computeBackoffMs(backoff, row.attempts);
    }
    const status = next > now ? 'delayed' : 'pending';
    this.#db.prepare(`UPDATE jobs SET status = ?, run_at = ?, last_error = ?, updated_at = ? WHERE id = ?`)
      .run(status, next, error instanceof Error ? error.message : String(error), now, id);
    return this.getJob(id);
  }

  moveToDead(id, error = '') {
    this.#assertOpen();
    const now = Date.now();
    this.#db.prepare(`UPDATE jobs SET status = 'dead', last_error = ?, updated_at = ? WHERE id = ? AND status = 'active'`)
      .run(error instanceof Error ? error.message : String(error), now, id);
  }

  promoteDelayed(now = Date.now()) {
    this.#assertOpen();
    const r = this.#db.prepare(`UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'delayed' AND run_at <= ?`).run(now, now);
    return r.changes;
  }

  // 刷心跳（JobContext.touch()）；返回是否有人请求取消。
  heartbeat(id, now = Date.now()) {
    this.#assertOpen();
    const row = this.#db.prepare(`UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND status = 'active' RETURNING cancel_requested`).get(now, id);
    return row !== undefined && row.cancel_requested === 1;
  }

  // 回收失联任务：心跳超过 staleAfterMs 的 active 任务，attempts 已满的进 dead
  //（写 stalled 原因），其余回 pending（attempts 保留——崩溃本身就是一次失败信号）。
  reclaimStale(now = Date.now(), staleAfterMs = 30000) {
    this.#assertOpen();
    const threshold = now - staleAfterMs;
    const r = this.#db.prepare(`
      UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
        last_error = CASE WHEN attempts >= max_attempts THEN 'stalled: heartbeat expired after max attempts' ELSE last_error END,
        updated_at = ?
      WHERE status = 'active' AND heartbeat_at <= ?
    `).run(now, threshold);
    return r.changes;
  }

  // 优雅停机：active 任务放回 pending，撤销认领时加的那一次 attempt 计数，
  // 不写 lastError、不烧重试次数（vardiya release() 的关键细节）。
  release(id) {
    this.#assertOpen();
    const now = Date.now();
    const row = this.#db.prepare(`
      UPDATE jobs SET status = 'pending', attempts = MAX(0, attempts - 1),
        heartbeat_at = NULL, cancel_requested = 0, updated_at = ?
      WHERE id = ? AND status = 'active'
      RETURNING *
    `).get(now, id);
    if (!row) throw new Error(`release: active job not found: ${id}`);
    return rowToJob(row);
  }

  cancel(id) {
    this.#assertOpen();
    const now = Date.now();
    const row = this.#db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!row) return null;
    if (row.status === 'pending' || row.status === 'delayed') {
      this.#db.prepare(`UPDATE jobs SET status = 'dead', last_error = 'cancelled', updated_at = ? WHERE id = ?`).run(now, id);
    } else if (row.status === 'active') {
      this.#db.prepare(`UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?`).run(now, id);
    }
    return this.getJob(id);
  }

  getJob(id) {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return rowToJob(row);
  }

  getJobByDedup(queue, dedupKey) {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM jobs WHERE queue = ? AND dedup_key = ?').get(queue, dedupKey);
    return rowToJob(row);
  }

  counts(queue = null) {
    this.#assertOpen();
    const rows = queue
      ? this.#db.prepare(`SELECT status, COUNT(*) AS n FROM jobs WHERE queue = ? GROUP BY status`).all(queue)
      : this.#db.prepare(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`).all();
    const out = { pending: 0, active: 0, completed: 0, delayed: 0, dead: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  // 清理 7 天前的终态任务。
  cleanup(olderThanMs = 7 * 24 * 3600 * 1000, now = Date.now()) {
    this.#assertOpen();
    const r = this.#db.prepare(`DELETE FROM jobs WHERE status IN ('completed', 'dead') AND updated_at <= ?`).run(now - olderThanMs);
    return r.changes;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

export function openJobQueue(dbPath) {
  return new JobQueue(dbPath);
}

// ---- 维护循环（vardiya src/scheduler/scheduler.ts 的 MaintenanceLoop，改写后用）----
// 每 tick 四步顺序：promoteDelayed → reclaimStale（默认 30 秒无心跳）→ cleanup
// （每 60 tick 一次）；物化 repeatables 一步空缺（定时全量跑是红线，见文件头注释）。
// tick 抛错不杀 interval（onError 接住）；启动时先立即 tick 一次；计时器 unref。
export function startMaintenanceLoop(queue, { tickMs = 1000, staleAfterMs = 30000, cleanupEveryTicks = 60, onError = () => {} } = {}) {
  const poller = new AdaptivePoller({ minMs: 10, maxMs: tickMs });
  let ticks = 0;
  let stopped = false;
  let timer = null;

  const tick = () => {
    if (stopped) return;
    try {
      const promoted = queue.promoteDelayed();
      const reclaimed = queue.reclaimStale(Date.now(), staleAfterMs);
      ticks += 1;
      if (ticks % cleanupEveryTicks === 0) queue.cleanup();
      if (promoted + reclaimed > 0) poller.onHit();
      else poller.onMiss();
    } catch (e) {
      onError(e);
      poller.onMiss();
    }
    timer = setTimeout(tick, poller.delayMs);
    timer.unref?.();
  };
  tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
