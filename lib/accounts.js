/**
 * PTA 账号目录 + 凭据保险箱。
 *
 * 两段式：
 *   1) 目录（非密）：<stateDir>/accounts.json —— id / 标签 / 状态 / 昵称 / 时间。
 *   2) 密文：DSH 凭据服务（ctx.credentials），键 `pta-autopilot/account-<uuid>`，
 *      payload = { cookie, uid, nickname }。Cookie 只在这一层和 HTTP 客户端之间流动，
 *      不进模型上下文、不写日志、不落明文磁盘。
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class AccountError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

const KEY_PREFIX = 'pta-autopilot/account-';
/** v0.5 及更早版本用的旧键前缀；读到旧键会迁移到新键，避免改名后已绑账号失效。 */
const LEGACY_KEY_PREFIX = 'dsh-pta/account-';
const STATE_VERSION = 1;
const STATUSES = new Set(['ready', 'auth_required', 'removed']);

function projection(row) {
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    nickname: row.nickname ?? '',
    email: row.email ?? '',
    login: row.login ?? '',
    updatedAt: row.updatedAt,
  };
}

export function createAccounts({ ctx, stateDir }) {
  const file = join(stateDir, 'accounts.json');
  let state = null;
  let foreignVersion = 0;
  let queue = Promise.resolve();

  function credentials() {
    const service = ctx.get?.('credentials') ?? ctx.credentials;
    if (service === undefined || typeof service.readRecord !== 'function' ||
        typeof service.modifyRecord !== 'function' || typeof service.deleteRecord !== 'function') {
      throw new AccountError('credentials_unavailable', '当前 profile 没有可用的凭据服务，无法安全保存 PTASession。');
    }
    return service;
  }

  async function load() {
    if (state !== null) return state;
    await mkdir(stateDir, { recursive: true });
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      const version = Number(parsed.version ?? 1);
      // 更高版本写出的文件：只读，绝不用旧结构覆盖（插件回退时保护新数据）
      if (version > STATE_VERSION) foreignVersion = version;
      state = { version: Math.max(version, STATE_VERSION), accounts: parsed.accounts ?? {}, default: parsed.default ?? null };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      state = { version: 1, accounts: {}, default: null };
    }
    return state;
  }

  async function persist() {
    const data = await load();
    if (foreignVersion) {
      throw new AccountError('state_version', `accounts.json 版本 ${foreignVersion} 高于本插件支持的 ${STATE_VERSION}，已拒绝写入，请升级插件。`);
    }
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 1), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
    await chmod(file, 0o600).catch(() => {});
  }

  function mutate(fn) {
    const next = queue.then(async () => {
      const data = await load();
      const result = await fn(data);
      await persist();
      return result;
    });
    queue = next.catch(() => {});
    return next;
  }

  const key = (id) => KEY_PREFIX + id;
  const legacyKey = (id) => LEGACY_KEY_PREFIX + id;

  /** 读密文：新键优先；只有旧键（改名前的 `dsh-pta/account-*`）时迁移到新键。 */
  async function readSession(id) {
    const service = credentials();
    let record = await service.readRecord(key(id));
    if (record === undefined || record === null) {
      const legacy = await service.readRecord(legacyKey(id));
      if (legacy !== undefined && legacy !== null) {
        if (legacy.kind === 'grant' && typeof legacy.payload?.cookie === 'string') {
          await service.modifyRecord(key(id), async () => legacy);
          await service.deleteRecord(legacyKey(id)).catch(() => {});
        }
        record = legacy;
      }
    }
    return record;
  }

  function pick(data, id) {
    const row = data.accounts[id];
    if (row === undefined || row.status === 'removed') throw new AccountError('not_found', `没有账号 ${id}。`);
    return row;
  }

  return {
    file,
    async init() {
      await load();
      return this;
    },
    list() {
      const data = state ?? { accounts: {} };
      return Object.values(data.accounts)
        .filter((row) => STATUSES.has(row.status) && row.status !== 'removed')
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .map(projection);
    },
    defaultId() {
      return state?.default ?? null;
    },
    resolve(id) {
      const rows = this.list();
      if (typeof id === 'string' && id !== '') {
        pick(state, id);
        return id;
      }
      if (state?.default && rows.some((row) => row.id === state.default)) return state.default;
      if (rows.length === 1) return rows[0].id;
      if (rows.length === 0) throw new AccountError('no_account', '还没有绑定 PTA 账号，先在「PTA 作业」面板里添加。');
      throw new AccountError('account_required', `有 ${rows.length} 个账号，请用 account 指定：${rows.map((row) => `${row.id}(${row.label})`).join('、')}`);
    },
    /** 读密文；只给 HTTP 客户端用。 */
    async session(id) {
      const row = pick(state ?? await load(), id);
      if (row.status === 'auth_required') throw new AccountError('auth_required', `账号 ${id} 的登录已失效，请重新录入 PTASession。`);
      const record = await readSession(id);
      if (record === undefined || record === null || record.kind !== 'grant' || typeof record.payload?.cookie !== 'string') {
        throw new AccountError('auth_required', `账号 ${id} 没有可用的 PTASession，请重新录入。`);
      }
      return { id, label: row.label, cookie: record.payload.cookie, uid: record.payload.uid ?? '' };
    },
    async add({ label, cookie, login, probe }) {
      const name = String(label ?? '').trim();
      const token = String(cookie ?? '').trim().replace(/^PTASession=/iu, '').trim();
      if (name === '') throw new AccountError('invalid_input', '账号标签不能为空。');
      if (token === '') throw new AccountError('invalid_input', 'PTASession 不能为空。');
      if (name.length > 64) throw new AccountError('invalid_input', '账号标签不超过 64 个字符。');
      if (token.length > 4096) throw new AccountError('invalid_input', 'PTASession 太长，检查是否复制多了。');

      const user = await probe(token); // 失败即抛 auth_required，不写任何东西
      const data = await load();
      const existing = Object.values(data.accounts).find((row) => row.status !== 'removed' && row.uid === user.uid);
      const id = existing?.id ?? randomUUID();
      await credentials().modifyRecord(key(id), async () => ({
        kind: 'grant',
        payload: { cookie: token, uid: user.uid, nickname: user.nickname },
      }));
      return mutate((draft) => {
        const now = new Date().toISOString();
        const previous = draft.accounts[id];
        draft.accounts[id] = {
          id,
          label: name,
          status: 'ready',
          nickname: user.nickname ?? '',
          email: user.email ?? '',
          uid: user.uid,
          login: login ?? previous?.login ?? '',
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        };
        if (!draft.default) draft.default = id;
        return projection(draft.accounts[id]);
      });
    },
    async check(id, probe) {
      const row = pick(state ?? await load(), id);
      const record = await readSession(id);
      const cookie = record?.payload?.cookie;
      if (typeof cookie !== 'string' || cookie === '') throw new AccountError('auth_required', `账号 ${id} 没有可用的 PTASession。`);
      let user;
      try {
        user = await probe(cookie);
      } catch (error) {
        await mutate((draft) => {
          const target = draft.accounts[id];
          if (target) target.status = 'auth_required';
        });
        throw error;
      }
      return mutate((draft) => {
        const target = draft.accounts[id];
        target.status = 'ready';
        target.nickname = user.nickname ?? target.nickname;
        target.email = user.email ?? target.email;
        target.updatedAt = new Date().toISOString();
        return projection(target);
      });
    },
    async markAuthRequired(id) {
      await mutate((draft) => {
        const target = draft.accounts[id];
        if (target && target.status !== 'removed') target.status = 'auth_required';
      }).catch(() => {});
    },
    async remove(id) {
      pick(state ?? await load(), id);
      await credentials().deleteRecord(key(id)).catch(() => {});
      await credentials().deleteRecord(legacyKey(id)).catch(() => {});
      return mutate((draft) => {
        delete draft.accounts[id];
        if (draft.default === id) {
          const rest = Object.keys(draft.accounts);
          draft.default = rest[0] ?? null;
        }
        return { id };
      });
    },
    async setDefault(id) {
      pick(state ?? await load(), id);
      return mutate((draft) => {
        draft.default = id;
        return { default: id };
      });
    },
    /** 已有账号的 row（含 uid），给 add 去重用。 */
    row(id) {
      return state?.accounts?.[id];
    },
  };
}
