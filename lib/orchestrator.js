/**
 * 任务编排层：面板派发 → 入队 → 调度泵 → 开会话 → 收尾/重试，以及面板队列视图与 Agent 的领取/回写。
 * 从 service.js 拆出；只依赖 accounts / scheduler / launcher 三个对象，不直接碰 PTA HTTP。
 */
import { AccountError } from './accounts.js';
import { redact } from './pta.js';

/** 一键完成投递给模型的指令。只含 id/PSID/账号 id，不含任何凭据。 */
export function buildTaskPrompt(task, accountLabel = '') {
  return [
    `执行 PTA 任务 ${task.id}：题目集 ${task.psid}${task.setName ? `（${task.setName}）` : ''}，账号 ${task.account}${accountLabel ? `（${accountLabel}）` : ''}。`,
    '用户已在「PTA 作业」面板点击「一键完成」，视为对本题目集「直接交 / 全自动」的授权，无需逐题确认；但题集若是限时考试或监考类，立刻停下，用 pta_finish status=failed 说明原因。',
    '按 pta-cli Skill 的流程：pta_pull → pta_status（todo 为空直接收尾）→ pta_brief 分题型读题 → 作答提交（客观题一次交全；编程题样例自测后 pta_submit_prog，同题最多 4 次）。',
    `每做完一个题型或一道编程题，调用 pta_progress id=${task.id} done=<已完成题数> total=<todo 总数> note=<一句话>，面板靠它显示进度。`,
    `全部结束后再跑一次 pta_status 复核，然后 pta_finish id=${task.id} status=done；卡住或做不完则 status=failed，error 写明原因，reason 填 auth_required / rate_limited / not_started / compile_error / wrong_answer / other 之一。所有工具调用都带 account: "${task.account}"。`,
    ...(task.attempts > 1 ? [
      `这是第 ${task.attempts}/${task.maxAttempts} 次尝试${task.lastError ? `，上次失败原因：${task.lastError}` : ''}。`,
      '上次可能已经交过一部分：务必先 pta_status，只做 todo 里的题；已 AC 的题不要重交。',
    ] : []),
  ].join('\n');
}

