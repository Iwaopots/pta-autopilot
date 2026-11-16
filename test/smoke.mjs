/**
 * 离线冒烟：不碰真实 PTA 账号，验证装配、工具注册、API 鉴权/错误映射、保险箱读写、Skill 同步。
 * 运行：node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import { createAccounts } from '../lib/accounts.js';

const results = [];
const check = async (name, fn) => {
  await fn();
  results.push(name);
  console.log(`ok - ${name}`);
};

function fakeCredentials() {
  const records = new Map();
  return {
    records,
    async readRecord(key) {
      return records.get(key);
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key));
      if (next === undefined) records.delete(key);
      else records.set(key, next);
      return next;
    },
    async deleteRecord(key) {
      records.delete(key);
    },
  };
}

function makeCtx(credentials, sink) {
  return {
    logger: { info() {}, warn() {}, debug() {} },
    get: (name) => (name === 'credentials' ? credentials : undefined),
    effect: (fn) => fn(),
    connection: { requestRejection: () => undefined },
    tools: { register: (definition) => { sink.tools.push(definition); return () => {}; } },
    webServer: { register: (route) => { sink.routes.push(route); return () => {}; } },
  };
}

function makeReq(body, method = 'POST') {
  const payload = Buffer.from(JSON.stringify(body));
  return {
    method,
    url: '/dsh-pta/api',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  };
}

function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(text) { this.body = text; },
  };
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-pta-smoke-'));
const stateDir = join(dir, 'state');
const skillDir = join(dir, 'skills');
const credentials = fakeCredentials();
const sink = { tools: [], routes: [] };

try {
  apply(makeCtx(credentials, sink), { stateDir, skillDir, syncSkill: true });

  await check('注册 8 个 pta_* 工具', () => {
    const names = sink.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['pta_accounts', 'pta_brief', 'pta_cli', 'pta_pull', 'pta_sets', 'pta_status', 'pta_submit_obj', 'pta_submit_prog']);
    for (const tool of sink.tools) {
      assert.equal(typeof tool.parameters, 'object');
      assert.ok(tool.description.length > 20);
      assert.ok(tool.output && tool.output.schema && typeof tool.output.render === 'function', `${tool.name} 缺少 output`);
    }
  });

  await check('注册 API 与诊断路由', () => {
    const api = sink.routes.find((route) => route.path === '/dsh-pta/api');
    assert.ok(api, '缺少 /dsh-pta/api 路由');
    assert.equal(api.kind, 'exact');
    assert.ok(sink.routes.some((route) => route.path === '/_pta/ping'));
  });

  await check('Skill 同步到 skills/pta-cli/SKILL.md', async () => {
    const target = join(skillDir, 'pta-cli', 'SKILL.md');
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const text = await readFile(target, 'utf8');
        assert.match(text, /^---\nname: pta-cli/mu);
        assert.match(text, /pta_submit_prog/u);
        return;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error('Skill 没有在 2s 内同步');
  });

  const route = sink.routes.find((item) => item.path === '/dsh-pta/api');

  await check('空账号时 pta_accounts 给出引导', async () => {
    const tool = sink.tools.find((item) => item.name === 'pta_accounts');
    const result = await tool.execute({});
    assert.match(result.text, /还没有绑定 PTA 账号/u);
    assert.deepEqual(result.accounts, []);
  });

  await check('API 拒绝非 POST', async () => {
    const res = makeRes();
    await route.handler(makeReq({ action: 'info' }, 'GET'), res);
    assert.equal(res.status, 405);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'invalid_input');
  });

  await check('API 拒绝未知 action', async () => {
    const res = makeRes();
    await route.handler(makeReq({ action: 'nope' }), res);
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error.code, 'invalid_input');
  });

  await check('假 Cookie 添加账号被拒且不落盘', async () => {
    const res = makeRes();
    await route.handler(makeReq({ action: 'accounts.add', label: '冒烟', cookie: 'dummy-not-a-real-cookie' }), res);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.ok(['auth_required', 'unavailable'].includes(body.error.code), body.error.code);
    const list = makeRes();
    await route.handler(makeReq({ action: 'accounts.list' }), list);
    assert.equal(JSON.parse(list.body).data.accounts.length, 0);
    assert.equal(credentials.records.size, 0);
  });

  await check('保险箱：add/list/session/remove（假探针）', async () => {
    const vault = createAccounts({ ctx: makeCtx(credentials, sink), stateDir });
    await vault.init();
    const account = await vault.add({
      label: '张三',
      cookie: 'PTASession=abc',
      probe: async () => ({ nickname: '张三同学', email: 'z@example.com', uid: '9001' }),
    });
    assert.equal(account.label, '张三');
    assert.equal(account.status, 'ready');
    assert.equal(vault.defaultId(), account.id);

    const listed = vault.list();
    assert.equal(listed.length, 1);
    assert.equal(JSON.stringify(listed).includes('abc'), false, '列表不得包含 Cookie');

    const session = await vault.session(account.id);
    assert.equal(session.cookie, 'abc', '入库应去掉 PTASession= 前缀，只留 token');
    assert.equal(credentials.records.has(`dsh-pta/account-${account.id}`), true);

    await vault.add({ label: '张三', cookie: 'PTASession=abc2', probe: async () => ({ nickname: '张三同学', email: '', uid: '9001' }) });
    assert.equal(vault.list().length, 1, '同一 uid 应更新而不是新增');

    await vault.remove(account.id);
    assert.equal(vault.list().length, 0);
    assert.equal(credentials.records.size, 0);
  });

  await check('未拉题时 pta_brief 报 not_pulled', async () => {
    const tool = sink.tools.find((item) => item.name === 'pta_brief');
    await assert.rejects(() => tool.execute({ psid: '123' }), /还没有拉题/u);
  });

  console.log(`\n${results.length} checks passed`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
