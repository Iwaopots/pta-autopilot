/**
 * 调度器 + 会话启动器 离线测试（不碰 DSH、不碰 PTA）。
 * 覆盖：v1 迁移、幂等入队、账号锁、全局并发、临期优先、插队、失败退避重试、用尽失败、崩溃恢复、
 *       高版本状态拒写、一键完成端到端（假 sessionController → followup → 回写 → done）。
 * 运行：node test/scheduler.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backoffMs, createScheduler } from '../lib/scheduler.js';
import { createLauncher } from '../lib/launcher.js';
import { buildTaskPrompt, createService, normalizeSource } from '../lib/service.js';

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
};

const root = await mkdtemp(join(tmpdir(), 'dsh-pta-sched-'));
let n = 0;
const fresh = async () => join(root, `s${n += 1}`);
const DAY = 86_400_000;

try {
  await check('v1 裸数组自动迁移到 v2', async () => {
    const dir = await fresh();
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'tasks.json'), JSON.stringify([{ id: 't1', psid: '1', account: 'a', status: 'pending', createdAt: '2026-11-01T00:00:00Z' }]));
    const s = createScheduler({ stateDir: dir });
    const { tasks } = await s.list();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, 'cancelled', '旧版遗留任务不应自动开跑');
    await s.retry({ id: 't1' });
    assert.equal((await s.get('t1')).status, 'pending');
    await s.enqueue({ psid: '2', account: 'a' });
    const saved = JSON.parse(await readFile(join(dir, 'tasks.json'), 'utf8'));
    assert.equal(saved.version, 2);
    assert.equal(saved.tasks.length, 2);
  });

  await check('同账号同题集重复入队是幂等的', async () => {
    const s = createScheduler({ stateDir: await fresh() });
    const a = await s.enqueue({ psid: '10', account: 'a' });
    const b = await s.enqueue({ psid: '10', account: 'a' });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.task.id, b.task.id);
  });

  await check('账号锁：同账号同时只跑一个；不同账号并行', async () => {
    const s = createScheduler({ stateDir: await fresh(), maxConcurrent: 3 });
    await s.enqueue({ psid: '1', account: 'a' });
    await s.enqueue({ psid: '2', account: 'a' });
    await s.enqueue({ psid: '3', account: 'b' });
    const first = await s.claim();
    const second = await s.claim();
    const third = await s.claim();
    assert.ok(first.task && second.task);
    assert.notEqual(first.task.account, second.task.account, '两个 running 必须属于不同账号');
    assert.equal(third.task, null, '账号 a 正忙，剩下的 a 任务不能领');
  });

  await check('全局并发上限', async () => {
    const s = createScheduler({ stateDir: await fresh(), maxConcurrent: 2 });
    for (const account of ['a', 'b', 'c']) await s.enqueue({ psid: '1', account });
    assert.ok((await s.claim()).task);
    assert.ok((await s.claim()).task);
    const blocked = await s.claim();
    assert.equal(blocked.task, null);
    assert.equal(blocked.reason, 'concurrency');
  });

  await check('临期优先，其次插队优先级', async () => {
    let clock = Date.parse('2026-11-16T00:00:00Z');
    const s = createScheduler({ stateDir: await fresh(), maxConcurrent: 1, now: () => clock });
    await s.enqueue({ psid: '1', account: 'a', endAt: new Date(clock + 10 * DAY).toISOString() });
    await s.enqueue({ psid: '2', account: 'b', endAt: new Date(clock + 1 * DAY).toISOString() });
    const { task } = await s.claim();
    assert.equal(task.psid, '2', '1 天后截止的应先做');
    await s.finish({ id: task.id });
    const c = await s.enqueue({ psid: '3', account: 'c', endAt: new Date(clock + 20 * DAY).toISOString() });
    await s.bump({ id: c.task.id });
    assert.equal((await s.claim()).task.psid, '3', '插队后优先');
    clock += 1;
  });

  await check('失败指数退避重试，用尽后 failed', async () => {
    let clock = Date.parse('2026-11-16T00:00:00Z');
    const s = createScheduler({ stateDir: await fresh(), maxAttempts: 3, backoffBaseMs: 1000, now: () => clock });
    const { task } = await s.enqueue({ psid: '1', account: 'a' });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await s.claim();
      assert.ok(claimed.task, `第 ${attempt} 次应能领取`);
      const { task: after } = await s.finish({ id: task.id, status: 'failed', error: 'boom' });
      if (attempt < 3) {
        assert.equal(after.status, 'pending');
        assert.equal(Date.parse(after.nextRunAt) - clock, backoffMs(attempt, 1000));
        assert.equal((await s.claim()).task, null, '退避期内不能领');
        clock += backoffMs(attempt, 1000);
      } else {
        assert.equal(after.status, 'failed');
      }
    }
    const { task: retried } = await s.retry({ id: task.id });
    assert.equal(retried.status, 'pending');
    assert.equal(retried.attempts, 0);
  });

  await check('崩溃恢复：心跳超时的 running 回到队列', async () => {
    let clock = Date.parse('2026-11-16T00:00:00Z');
    const s = createScheduler({ stateDir: await fresh(), staleMs: 60_000, now: () => clock });
    const { task } = await s.enqueue({ psid: '1', account: 'a' });
    await s.claim();
    await s.progress({ id: task.id, done: 1, total: 5, note: '单选已交' });
    clock += 30_000;
    assert.equal((await s.recover()).recovered, 0);
    clock += 61_000;
    assert.equal((await s.recover()).recovered, 1);
    assert.equal((await s.get(task.id)).status, 'pending');
  });

  await check('高版本状态文件只读、拒绝覆盖', async () => {
    const dir = await fresh();
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'tasks.json'), JSON.stringify({ version: 99, tasks: [] }));
    const s = createScheduler({ stateDir: dir });
    await assert.rejects(() => s.enqueue({ psid: '1', account: 'a' }), (error) => error.code === 'state_version');
    assert.equal(JSON.parse(await readFile(join(dir, 'tasks.json'), 'utf8')).version, 99);
  });

  await check('源码规范化：去 BOM、CRLF→LF', () => {
    assert.equal(normalizeSource('\uFEFFint main(){\r\n}\r'), 'int main(){\n}\n');
  });

  await check('一键完成指令不含凭据、带任务 id 与回写要求', () => {
    const text = buildTaskPrompt({ id: 'tX', psid: '123', account: 'acc-1', setName: '算法4' }, '本人');
    assert.match(text, /pta_progress id=tX/u);
    assert.match(text, /pta_finish id=tX/u);
    assert.doesNotMatch(text, /PTASession|cookie/iu);
  });

  await check('launcher：无 sessionController/agents 时不可用', () => {
    const launcher = createLauncher({ get: () => undefined });
    assert.equal(launcher.capability().available, false);
  });

  await check('端到端：派发 → 自动开会话 → followup → 模型回写 → done', async () => {
    const dir = await fresh();
    const followups = [];
    let service;
    // 假 DSH：sessionController 建会话；agent.followup 后模拟模型调用 pta_progress / pta_finish
    const agent = {
      session: { append() {} },
      idle: Promise.resolve(),
      whenIdle() { return this.idle; },
      followup(message) {
        followups.push(message);
        const id = /任务 (\S+)：/u.exec(message.content[0].text)[1];
        this.idle = (async () => {
          await service.taskProgress({ id, done: 2, total: 4, note: '单选已交' });
          await service.finishTask({ id, status: 'done' });
        })();
      },
    };
    const ctx = {
      get(name) {
        if (name === 'credentials') return { readRecord: async () => undefined, modifyRecord: async () => undefined, deleteRecord: async () => {} };
        if (name === 'sessionController') return { create: async ({ sessionId }) => ({ sessionId }), resolveAgent: async () => ({ agent }) };
        return undefined;
      },
    };
    const launcher = createLauncher(ctx, {
      cwd: join(dir, 'work'),
      runtimeLoader: async () => ({ sessionId: (value) => value, userMessage: (message) => message }),
    });
    service = createService({ ctx, stateDir: dir, launcher });
    // 绕过真实账号：直接写一条账号元数据
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'accounts.json'), JSON.stringify({ version: 1, default: 'acc-1', accounts: { 'acc-1': { id: 'acc-1', label: '本人', status: 'ready', uid: '1', updatedAt: '2026-11-16' } } }));
    const result = await service.dispatch({ psid: '2121970182808698880', setName: '算法4' });
    assert.equal(result.launch.available, true);
    for (let i = 0; i < 100; i += 1) {
      const board = await service.taskBoard();
      if (board.counts.done === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const board = await service.taskBoard();
    assert.equal(board.counts.done, 1, JSON.stringify(board.counts));
    assert.equal(followups.length, 1, '模型应收到且只收到一条指令');
    assert.equal(followups[0].source.kind, 'dsh-pta');
    const [task] = board.tasks;
    assert.equal(task.progress.done, 4, 'done 时进度补满');
    assert.ok(task.sessionId, '应记录会话 id');
    assert.ok(board.events.some((event) => event.kind === 'done'));
    service.close();
  });

  await check('端到端：会话结束却没收尾 → 判失败并退避重试', async () => {
    const dir = await fresh();
    const agent = { session: {}, whenIdle: async () => {}, followup() {} };
    const ctx = {
      get(name) {
        if (name === 'credentials') return { readRecord: async () => undefined, modifyRecord: async () => undefined, deleteRecord: async () => {} };
        if (name === 'agents') return { create: async () => ({ agent, dispose: async () => {} }) };
        return undefined;
      },
    };
    const launcher = createLauncher(ctx, { runtimeLoader: async () => ({ sessionId: (v) => v, userMessage: (m) => m }) });
    const service = createService({ ctx, stateDir: dir, launcher });
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'accounts.json'), JSON.stringify({ version: 1, default: 'a', accounts: { a: { id: 'a', label: 'A', status: 'ready', uid: '1', updatedAt: 'x' } } }));
    await service.dispatch({ psid: '7' });
    let task;
    for (let i = 0; i < 100; i += 1) {
      [task] = (await service.taskBoard()).tasks;
      if (task.error) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(task.status, 'pending');
    assert.match(task.error, /未调用 pta_finish/u);
    assert.ok(task.nextRunAt, '应进入退避');
    service.close();
  });

  await check('考试类题集默认拒绝派发', async () => {
    const dir = await fresh();
    const ctx = { get: (name) => (name === 'credentials' ? { readRecord: async () => undefined, modifyRecord: async () => undefined, deleteRecord: async () => {} } : undefined) };
    const service = createService({ ctx, stateDir: dir });
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'accounts.json'), JSON.stringify({ version: 1, default: 'a', accounts: { a: { id: 'a', label: 'A', status: 'ready', uid: '1', updatedAt: 'x' } } }));
    await assert.rejects(() => service.dispatch({ psid: '9', exam: true }), (error) => error.code === 'exam_guard');
    const ok = await service.dispatch({ psid: '9', exam: true, allowExam: true });
    assert.equal(ok.created, true);
    assert.equal(ok.launch.available, false);
    service.close();
  });

  console.log(`\n${passed} checks passed`);
} finally {
  await rm(root, { recursive: true, force: true });
}