export function createOrchestrator({ init, accounts, scheduler, launcher, warn, isClosed, progress }) {
  let pumping = false;
  const api = {
    /**
     * 面板「一键完成 / 交给 Agent」：入队，并在宿主支持时立即开会话执行。
     * 限时考试类题集默认拒绝（红线），allowExam=true 才放行。
     */
    async dispatch({ psid, account, priority = 0, allowExam = false, autoStart = true, setName = '', endAt = '', exam = false } = {}) {
      await init();
      const target = accounts.resolve(account);
      if (!/^\d{1,20}$/u.test(String(psid ?? ''))) throw new AccountError('invalid_input', 'psid 应为数字题目集 ID。');
      if (exam && !allowExam) throw new AccountError('exam_guard', '这是限时考试/监考类题目集，默认不自动做。确认要做请在面板勾选后再派发。');
      const { task, created } = await scheduler.enqueue({ psid: String(psid), account: target, setName, endAt, priority });
      const launch = launcher?.capability?.() ?? { available: false, mode: 'none' };
      if (autoStart && launch.available) void api.pump();
      const { counts } = await scheduler.list();
      return { task, created, pending: counts.pending, running: counts.running, launch };
    },

    /** 某账号下全部未完成题目集一次性派发（跳过考试类与已完成）。 */
    async dispatchAll({ account } = {}) {
      await init();
      const target = accounts.resolve(account);
      const { sets: rows } = await progress({ account: target });
      const queued = [];
      const skipped = [];
      for (const row of rows) {
        if (row.total >= 0 && row.todo === 0) continue;
        if (row.total < 0) { skipped.push({ id: row.id, reason: 'not_started' }); continue; }
        if (row.exam) { skipped.push({ id: row.id, reason: 'exam' }); continue; }
        const { task, created } = await scheduler.enqueue({ psid: String(row.id), account: target, setName: row.name, endAt: row.endAt });
        if (created) queued.push(task.id);
      }
      const launch = launcher?.capability?.() ?? { available: false, mode: 'none' };
      if (queued.length && launch.available) void api.pump();
      return { account: target, queued, skipped, launch };
    },

    /** 调度泵：在并发上限内不断领取任务并开会话。可重入安全。 */
    async pump() {
      if (pumping || isClosed() || !launcher?.capability?.().available) return { started: 0 };
      pumping = true;
      let started = 0;
      try {
        await init();
        await scheduler.recover();
        for (let guardCount = 0; guardCount < 16; guardCount += 1) {
          const { task } = await scheduler.claim({ launch: launcher.capability().mode });
          if (!task) break;
          started += 1;
          void api.launch(task);
        }
      } catch (error) {
        warn(`调度失败：${error?.message ?? error}`);
      } finally {
        pumping = false;
      }
      return { started };
    },

    /** 为一个已 running 的任务开会话；会话结束而任务没收尾 → 按失败处理（进入重试）。 */
    async launch(task) {
      try {
        const label = accounts.row(task.account)?.label ?? '';
        const { sessionId, done } = await launcher.start({
          taskId: task.id,
          title: `PTA · ${task.setName || task.psid}`,
          prompt: buildTaskPrompt(task, label),
        });
        await scheduler.progress({ id: task.id, sessionId, note: '会话已启动' }).catch(() => {});
        const result = await done;
        const current = await scheduler.get(task.id).catch(() => null);
        if (current?.status === 'running') {
          await scheduler.finish({
            id: task.id,
            status: 'failed',
            reason: result.outcome === 'finished' ? 'no_finish' : 'session_error',
            error: result.outcome === 'finished' ? '会话结束但未调用 pta_finish 收尾' : `会话异常结束：${result.reason}`,
          });
        }
      } catch (error) {
        const current = await scheduler.get(task.id).catch(() => null);
        if (current?.status === 'running') {
          await scheduler.finish({ id: task.id, status: 'failed', reason: 'launch_failed', error: `启动会话失败：${redact(error?.message ?? error)}` }).catch(() => {});
        }
        warn(`启动会话失败：${error?.message ?? error}`);
      } finally {
        if (!isClosed()) void api.pump();
      }
    },

    /** 面板队列视图。 */
    async taskBoard() {
      await init();
      const { tasks, counts, limits, readOnly, paused } = await scheduler.list();
      const events = await scheduler.events({ limit: 60 });
      const labels = Object.fromEntries(accounts.list().map((row) => [row.id, row.label]));
      return {
        tasks: tasks.map((task) => ({ ...task, accountLabel: labels[task.account] ?? '' })),
        counts,
        limits,
        readOnly,
        paused,
        events,
        launch: launcher?.capability?.() ?? { available: false, mode: 'none' },
      };
    },

    async cancelTask({ id }) {
      await init();
      const result = await scheduler.cancel({ id });
      launcher?.cancel?.(String(id));
      return result;
    },

    async retryTask({ id }) {
      await init();
      const result = await scheduler.retry({ id });
      void api.pump();
      return result;
    },

    async bumpTask({ id }) {
      await init();
      const result = await scheduler.bump({ id });
      void api.pump();
      return result;
    },

    async startTask({ id }) {
      await init();
      if (!launcher?.capability?.().available) throw new AccountError('launch_unavailable', '当前 DSH 不支持插件直接开会话，请在对话里说「执行 PTA 任务」。');
      const { task, reason } = await scheduler.claim({ id, launch: launcher.capability().mode });
      if (!task) throw new AccountError('busy', reason === 'concurrency' ? '并发已满，任务会自动排队执行。' : '该任务现在不能启动（账号正忙、退避中或不是待做状态）。');
      void api.launch(task);
      return { task };
    },

    async resumeQueue({ account } = {}) {
      await init();
      const target = accounts.resolve(account);
      const result = await scheduler.resume({ account: target });
      void api.pump();
      return result;
    },

    async clearTasks({ status } = {}) {
      await init();
      return scheduler.clearFinished({ status });
    },

    /** Agent 领任务：claim=true 时领取一个（遵守账号锁与并发上限）；否则只列 pending/running。 */
    async tasks({ claim = false, id, account } = {}) {
      await init();
      await scheduler.recover();
      if (claim) {
        const { task, reason } = await scheduler.claim({ id, account, launch: 'chat' });
        return { tasks: task ? [task] : [], reason: task ? undefined : reason };
      }
      const { tasks: rows } = await scheduler.list();
      return { tasks: rows.filter((task) => task.status === 'pending' || task.status === 'running') };
    },

    /** Agent 回写进度（同时是心跳）。 */
    async taskProgress({ id, done, total, note }) {
      await init();
      return scheduler.progress({ id, done, total, note });
    },

    /** 任务收尾。failed 且未用尽次数会自动退避重试。 */
    async finishTask({ id, status = 'done', error = '', reason } = {}) {
      await init();
      const result = await scheduler.finish({ id, status, error, reason });
      void api.pump();
      return result;
    },

  };
  return api;
}
