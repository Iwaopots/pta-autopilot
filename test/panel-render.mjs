/**
 * 面板灰箱测试：在 jsdom 里用真实 React 渲染 client.js 的 Panel，桩掉 /pta-autopilot/api，
 * 验证三栏都渲染、「一键完成」走 dispatch、队列/日志显示回写的进度。
 *
 * 需要 react@18、react-dom@18、jsdom（devDependencies，`npm install` 即装好；插件运行时不依赖它们）。
 * 也可设置 PTA_TEST_DEPS=<含 node_modules 的目录>。
 * 依赖缺失时**失败**（退出码 1）——静默跳过等于盲改 UI；本地临时跳过请设 PTA_ALLOW_SKIP=1。运行：node test/panel-render.mjs
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
  if (process.env.PTA_ALLOW_SKIP === '1') {
    console.log('skip - 未安装 react/react-dom/jsdom（PTA_ALLOW_SKIP=1，临时跳过）');
    process.exit(0);
  }
  console.error('FAIL - 未安装 react/react-dom/jsdom：在仓库根目录运行 npm install（devDependencies）后再跑。');
  process.exit(1);
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
  limits: { maxConcurrent: 2 }, events: [], paused: {}, launch: { available: true, mode: 'sessionController' },
};
let accountList = [{ id: 'acc-1', label: '本人', status: 'ready', nickname: '朱同学' }];
const responses = {
  info: () => ({ accounts: accountList, defaultAccount: 'acc-1', launch: board.launch }),
  'tasks.resume': () => { board = { ...board, paused: {} }; return { resumed: true }; },
  progress: () => ({ account: 'acc-1', sets: [
    { id: '111', name: 'Java 作业(5)', endAt: '2026-11-30T15:59:00Z', daysLeft: 14, total: 55, todo: 0, done: 55, exam: false },
    { id: '2121970182808698880', name: '算法4', endAt: '2026-11-18T15:59:00Z', daysLeft: 2, total: 4, todo: 1, done: 3, exam: false,
      cells: [{ type: 'PROGRAMMING', state: 'ok' }, { type: 'PROGRAMMING', state: 'ok' }, { type: 'PROGRAMMING', state: 'ok' }, { type: 'PROGRAMMING', state: 'todo' }] },
    { id: '444', name: '算法5', endAt: '2026-12-11T16:15:00+08:00', daysLeft: 26, total: -1, todo: 0, done: -1, exam: false, blocked: 'not_started', cells: [] },
    { id: '333', name: '期中考试', endAt: '2026-11-20T00:00:00Z', daysLeft: 4, total: 10, todo: 10, done: 0, exam: true },
  ] }),
  'tasks.board': () => board,
  dispatch: (body) => {
    board = {
      ...board,
      counts: { ...board.counts, running: 1 },
      tasks: [{ id: 't1', psid: body.psid, account: 'acc-1', accountLabel: '本人', setName: body.setName, status: 'running', attempts: 1, maxAttempts: 3,
        progress: { done: 0, total: 1, note: '会话已启动' }, sessionId: 's-1', error: '' }],
      events: [{ at: new Date().toISOString(), kind: 'start', task: 't1', message: '开始第 1/3 次（sessionController）' }],
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

const mount = async () => {
  const root = createRoot(document.getElementById('root'));
  await act(async () => { root.render(React.createElement(Panel, { openSession: (id) => calls.push(`open:${id}`) })); });
  await settle();
  return root;
};
const text = () => document.body.textContent;
const button = (label) => [...document.querySelectorAll('button')].find((item) => item.textContent === label);
const click = async (el, ms = 60) => { await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }); await settle(ms); };

let root = await mount();

await check('单账号布局：账号收成横条，两栏网格，KPI 去掉账号计数', () => {
  for (const word of ['题目集完成度', '任务队列', '操作日志', '本人', '朱同学', '算法4', '一键直达模型']) assert.ok(text().includes(word), `缺少「${word}」`);
  assert.ok(document.querySelector('.ptap-accbar'), '单账号应显示账号横条');
  assert.ok(document.querySelector('.ptap-grid.single'), '单账号应是两栏');
  assert.equal(document.querySelectorAll('.ptap-kpi').length, 4);
  assert.ok(!text().includes('账号已登录'));
  assert.ok(text().includes('今日完成任务'));
});

await check('完成度：已完成显示绿色，考试类打标，临期标红，无权限题集不给按钮', () => {
  assert.ok(text().includes('已完成'));
  assert.ok(text().includes('考试'));
  assert.ok(document.querySelector('.ptap-meta .bad'), '2 天内截止应标红');
  assert.ok(text().includes('3/4'));
  assert.ok(text().includes('未开放'));
  assert.ok(text().includes('暂时不能派发'));
  assert.equal([...document.querySelectorAll('button')].filter((item) => item.textContent === '一键完成').length, 2, '只有算法4和考试有按钮，无权限的没有');
});

await check('点题集名展开每题状态格；「未完成」筛选', async () => {
  const name = [...document.querySelectorAll('.ptap-link')].find((item) => item.textContent === '算法4');
  await click(name);
  assert.equal(document.querySelectorAll('.ptap-cell').length, 4);
  assert.equal(document.querySelectorAll('.ptap-cell.ok').length, 3);
  await click(button('未完成 2'));
  assert.ok(!text().includes('Java 作业(5)'), '筛选后不显示已完成题集');
  await click(button('全部'));
  assert.ok(text().includes('Java 作业(5)'));
});

await check('点「一键完成」→ dispatch → 队列出现执行中任务，可看详情时间线、打开会话', async () => {
  const first = [...document.querySelectorAll('button')].find((item) => item.textContent === '一键完成');
  await click(first, 120);
  assert.ok(calls.includes('dispatch'));
  assert.ok(text().includes('执行中'), '队列应显示执行中');
  assert.ok(text().includes('会话已启动'));
  await click(button('详情'));
  assert.ok(document.querySelector('.ptap-timeline'), '详情应展开该任务的时间线');
  await click(button('打开会话'));
  assert.ok(calls.includes('open:s-1'));
});

await check('队列四个分页；失败带原因标签；已取消单独计数', async () => {
  board = {
    ...board,
    counts: { pending: 0, running: 0, done: 0, failed: 1, cancelled: 4 },
    tasks: [{ id: 't9', psid: '9', account: 'acc-1', setName: '算法3', status: 'failed', reason: 'auth_required', attempts: 1, maxAttempts: 3, progress: { done: 0, total: 0, note: '' }, error: 'PTA 登录已失效' }],
    events: [{ at: new Date().toISOString(), kind: 'failed', task: 't9', message: '登录失效，不重试' }, { at: new Date().toISOString(), kind: 'enqueue', task: 't9', message: '入队' }],
  };
  await click(button('全部刷新'), 120);
  assert.ok(button('失败 1') && button('已取消 4'), '失败与已取消应分开计数');
  await click(button('失败 1'));
  assert.ok(text().includes('登录失效'));
});

await check('日志：异常筛选只留失败/重试类', async () => {
  await click(button('异常'));
  const rows = document.querySelectorAll('.ptap-logrow');
  assert.equal(rows.length, 1);
  assert.ok(rows[0].querySelector('b.bad'));
});

await check('登录失效暂停：显示提示条，可直接继续队列', async () => {
  board = { ...board, paused: { 'acc-1': { reason: 'auth_required', at: new Date().toISOString(), message: 'x' } } };
  await click(button('全部刷新'), 120);
  assert.ok(text().includes('任务已暂停'));
  await click(button('直接继续'), 120);
  assert.ok(calls.includes('tasks.resume'));
});

await act(async () => { root.unmount(); });

await check('多账号时恢复三栏，账号栏完整显示', async () => {
  accountList = [
    { id: 'acc-1', label: '本人', status: 'ready', nickname: '朱同学' },
    { id: 'acc-2', label: '备用', status: 'auth_required', nickname: '' },
  ];
  root = await mount();
  assert.ok(document.querySelector('.ptap-grid:not(.single)'));
  assert.ok(!document.querySelector('.ptap-accbar'));
  assert.equal(document.querySelectorAll('.ptap-kpi').length, 5);
  assert.ok(text().includes('需重登'));
});

await act(async () => { root.unmount(); });
console.log(`\n${passed} checks passed`);
process.exit(0);
