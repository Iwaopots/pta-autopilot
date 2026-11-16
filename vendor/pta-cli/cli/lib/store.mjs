import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as pathResolve, sep as pathSep } from 'node:path';
import { randomUUID } from 'node:crypto';

// v1 用 JSON 存账号表（省掉 sqlite 依赖）；v0.3 照 educoder 的 accounts.js 换 sqlite。
// 密码永不落盘：这里只存账号元数据，cookie 存在各账号自己的 session.json（0600）。

export function stateRoot() {
  return process.env.PTA_STATE_DIR || join(homedir(), '.pta');
}

export function accountsFile() {
  return join(stateRoot(), 'accounts.json');
}

export function accountDir(id) {
  return join(stateRoot(), 'accounts', id);
}

export function ensureState() {
  mkdirSync(join(stateRoot(), 'accounts'), { recursive: true });
  if (!existsSync(accountsFile())) {
    writeFileSync(accountsFile(), JSON.stringify({ version: 1, accounts: [] }, null, 2), { mode: 0o600 });
  }
}

export function loadAccounts() {
  ensureState();
  try {
    return JSON.parse(readFileSync(accountsFile(), 'utf8')).accounts;
  } catch {
    return [];
  }
}

function saveAccounts(list) {
  writeFileSync(accountsFile(), JSON.stringify({ version: 1, accounts: list }, null, 2), { mode: 0o600 });
}

export function maskLogin(login) {
  if (!login) return '***';
  if (login.includes('@')) {
    const [u, d] = login.split('@');
    return `${u.slice(0, 2)}***@${d}`;
  }
  return login.length > 4 ? `${login.slice(0, 3)}***${login.slice(-2)}` : '***';
}

export function addAccount({ label, login }) {
  const list = loadAccounts();
  const id = randomUUID();
  // login 存原文（邮箱/手机号）：重登时要拿它当登录名；它不是密码，
  // accounts.json 本身 0600，只在本地。loginMasked 只用于展示。
  const row = { id, label: label || login, login, loginMasked: maskLogin(login), status: 'unverified', updatedAt: new Date().toISOString() };
  mkdirSync(join(accountDir(id), 'progress'), { recursive: true });
  mkdirSync(join(accountDir(id), 'work'), { recursive: true });
  list.push(row);
  saveAccounts(list);
  return row;
}

export function setAccountStatus(id, status) {
  const list = loadAccounts();
  const row = list.find((a) => a.id === id);
  if (!row) return null;
  row.status = status;
  row.updatedAt = new Date().toISOString();
  saveAccounts(list);
  return row;
}

// 账号启用 / 停用（面板“值得有”动作）：停用的账号 run 会直接拒绝，
// 不用删号重登。缺字段时默认启用（兼容 v0.1/v0.2 建的旧账号）。
export function setAccountEnabled(id, enabled) {
  const list = loadAccounts();
  const row = list.find((a) => a.id === id);
  if (!row) return null;
  row.enabled = enabled !== false;
  row.updatedAt = new Date().toISOString();
  saveAccounts(list);
  return row;
}

export function isAccountEnabled(row) {
  return row?.enabled !== false;
}

// 登录限频时间戳（PTA-mcp 的 login.py：登录限频 20 秒）。
// 按登录名查最近一次尝试（同一用户重复登录会建多个账号行，按登录名聚合）。
export function getLastLoginAtByLogin(login) {
  const list = loadAccounts().filter((a) => a.login === login && a.lastLoginAt);
  if (!list.length) return 0;
  return Math.max(...list.map((a) => new Date(a.lastLoginAt).getTime()));
}

export function setLastLoginAt(id, ts = new Date().toISOString()) {
  const list = loadAccounts();
  const row = list.find((a) => a.id === id);
  if (!row) return null;
  row.lastLoginAt = ts;
  saveAccounts(list);
  return row;
}

