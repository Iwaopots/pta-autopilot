/**
 * 面板灰箱测试：在 jsdom 里用真实 React 渲染 client.js 的 Panel，桩掉 /dsh-pta/api，
 * 验证三栏都渲染、「一键完成」走 dispatch、队列/日志显示回写的进度。
 *
 * 需要 react@18、react-dom@18、jsdom（不进 package.json 依赖，避免影响插件安装）：
 *   npm i --no-save react@18 react-dom@18 jsdom@24   或设置 PTA_TEST_DEPS=<含 node_modules 的目录>
 * 依赖缺失时跳过（退出码 0）。运行：node test/panel-render.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const bases = [process.env.PTA_TEST_DEPS, process.cwd(), join(process.cwd(), '..')].filter(Boolean);
let req;
for (const base of bases) {
  try {
    const candidate = createRequire(join(base, 'noop.js'));
    candidate.resolve('react'); candidate.resolve('react-dom/client'); candidate.resolve('jsdom');
    req = candidate;
    break;
  } catch { /* 下一个 */ }
}
if (!req) {
  console.log('skip - 未安装 react/react-dom/jsdom，跳过面板渲染测试');
  process.exit(0);
}

const { JSDOM } = req('jsdom');
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.confirm = () => true;

const React = req('react');
const { createRoot } = req('react-dom/client');
const { act } = React;

const calls = [];
let board = {
  tasks: [], counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
  limits: { maxConcurrent: 2 }, events: [], launch: { available: true, mode: 'sessionController' },
};
const responses = {
  info: () => ({ accounts: [{ id: 'acc-1', label: '本人', status: 'ready', nickname: '朱同学' }], defaultAccount: 'acc-1', launch: board.launch }),
  progress: () => ({ account: 'acc-1', sets: [
    { id: '111', name: 'Java 作业(5)', endAt: '2026-11-30T15:59:00Z', daysLeft: 14, total: 55, todo: 0, done: 55, exam: false },
    { id: '2121970182808698880', name: '算法4', endAt: '2026-11-18T15:59:00Z', daysLeft: 2, total: 4, todo: 1, done: 3, exam: false },
    { id: '333', name: '期中考试', endAt: '2026-11-20T00:00:00Z', daysLeft: 4, total: 10, todo: 10, done: 0, exam: true },
  ] }),
  'tasks.board': () => board,
  dispatch: (body) => {
    board = {
      ...board,
      counts: { ...board.counts, running: 1 },
      tasks: [{ id: 't1', psid: body.psid, account: 'acc-1', accountLabel: '本人', setName: body.setName, status: 'running', attempts: 1, maxAttempts: 3,
        progress: { done: 0, total: 1, note: '会话已启动' }, sessionId: 's-1', error: '' }],
      events: [{ at: new Date().toISOString(), kind: 'start', message: '开始第 1/3 次（sessionController）' }],
    };
    return { task: board.tasks[0], created: true, pending: 0, running: 1, launch: board.launch };
  },
};
globalThis.fetch = window.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  calls.push(body.action);
  const handler = responses[body.action];
  if (!handler) return { ok: false, status: 400, json: async () => ({ ok: false, error: { code: 'invalid_input', message: body.action } }) };
  return { ok: true, status: 200, json: async () => ({ ok: true, apiVersion: 1, data: handler(body) }) };
};

let captured;
window.__ModuleLoader__ = { load: (module) => { captured = module; } };
await import('../client.js');
const exports = captured.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require ${name}`);
});
const slots = [];
exports.apply({
  effect: (fn) => fn(),
  get: () => undefined,
  slots: { inject: (_n, cb) => cb(), register: (options, component) => { slots.push({ options, component }); return () => {}; } },
});
const Panel = slots.find((slot) => slot.options.name === 'main').component;

const settle = async (ms = 60) => {
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms / 5)); });
  }
};

let passed = 0;
const check = async (name, fn) => { await fn(); passed += 1; console.log(`ok - ${name}`); };

const root = createRoot(document.getElementById('root'));
await act(async () => { root.render(React.createElement(Panel, { openSession: (id) => calls.push(`open:${id}`) })); });
await settle();
const text = () => document.body.textContent;

await check('三栏渲染：账号 / 题目集完成度 / 任务队列 + 操作日志', () => {
  for (const word of ['账号', '题目集完成度', '任务队列', '操作日志', '本人', '算法4', '一键直达模型']) assert.ok(text().includes(word), `缺少「${word}」`);
  assert.ok(document.querySelector('.ptap-grid'), '缺少三栏网格');
  assert.equal(document.querySelectorAll('.ptap-kpi').length, 5);
});

await check('完成度：已完成显示绿色，考试类打标，临期标红', () => {
  assert.ok(text().includes('已完成'));
  assert.ok(text().includes('考试'));
  assert.ok(document.querySelector('.ptap-meta .bad'), '2 天内截止应标红');
  assert.ok(text().includes('3/4'));
});

await check('点「一键完成」→ dispatch → 队列出现执行中任务并可打开会话', async () => {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent === '一键完成');
  assert.ok(button);
  await act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await settle(120);
  assert.ok(calls.includes('dispatch'));
  assert.ok(text().includes('执行中'), '队列应显示执行中');
  assert.ok(text().includes('会话已启动'));
  const open = [...document.querySelectorAll('button')].find((item) => item.textContent === '打开会话');
  assert.ok(open, '有 sessionId 时应能打开会话');
  await act(async () => { open.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  assert.ok(calls.includes('open:s-1'));
});

await act(async () => { root.unmount(); });
console.log(`\n${passed} checks passed`);
process.exit(0);
