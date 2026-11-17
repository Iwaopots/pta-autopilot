/**
 * 会话启动器：把面板「一键完成」直接变成一个 DSH 会话里的用户消息，模型立刻开工。
 *
 * 这是 index.js 之外唯一碰 DSH 运行时的模块，全部走能力探测：
 *   1) ctx.get('sessionController')  —— create({sessionId, cwd}) + resolveAgent(id)，会话出现在 UI 会话列表里（首选）；
 *   2) ctx.get('agents')             —— agents.create({sessionId, meta:{cwd}})，后台会话（兜底）；
 *   3) 都没有                         —— available=false，面板退回「排队 + 复制指令」，插件其余功能不受影响。
 *
 * 写法对照 blueforst/dsh-toolkit-educoder plugins/educoder/agent.js（SessionController.create → resolveAgent →
 * agent.followup(createUserMessage(...)) → whenIdle → sessions.flush）。
 * 运行时包（@deepseek-ai/dsh-session、@deepseek-ai/dsh-llm）从 DSH 宿主解析，本包不声明依赖。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

function hostAnchors() {
  return [
    process.env.DSH_ENTRYPOINT,
    process.argv[1],
    fileURLToPath(import.meta.url),
  ].filter((item) => typeof item === 'string' && item !== '');
}

/** 默认运行时加载器：从 DSH 宿主解析 SessionId / createUserMessage。 */
export async function loadDshRuntime() {
  let lastError;
  for (const anchor of hostAnchors()) {
    try {
      const base = await realpath(anchor).catch(() => anchor);
      const host = createRequire(base);
      const load = (name) => import(pathToFileURL(host.resolve(name)).href);
      const [session, llm] = await Promise.all([load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-llm')]);
      if (typeof llm.createUserMessage !== 'function') throw new Error('dsh-llm 缺少 createUserMessage');
      return {
        sessionId: typeof session.SessionId === 'function' ? session.SessionId : (value) => value,
        userMessage: llm.createUserMessage,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw Object.assign(new Error(`无法从 DSH 宿主加载会话运行时：${lastError?.message ?? lastError}`), { code: 'launch_unavailable' });
}

function controllerOf(ctx) {
  const raw = ctx.get?.('sessionController', false);
  return raw && typeof raw.create === 'function' && typeof raw.resolveAgent === 'function' ? raw : undefined;
}

function agentsOf(ctx) {
  const raw = ctx.get?.('agents', false);
  return raw && typeof raw.create === 'function' ? raw : undefined;
}

async function resolveAgent(controller, sessionId) {
  const result = await controller.resolveAgent(sessionId);
  if (result && typeof result === 'object' && 'error' in result && result.error) throw result.error;
  return result?.agent ?? result;
}

export function createLauncher(ctx, { cwd, log, runtimeLoader = loadDshRuntime } = {}) {
  let runtime;
  const running = new Map(); // taskId -> { agent, sessionId }

  function capability() {
    if (controllerOf(ctx)) return { available: true, mode: 'sessionController' };
    if (agentsOf(ctx)) return { available: true, mode: 'agents' };
    return { available: false, mode: 'none', reason: '当前 DSH 未暴露 sessionController / agents 服务，退回「排队 + 在对话里说一句」。' };
  }

  /**
   * 新开一个会话并投递 prompt；返回 { sessionId, done }，done 在模型这一轮结束后 resolve 为 { outcome }。
   * 调用方（service）只关心 sessionId 和最终结果，不接触 agent 对象。
   */
  async function start({ taskId, title, prompt }) {
    const cap = capability();
    if (!cap.available) throw Object.assign(new Error(cap.reason), { code: 'launch_unavailable' });
    const sdk = await (runtime ??= runtimeLoader().catch((error) => {
      runtime = undefined;
      throw error;
    }));
    if (cwd) await mkdir(cwd, { recursive: true });
    let sessionId = sdk.sessionId(randomUUID());
    let agent;
    let handle;
    if (cap.mode === 'sessionController') {
      const controller = controllerOf(ctx);
      const created = await controller.create({ sessionId, ...(cwd ? { cwd } : {}) });
      sessionId = sdk.sessionId(created?.sessionId ?? sessionId);
      agent = await resolveAgent(controller, sessionId);
    } else {
      const agents = agentsOf(ctx);
      const create = () => agents.create({ sessionId, ...(cwd ? { meta: { cwd } } : {}) });
      handle = typeof agents.withoutInitiator === 'function' ? await agents.withoutInitiator(create) : await create();
      agent = handle?.agent ?? handle;
    }
    if (!agent || typeof agent.followup !== 'function') {
      throw Object.assign(new Error('DSH 返回的会话不支持 followup。'), { code: 'launch_unavailable' });
    }
    if (typeof agent.whenIdle === 'function') await agent.whenIdle();
    try {
      agent.session?.append?.('session/title', { title: String(title ?? 'PTA 作业').slice(0, 120), messageSeqs: [], source: { kind: 'user' } });
    } catch {
      /* 标题失败不影响执行 */
    }
    const id = String(sessionId);
    running.set(taskId, { agent, sessionId: id });

    let turnReason;
    let unsubscribe;
    try {
      unsubscribe = ctx.on?.('session/event', (session, event) => {
        if (session === agent.session && event?.type === 'turn/end') turnReason = event.data?.reason?.kind;
      });
    } catch {
      unsubscribe = undefined;
    }

    agent.followup(sdk.userMessage({ content: [{ type: 'text', text: String(prompt) }], source: { kind: 'pta-autopilot' } }));

    const done = (async () => {
      try {
        if (typeof agent.whenIdle === 'function') await agent.whenIdle();
        return { outcome: turnReason && turnReason !== 'completed' ? 'failed' : 'finished', reason: turnReason ?? 'completed' };
      } catch (error) {
        return { outcome: 'failed', reason: String(error?.message ?? error).slice(0, 200) };
      } finally {
        running.delete(taskId);
        try { unsubscribe?.(); } catch { /* ignore */ }
        try {
          const sessions = ctx.get?.('sessions', false);
          if (agent.session && typeof sessions?.flush === 'function') await sessions.flush(agent.session);
        } catch (error) {
          log?.warn?.(`[pta-autopilot] 会话落盘失败：${error?.message ?? error}`);
        }
        try { await handle?.dispose?.(); } catch { /* ignore */ }
      }
    })();
    return { sessionId: id, mode: cap.mode, done };
  }

  function cancel(taskId) {
    const entry = running.get(taskId);
    if (!entry) return false;
    try {
      entry.agent.cancel?.({ kind: 'hook', reason: 'pta-autopilot: cancelled from panel' });
    } catch {
      /* ignore */
    }
    return true;
  }

  return { capability, start, cancel, running: () => running.size };
}