// --account 接受 id 或 label；不传时只有一个可用账号自动选中，多个则报错。
export function resolveAccount(ref) {
  const list = loadAccounts().filter((a) => a.status !== 'removed');
  if (ref) {
    const row = list.find((a) => a.id === ref || a.label === ref);
    if (!row) throw new Error(`account not found: ${ref}`);
    return row;
  }
  if (list.length === 1) return list[0];
  if (list.length === 0) throw new Error('no accounts yet, run `login` first');
  throw new Error('multiple accounts, pass --account <id|label>');
}

export function sessionFile(id) {
  return join(accountDir(id), 'session.json');
}

export function readSession(id) {
  try {
    return JSON.parse(readFileSync(sessionFile(id), 'utf8'));
  } catch {
    return null;
  }
}

export function writeSession(id, session) {
  const file = sessionFile(id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows 无 unix 权限位 */ }
}

export function clearSession(id) {
  try {
    writeFileSync(sessionFile(id), JSON.stringify({ cookie: '', updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  } catch { /* ignore */ }
}

// ---- 路径守卫（kisaki server.py 的 _read_work_file：WORK_DIR 内文件读取带越界拒绝）----
// 所有由外部输入（题集 id、题号、program_path）拼出来的路径都必须过这一关：
// 解析后必须仍在 base 目录内，否则抛错，防 `../../etc` 这类穿越。
export function resolveWithin(base, rel) {
  const baseResolved = pathResolve(base);
  const target = pathResolve(baseResolved, String(rel || ''));
  if (target !== baseResolved && !target.startsWith(baseResolved + pathSep)) {
    throw new Error(`path escapes base dir: ${rel}`);
  }
  return target;
}

export function progressFile(id, psid) {
  return resolveWithin(join(accountDir(id), 'progress'), `${psid}.json`);
}

// ---- v0.2：单题跳过清单（面板“单题重试 / 跳过”用，存在 state.json）：
// 键 "<accountId>:<psid>" -> [pspId, ...]。跳过是软标记，取消跳过即恢复。
export function skipProblem(accountId, psid, pspId, skip = true) {
  const state = readState();
  state.skipped = state.skipped || {};
  const key = `${accountId}:${psid}`;
  const list = new Set(state.skipped[key] || []);
  if (skip) list.add(pspId);
  else list.delete(pspId);
  state.skipped[key] = [...list];
  writeState(state);
  return state.skipped[key];
}

export function isSkipped(accountId, psid, pspId) {
  const state = readState();
  const list = (state.skipped || {})[`${accountId}:${psid}`] || [];
  return list.includes(pspId);
}

// ---- v0.2：待复核队列（dsh-task-panel 的验收/返工闭环，只参考思路、不抄代码）----
// 做题 → 自动复核 → 待验收 → 通过（accept）/ 返工（rework），最多 5 次返工。
// 低置信（<0.75 不提交）、停表 blocked、自测失败的题都进这里，等人拍板，
// 而不是机器自己反复试。存在 state.json 的 `review` 数组里（最多 200 条）。
// key = "<accountId>:<psid>:<pspId>"；status: pending / rework / accepted / exhausted。
export const MAX_REWORK = 5;

export function reviewKey(accountId, psid, pspId) {
  return `${accountId}:${psid}:${pspId}`;
}

export function addReviewItem(accountId, { psid, pspId, type, reason, detail = {} }) {
  const state = readState();
  state.review = state.review || [];
  const key = reviewKey(accountId, psid, pspId);
  const now = new Date().toISOString();
  const existing = state.review.find((r) => r.key === key);
  if (existing && (existing.status === 'pending' || existing.status === 'rework')) {
    // 同一题还在复核流程里：更新原因与时间，保留返工计数；返工满 5 次即耗尽。
    existing.reason = reason;
    existing.detail = detail;
    existing.updatedAt = now;
    if ((existing.reworkCount || 0) >= MAX_REWORK) existing.status = 'exhausted';
    else existing.status = 'pending';
  } else {
    state.review.push({
      key, accountId, psid, pspId, type, reason, detail,
      status: 'pending', reworkCount: 0, createdAt: now, updatedAt: now,
    });
    if (state.review.length > 200) state.review = state.review.slice(-200);
  }
  writeState(state);
  return state.review.find((r) => r.key === key);
}

export function getReviewItems(accountId = '', { status = '' } = {}) {
  const state = readState();
  let list = state.review || [];
  if (accountId) list = list.filter((r) => r.accountId === accountId);
  if (status) list = list.filter((r) => r.status === status);
  return list;
}

export function updateReviewItem(key, patch) {
  const state = readState();
  const item = (state.review || []).find((r) => r.key === key);
  if (!item) return null;
  Object.assign(item, patch, { updatedAt: new Date().toISOString() });
  writeState(state);
  return item;
}

// ---- v0.2：任务记录（面板 jobs 端点读它；state.json 是真相，
// 内存里的 currentJob 只是运输）。只保留最近 20 条。
export function recordJob(job) {
  const state = readState();
  state.jobs = state.jobs || [];
  state.jobs.push({
    id: job.id, queueJobId: job.queueJobId || '', accountId: job.accountId || '', accountLabel: job.accountLabel || '',
    problemSet: job.problemSet || '', mode: job.mode || 'all',
    status: job.status, startedAt: job.startedAt || '', finishedAt: job.finishedAt || '',
    error: job.error || '',
  });
  state.jobs = state.jobs.slice(-20);
  writeState(state);
  return state.jobs[state.jobs.length - 1];
}

export function updateJob(id, patch) {
  const state = readState();
  const row = (state.jobs || []).find((j) => j.id === id);
  if (!row) return null;
  Object.assign(row, patch);
  writeState(state);
  return row;
}

export function getJob(id) {
  const state = readState();
  return (state.jobs || []).find((j) => j.id === id) || null;
}

// 按队列任务 id 反查面板任务记录（幂等去重时把队列 id 翻回面板 job id，
// 让“同 key 第二次提交”返回的 jobId 与第一次一致）。
export function getJobByQueueId(queueJobId) {
  if (!queueJobId) return null;
  const state = readState();
  return (state.jobs || []).find((j) => j.queueJobId === queueJobId) || null;
}

// ---- v0.2：全局运行状态（serve / dashboard 读它）----
export function stateFile() {
  return join(stateRoot(), 'state.json');
}

export function readState() {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch {
    return { version: 1, updatedAt: '', accounts: {} };
  }
}

export function writeState(state) {
  ensureState();
  state.updatedAt = new Date().toISOString();
  writeFileSync(stateFile(), JSON.stringify(state, null, 2));
}

// 更新某账号某题集的状态（不存在的层级自动建），每步完成后即调。
export function updateRunState(accountId, psid, patch, problemPatch = null) {
  const state = readState();
  state.accounts[accountId] = state.accounts[accountId] || { sets: {} };
  const sets = state.accounts[accountId].sets;
  sets[psid] = { ...(sets[psid] || { problems: {} }), ...patch };
  if (problemPatch) {
    for (const [pid, p] of Object.entries(problemPatch)) {
      sets[psid].problems[pid] = { ...(sets[psid].problems[pid] || {}), ...p };
    }
  }
  writeState(state);
  return state;
}

// ---- v0.2：审计日志（每账号一个 JSONL，时间/题/动作/结果）----
export function auditFile(id) {
  return join(accountDir(id), 'progress', 'audit.jsonl');
}

export function appendAudit(id, entry) {
  const file = auditFile(id);
  mkdirSync(dirname(file), { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  appendFileSync(file, line);
  // 审计轮转（dsh-ops 的 WAL 思想：append-log + 上限）：文件超过 2MB 时
  // 只保留最近 1000 行，别让单个账号的日志无限长下去。
  try {
    if (statSync(file).size > 2 * 1024 * 1024) {
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      writeFileSync(file, lines.slice(-1000).join('\n') + '\n');
    }
  } catch { /* best effort */ }
}

export function readAudit(id, limit = 100) {
  try {
    const lines = readFileSync(auditFile(id), 'utf8').trim().split('\n').filter(Boolean);
    // 逐行容错：两个进程（CLI + serve）同时读写同一审计文件时，
    // 读到追加中的半行会 JSON.parse 失败——跳过坏行，别让整条读取崩掉。
    const out = [];
    for (const l of lines.slice(-limit)) {
      try { out.push(JSON.parse(l)); } catch { /* torn line, skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

// ---- v0.2：缓存（vscode-pintia 的缓存思想）----
// 题集列表缓存 5 分钟、题目按题集落盘；按账号隔离（kisaki 的警告：缓存路径
// 全局、账号切换不清会串号——按账号分目录可避开）。只缓存 problemSets 与
// examProblems，不缓存状态/提交。手动刷新/切换账号时失效。
export const CACHE_TTL_MS = 5 * 60 * 1000;

export function cacheFile(id, key) {
  return join(accountDir(id), 'cache', `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

export function writeCache(id, key, data) {
  const file = cacheFile(id, key);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ cachedAt: Date.now(), data }), { mode: 0o600 });
}

export function readCache(id, key, ttlMs = CACHE_TTL_MS) {
  try {
    const raw = JSON.parse(readFileSync(cacheFile(id, key), 'utf8'));
    if (Date.now() - (raw.cachedAt || 0) > ttlMs) return null;
    return raw.data;
  } catch {
    return null;
  }
}

export function invalidateCache(id, key = null) {
  try {
    if (key) {
      rmSync(cacheFile(id, key), { force: true });
    } else {
      rmSync(join(accountDir(id), 'cache'), { recursive: true, force: true });
    }
  } catch { /* best effort */ }
}

// ---- v0.2：凭据引用（只存 key，不存密码）----
export function credentialRefFile(id) {
  return join(accountDir(id), 'credential-ref.json');
}

export function writeCredentialRef(id, ref) {
  const file = credentialRefFile(id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...ref, storedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

export function readCredentialRef(id) {
  try {
    return JSON.parse(readFileSync(credentialRefFile(id), 'utf8'));
  } catch {
    return null;
  }
}

// ---- v0.2：账号删除（危险动作）：状态置 removed、清会话、删凭据引用；
// 账号目录（审计日志）保留备查，不删文件。
export function removeAccount(id) {
  const list = loadAccounts();
  const row = list.find((a) => a.id === id);
  if (!row) return null;
  row.status = 'removed';
  row.updatedAt = new Date().toISOString();
  saveAccounts(list);
  clearSession(id);
  try {
    const f = credentialRefFile(id);
    if (existsSync(f)) unlinkSync(f);
  } catch { /* ignore */ }
  return row;
}

// ---- v0.2：清缓存（进度缓存 *.json，审计日志 audit.jsonl 不动，会话不动）----
export function clearProgressCache(id) {
  const dir = join(accountDir(id), 'progress');
  let removed = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.json')) {
        unlinkSync(join(dir, f));
        removed++;
      }
    }
  } catch { /* no cache yet */ }
  return removed;
}

// ---- v0.2：设置（存在 state.json 的 settings 里，面板可改）----
export function readSettings() {
  const state = readState();
  return { pace: 'normal', maxFixes: 3, model: '', ...(state.settings || {}) };
}

export function writeSettings(patch) {
  const state = readState();
  state.settings = { ...readSettings(), ...patch };
  writeState(state);
  return state.settings;
}

// ---- v0.2：当前账号（面板“切换账号”用，存在 state.json）----
export function getActiveAccountId() {
  return readState().activeAccountId || '';
}

export function setActiveAccountId(id) {
  const state = readState();
  state.activeAccountId = id;
  writeState(state);
}

export function writeProgress(id, psid, data) {
  const file = progressFile(id, psid);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

export function readProgress(id, psid) {
  try {
    return JSON.parse(readFileSync(progressFile(id, psid), 'utf8'));
  } catch {
    return null;
  }
}
