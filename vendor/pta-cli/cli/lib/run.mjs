// 全链路编排：run --account <id> --problem-set <id>
// 会话复用检查 → 拉题集 → 拉题 → 逐题（只做未通过的）：DS 解题 → 本地自测 →
// 拟人节律 → 提交 → 判题回读 → 记录。单线程顺序跑，一题一题来。
// 红线：正式考试直接拒绝并记日志，绝不碰；编程题自测不过不交。
import { join } from 'node:path';
import { extractJudgeResults } from './pta-client.mjs';
import { DSClient, deepSeekConfig, extractSamples, runSamples, solveObjective, solveProgramming, formatJudgeFeedback } from './solve.mjs';
import { Pacer, sleep } from './pace.mjs';
import { varyCodeSafe } from './vary.mjs';
import * as store from './store.mjs';

export const OBJECTIVE_TYPES = new Set([
  'TRUE_OR_FALSE',
  'MULTIPLE_CHOICE',
  'MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER',
  'FILL_IN_THE_BLANK',
  'FILL_IN_THE_BLANK_FOR_PROGRAMMING',
  'CHOICE_BLANK',
  // SINGLE_CHOICE：个别题库/旧数据里的单选别名，按 MULTIPLE_CHOICE 走（真实枚举是 MULTIPLE_CHOICE）。
  'SINGLE_CHOICE',
]);

export const CODE_TYPES = new Set(['PROGRAMMING', 'CODE_COMPLETION', 'SQL_PROGRAMMING']);

// detailKey 形状来自 kisakiayano/PTA-mcp 的 PLATFORM_NOTES §1（生产前端逆向 + 实测）。
// TODO(verify): 未经我方真号验证，mock 只验证形状自洽。
export function buildDetail(problem, solved) {
  const base = { problemId: '0', problemSetProblemId: problem.pspId };
  switch (problem.type) {
    case 'TRUE_OR_FALSE': {
      const v = solved.answer === true || String(solved.answer).toUpperCase() === 'TRUE';
      return { ...base, trueOrFalseSubmissionDetail: { answer: v ? 'TRUE' : 'FALSE' } };
    }
    case 'MULTIPLE_CHOICE':
    case 'SINGLE_CHOICE':
      return { ...base, multipleChoiceSubmissionDetail: { answer: String(solved.answer) } };
    case 'MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER':
      return { ...base, multipleChoiceMoreThanOneAnswerSubmissionDetail: { answers: Array.isArray(solved.answer) ? solved.answer : [solved.answer] } };
    case 'FILL_IN_THE_BLANK':
      return { ...base, fillInTheBlankSubmissionDetail: { answers: Array.isArray(solved.answer) ? solved.answer : [solved.answer] } };
    case 'FILL_IN_THE_BLANK_FOR_PROGRAMMING':
      return { ...base, fillInTheBlankForProgrammingSubmissionDetail: { answers: Array.isArray(solved.answer) ? solved.answer : [solved.answer] } };
    case 'CHOICE_BLANK':
      return { ...base, choiceBlankSubmissionDetail: { answers: Array.isArray(solved.answer) ? solved.answer : [solved.answer] } };
    case 'PROGRAMMING':
      return { ...base, programmingSubmissionDetail: { program: solved.code, compiler: solved.compiler } };
    case 'CODE_COMPLETION':
      return { ...base, codeCompletionSubmissionDetail: { program: solved.code, compiler: solved.compiler } };
    case 'SQL_PROGRAMMING':
      return { ...base, sqlProgrammingSubmissionDetail: { program: solved.code } };
    default:
      throw new Error(`unknown problem type for submit: ${problem.type}`);
  }
}

// 正式考试判定：只看结构化标记（type / examType / oms / isExam / 监考字样），
// 不靠猜。命中即拒绝。平时练习题集的 type 通常是 PRACTICE/空。
export function isFormalExam(setMeta) {
  if (!setMeta) return false;
  const t = String(setMeta.type || setMeta.examType || '').toUpperCase();
  if (['EXAM', 'FORMAL_EXAM', 'FORMAL', 'OMS'].includes(t)) return true;
  if (setMeta.oms === true || setMeta.isExam === true || setMeta.monitored === true) return true;
  if (/OMS|监考/.test(String(setMeta.name || setMeta.title || ''))) return true;
  return false;
}

export function stripTags(content) {
  return String(content || '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 答案归一化（kisaki server.py 的 _normalize）：提交前统一答案形状，避免
// 模型输出 "A,C" / "A C" / "AC" / "T" / "true" 这类写法被判错。
// 判断题 → TRUE/FALSE；单选 → 单个大写字母；多选 → 字母数组；
// 填空 → answers 数组（不按逗号切分，答案本身可能含逗号）。
export function normalizeSolved(problem, answer) {
  const type = problem.type;
  if (type === 'TRUE_OR_FALSE') {
    const v = String(answer ?? '').trim().toUpperCase();
    if (['T', 'TRUE', '对', '正确'].includes(v) || answer === true) return 'TRUE';
    return 'FALSE';
  }
  if (type === 'MULTIPLE_CHOICE' || type === 'SINGLE_CHOICE') {
    const letters = String(answer ?? '').toUpperCase().replace(/[^A-Z]/g, '');
    return letters.slice(0, 1);
  }
  if (type === 'MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER') {
    if (Array.isArray(answer)) return answer.map((a) => String(a).toUpperCase().trim()).filter(Boolean);
    return String(answer ?? '').toUpperCase().replace(/[^A-Z]/g, '').split('').filter(Boolean);
  }
  if (type === 'FILL_IN_THE_BLANK' || type === 'FILL_IN_THE_BLANK_FOR_PROGRAMMING' || type === 'CHOICE_BLANK') {
    return Array.isArray(answer) ? answer : [answer];
  }
  return answer;
}

export function normalizeProblem(raw, { compilersFallback = [] } = {}) {
  const content = raw.content || '';
  const cfg = raw.problemConfig || {};
  // 选择题选项可能只存在 problemConfig 里（kisaki 的 _with_options）：
  // 防御式地从 config 里抠选项拼进题面（key 含 option/choices 的数组），
  // 否则模型看不到选项、shuffleOptions 也没法重排。TODO(verify): 字段名未实测。
  let text = stripTags(content);
  let options = [];
  for (const [k, v] of Object.entries(cfg)) {
    if (Array.isArray(v) && /option|choice/i.test(k) && v.length) {
      options = v.map((o, i) => (typeof o === 'string' ? o : (o?.content || o?.text || o?.label || String(o))));
      break;
    }
  }
  if (options.length && !/^\s*A[.\s]/m.test(text)) {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    text = `${text}\n${options.map((o, i) => `${letters[i]}. ${o}`).join('\n')}`;
  }
  return {
    pspId: raw.id,
    type: raw.type,
    score: raw.score ?? 0,
    // 题面首行作短标题（kisaki 的 _title_of；raw.title 为空时用）。
    title: raw.title || text.split('\n').find((l) => l.trim())?.trim().slice(0, 40) || '',
    content: text,
    rawContent: content,
    compiler: raw.compiler || compilersFallback[0] || '',
    samples: raw.samples?.length ? raw.samples : extractSamples(content),
    config: cfg,
    options,
  };
}

// 答案输入三格式归一化（educoder commands.mjs 的 parseChoicesInput）：
// 接受 ["A","BC"]（按题号顺序）/ {"1":"A"}（题号作 key）/ [{index:1,answer:"A"}]，
// 严格校验题号 1..N 连续不重复；返回按题号排序的答案数组。
// N 是该题型的题数（由调用方按 exam-problems 列表传）。
export function normalizeAnswersInput(raw, count) {
  let list = [];
  if (Array.isArray(raw)) {
    if (raw.length && typeof raw[0] === 'object' && raw[0] !== null && 'index' in raw[0]) {
      list = raw.map((x) => ({ index: Number(x.index), answer: x.answer }));
    } else {
      list = raw.map((a, i) => ({ index: i + 1, answer: a }));
    }
  } else if (raw && typeof raw === 'object') {
    list = Object.entries(raw).map(([k, v]) => ({ index: Number(k), answer: v }));
  } else {
    throw new Error('answers must be an array or an object keyed by question number');
  }
  list.sort((a, b) => a.index - b.index);
  const seen = new Set();
  for (const { index } of list) {
    if (!Number.isInteger(index) || index < 1 || index > count) throw new Error(`question number out of range: ${index} (1..${count})`);
    if (seen.has(index)) throw new Error(`duplicate question number: ${index}`);
    seen.add(index);
  }
  if (seen.size !== count) throw new Error(`answers cover ${seen.size} of ${count} questions, expected all ${count}`);
  return list.map((x) => x.answer);
}

// 从归一化后的答案数组建 details：按题号顺序对应 exam-problems 里该题型的题目列表。
// 只用于客观题；编程题走 program / program_path，不走这条路。
export function buildDetailsFromAnswers(problems, type, answers) {
  if (CODE_TYPES.has(type)) throw new Error(`buildDetailsFromAnswers is for objective types, not ${type}; use program/program_path`);
  const ofType = problems.filter((p) => p.type === type);
  const norm = normalizeAnswersInput(answers, ofType.length);
  return ofType.map((p, i) => buildDetail(p, { answer: normalizeSolved(p, norm[i]) }));
}

// 拉全量题目并做数量校验（PTA-mcp 的 summaries 校验思想）：
// 先拉全量，再拿 problem-summaries 各题型数量比对；不一致说明 exam-problems
// 可能分页（vscode-pintia 用 /exam-problem-list?problem_type=&page=&limit=200），
// 就按题型分批再拉、按 id 去重合并；仍对不上只记审计、不硬失败。
export async function fetchAllProblems(client, psid, { accountId = '', log = () => {} } = {}) {
  const cacheKey = `problems-${psid}`;
  if (accountId) {
    const cached = store.readCache(accountId, cacheKey);
    if (cached) return cached;
  }
  const raw = await client.examProblems(psid);
  let list = raw.examProblems || raw.problems || [];
  const byId = new Map(list.map((p) => [p.id, p]));
  let expected = 0;
  try {
    const s = await client.problemSummaries(psid);
    const sums = s.problemSummaries || s.summaries || [];
    expected = sums.reduce((n, x) => n + (x.count ?? 1), 0);
  } catch {
    expected = 0; // summaries 取不到就不校验
  }
  if (expected > 0 && list.length < expected) {
    const types = [...new Set(list.map((p) => p.type))];
    for (const t of types) {
      const r = await client.examProblems(psid, { problemType: t });
      for (const p of (r.examProblems || r.problems || [])) {
        if (!byId.has(p.id)) byId.set(p.id, p);
      }
    }
    list = [...byId.values()];
    if (list.length < expected) {
      const msg = `problem count mismatch for ${psid}: got ${list.length}, summaries say ${expected}`;
      log(`  warning: ${msg}`);
      if (accountId) store.appendAudit(accountId, { action: 'summaries_mismatch', psid, got: list.length, expected });
    }
  }
  if (accountId) store.writeCache(accountId, cacheKey, list);
  return list;
}

// 暂停：面板点“暂停”后，每道题开始前在这里等着，直到点“继续”；
// 等待期间点“停止”会立即退出。返回 false 表示应停止。
async function waitIfPaused(ctx) {
  while (ctx.shouldPause && ctx.shouldPause()) {
    if (ctx.shouldStop()) return false;
    await sleep(2000);
  }
  return true;
}

export function verdictFromDetail(detail) {
  if (!detail) return { verdict: 'UNKNOWN' };
  const results = extractJudgeResults(detail);
  if (Array.isArray(results) && results.length) {
    const vals = results.map((r) => String(r.result || r.status || '').toUpperCase());
    if (vals.every((v) => v === 'ACCEPTED')) return { verdict: 'ACCEPTED', results };
    if (vals.some((v) => v === 'WRONG_ANSWER' || v === 'TIME_LIMIT_EXCEEDED' || v === 'RUNTIME_ERROR' || v === 'COMPILE_ERROR')) {
      return { verdict: 'WRONG_ANSWER', results };
    }
    return { verdict: 'PARTIAL_ACCEPTED', results };
  }
  const s = String(detail.status || detail.result || '').toUpperCase();
  if (s === 'ACCEPTED') return { verdict: 'ACCEPTED' };
  if (s) return { verdict: s };
  return { verdict: 'UNKNOWN' };
}

// 做题模式：all（全部未通过）、todo（只做未答过的）、wrong（只做错题）、
// one（单题重做，需配 onlyProblem）。
export function includeByMode(status, mode, onlyProblem, pspId) {
  if (onlyProblem) return pspId === onlyProblem;
  const st = status || 'PROBLEM_NO_ANSWER';
  if (mode === 'todo') return st === 'PROBLEM_NO_ANSWER';
  if (mode === 'wrong') return st === 'PROBLEM_WRONG_ANSWER' || st === 'PARTIAL_ACCEPTED';
  return st !== 'PROBLEM_ACCEPTED' && st !== 'PROBLEM_SUBMITTED'; // all
}

export async function runAll({ account, client, problemSet, all = false, mode = 'all', onlyProblem = '', maxFixes = 3, model = '', pace = 'normal', paceRef = null, yes = false, finish = false, shouldStop = () => false, shouldPause = () => false, log = console.log }) {
  if (account.enabled === false) {
    throw new Error(`account ${account.label} is disabled (enable it first)`);
  }
  const ds = new DSClient(deepSeekConfig({ model: model || undefined }));
  // 保守兜底（RESEARCH.md §13.5）：00:00–06:00 不批量跑、同一题集单日全量跑 ≤2 次。
  // 只警告 + 记审计，不硬拦（用户可能有正当理由深夜跑；硬拦也会把 mock 测试拦住）。
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 6) {
    log('warning: running between 00:00-06:00 — batch runs at night are discouraged (see README red lines)');
    store.appendAudit(account.id, { action: 'night_run_warning', problemSet: problemSet || '(auto)', mode });
  }
  if (yes && mode === 'all' && !onlyProblem) {
    const today = new Date().toISOString().slice(0, 10);
    const state = store.readState();
    state.dailyRuns = state.dailyRuns || {};
    // 只保留最近 7 天的计数。
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    for (const k of Object.keys(state.dailyRuns)) {
      if (k.slice(-10) < weekAgo) delete state.dailyRuns[k];
    }
    const key = `${account.id}:${problemSet || '(auto)'}:${today}`;
    const count = (state.dailyRuns[key] || 0) + 1;
    state.dailyRuns[key] = count;
    store.writeState(state);
    if (count > 2) {
      log(`warning: full run #${count} today for this problem set (recommended max 2/day)`);
      store.appendAudit(account.id, { action: 'daily_run_limit_warning', problemSet: problemSet || '(auto)', count });
    }
  }
  // paceRef：面板换档时改 paceRef.name，Pacer 下一次等待就用新档位。
  const pacer = new Pacer(paceRef ? () => paceRef.name || pace : pace, (m) => log(`  ${m}`));
  const ctx = { account, client, ds, pacer, yes, finish, mode, onlyProblem, maxFixes, shouldStop, shouldPause, log };
  const summary = { sets: [], problems: { total: 0, accepted: 0, failed: 0, skipped: 0, refused: 0, lowConfidence: 0 } };

  // 题集列表缓存 5 分钟（按账号隔离）；手动刷新/切换账号时失效。
  let setsData = store.readCache(account.id, 'problem-sets');
  if (!setsData) {
    setsData = await client.problemSets({ limit: 50 });
    store.writeCache(account.id, 'problem-sets', setsData);
  }
  const allSets = setsData.problemSets || setsData || [];
  const examIdBySet = setsData.examIdByProblemSetId || {};
  let targets = allSets;
  if (problemSet) {
    targets = allSets.filter((s) => s.id === problemSet);
    if (!targets.length) throw new Error(`problem set not found: ${problemSet}`);
  } else if (!all) {
    // 默认只做第一个练习题集，不把所有题集一口气全跑了。
    targets = allSets.filter((s) => !isFormalExam(s)).slice(0, 1);
    if (!targets.length) throw new Error('no practice problem sets found');
  }

  store.appendAudit(account.id, { action: 'run_start', problemSet: problemSet || '(auto)', mode, onlyProblem, pace, dryRun: !yes });
  for (const setMeta of targets) {
    if (shouldStop()) {
      log('run stopped by user');
      store.appendAudit(account.id, { action: 'run_stopped', problemSet: problemSet || '(auto)' });
      break;
    }
    const setSummary = await runSet(ctx, setMeta, examIdBySet[setMeta.id]);
    summary.sets.push(setSummary);
    summary.problems.total += setSummary.total;
    summary.problems.accepted += setSummary.accepted;
    summary.problems.failed += setSummary.failed;
    summary.problems.skipped += setSummary.skipped;
    summary.problems.refused += setSummary.refused;
    summary.problems.lowConfidence += setSummary.lowConfidence || 0;
  }
  store.appendAudit(account.id, { action: 'run_end', ...summary.problems });
  return summary;
}

async function runSet(ctx, setMeta, examIdHint) {
  const { account, client, log } = ctx;
  const psid = setMeta.id;
  const setSummary = { psid, name: setMeta.name || setMeta.title || psid, total: 0, accepted: 0, failed: 0, skipped: 0, refused: 0, lowConfidence: 0 };

  if (isFormalExam(setMeta)) {
    log(`REFUSED exam set ${psid} (${setSummary.name}): formal exam, not touching it`);
    store.appendAudit(account.id, { action: 'exam_refused', psid, reason: 'formal exam' });
    store.updateRunState(account.id, psid, { name: setSummary.name, stage: 'refused', total: 0, accepted: 0, failed: 0 });
    setSummary.refused = 1;
    return setSummary;
  }

  store.updateRunState(account.id, psid, { name: setSummary.name, stage: 'fetching', total: 0, accepted: 0, failed: 0 });
  const exams = await client.exams(psid);
  const examList = exams.exams || exams || [];
  let examId = examList[0]?.id || examList[0]?.examId || examIdHint || '';
  if (!examId) {
    // 无 exam 时防御式尝试自动建一个（vscode-pintia 的 createProblemSetExam）；
    // MY_PROBLEM_SET 个人题集不自动建（直接抛错）；失败仍走 BLOCKED。
    const setType = String(setMeta.type || setMeta.examType || '').toUpperCase();
    if (setType === 'MY_PROBLEM_SET') {
      log(`BLOCKED ${psid}: personal problem set without exam, refusing to auto-create`);
      store.appendAudit(account.id, { action: 'set_blocked', psid, reason: 'personal problem set, no exam' });
      store.updateRunState(account.id, psid, { stage: 'blocked' });
      setSummary.failed = 1;
      return setSummary;
    }
    try {
      await client.createExam(psid);
      const exams2 = await client.exams(psid);
      const list2 = exams2.exams || exams2 || [];
      examId = list2[0]?.id || list2[0]?.examId || '';
      if (examId) {
        log(`  created exam ${examId} for ${psid}`);
        store.appendAudit(account.id, { action: 'exam_created', psid, examId });
      }
    } catch (e) {
      log(`  create exam failed for ${psid}: ${e.message}`);
    }
  }
  if (!examId) {
    log(`BLOCKED ${psid}: no exam id found`);
    store.appendAudit(account.id, { action: 'set_blocked', psid, reason: 'no exam id' });
    store.updateRunState(account.id, psid, { stage: 'blocked' });
    setSummary.failed = 1;
    return setSummary;
  }

  // 取题不需要 exam_id，只依赖 problem_set_id；exam_id 只在提交和查判题时用
  // （PTA-mcp 的 PLATFORM_NOTES / 源码核对结论）。
  // 编译器回退：题面无 compiler 时用题集的 problemSetConfig.compilers。
  const compilers = await client.compilers(psid);
  const problemsRaw = await fetchAllProblems(client, psid, { accountId: account.id, log });
  const problems = problemsRaw.map((p) => normalizeProblem(p, { compilersFallback: compilers }));
  const statusData = await client.problemStatus(examId, psid);
  const statusList = statusData.problemStatus || statusData.status || [];
  const statusById = new Map(statusList.map((s) => [s.problemSetProblemId || s.id, s.status || s.problemStatus]));
  store.writeProgress(account.id, psid, { fetchedAt: new Date().toISOString(), examId, data: statusData });

  // 面板上“单题跳过”的题不做（跳过清单在 state.json 里，可取消跳过）。
  const todo = problems.filter((p) => includeByMode(statusById.get(p.pspId), ctx.mode, ctx.onlyProblem, p.pspId) && !store.isSkipped(account.id, psid, p.pspId));
  const alreadyDone = problems.filter((p) => (statusById.get(p.pspId) || '') === 'PROBLEM_ACCEPTED').length;
  setSummary.total = problems.length;
  setSummary.skipped = problems.length - todo.length;
  setSummary.accepted = alreadyDone;
  store.updateRunState(account.id, psid, {
    stage: 'solving', total: problems.length, accepted: setSummary.accepted, failed: 0,
  }, Object.fromEntries(problems.map((p) => [p.pspId, {
    type: p.type, score: p.score,
    status: statusById.get(p.pspId) || 'PROBLEM_NO_ANSWER',
    stage: statusById.get(p.pspId) === 'PROBLEM_ACCEPTED' ? 'done' : 'todo',
  }])));

  log(`set ${psid} (${setSummary.name}): ${problems.length} problems, ${todo.length} to do, ${setSummary.skipped} already done`);

  // 第一遍：客观题。按题型分组，整卷一次提交（PTA 客观题按题型 upsert）。
  const objective = todo.filter((p) => OBJECTIVE_TYPES.has(p.type));
  const byType = new Map();
  for (const p of objective) {
    if (!byType.has(p.type)) byType.set(p.type, []);
    byType.get(p.type).push(p);
  }
  for (const [type, list] of byType) {
    if (ctx.shouldStop()) break;
    if (!await waitIfPaused(ctx)) break;
    const details = [];
    for (const p of list) {
      if (ctx.shouldStop()) break;
      if (!await waitIfPaused(ctx)) break;
      // 运行中点了“单题跳过”：这里每题开始前再查一次，跳过即生效。
      if (store.isSkipped(account.id, psid, p.pspId)) {
        log(`  ${p.pspId} skipped by user (skip list)`);
        store.appendAudit(account.id, { action: 'problem_skipped', psid, problemId: p.pspId, type: p.type, reason: 'user skip list' });
        setSummary.skipped += 1;
        continue;
      }
      try {
        await ctx.pacer.waitRead(p.content, p.type, p.pspId);
        const solved = await solveObjective(ctx.ds, p);
        // 低置信（4 次采样一致率 < 0.75）不提交，进人工复核队列：
        // 错交比不交代价大，宁可留给人点选。
        if (solved.lowConfidence) {
          log(`  ${p.pspId} low confidence (${solved.agree}/${solved.votes}), NOT submitting — needs manual review`);
          store.appendAudit(account.id, { action: 'problem_low_confidence', psid, problemId: p.pspId, type: p.type, confidence: solved.confidence, votes: solved.votes, agree: solved.agree });
          // 进待复核队列（dsh-task-panel 的验收/返工思路）：等人验收/返工，机器不再自动交。
          store.addReviewItem(account.id, { psid, pspId: p.pspId, type: p.type, reason: 'low-confidence', detail: { confidence: solved.confidence, votes: solved.votes, agree: solved.agree } });
          store.updateRunState(account.id, psid, {}, { [p.pspId]: { stage: 'low-confidence', lastAction: 'solve', lastAt: new Date().toISOString() } });
          setSummary.lowConfidence += 1;
          continue;
        }
        store.appendAudit(account.id, { action: 'problem_solved', psid, problemId: p.pspId, type: p.type, confidence: solved.confidence, votes: solved.votes, agree: solved.agree });
        store.updateRunState(account.id, psid, {}, { [p.pspId]: { stage: 'solved', lastAction: 'solve', lastAt: new Date().toISOString() } });
        // 提交前归一化答案（"A,C"/"A C"/"AC"/"T" 这类写法统一成提交形状）。
        details.push(buildDetail(p, { ...solved, answer: normalizeSolved(p, solved.answer) }));
      } catch (e) {
        log(`  ${p.pspId} solve failed: ${e.message}`);
        store.appendAudit(account.id, { action: 'problem_failed', psid, problemId: p.pspId, type: p.type, reason: `solve: ${e.message}` });
        setSummary.failed += 1;
      }
    }
    if (details.length) {
      const r = await submitBatch(ctx, { examId, psid, type, details, label: `${type} x${details.length}` });
      if (r.submitted) {
        setSummary.accepted += details.length; // 客观题判题在交卷时触发，先按已提交计
        store.updateRunState(account.id, psid, { accepted: setSummary.accepted }, Object.fromEntries(details.map((d) => [d.problemSetProblemId, { stage: 'submitted', status: 'PROBLEM_SUBMITTED', lastAction: 'submit', lastAt: new Date().toISOString() }])));
      }
    }
  }

  // 第二遍：编程题，逐题。
  for (const p of todo.filter((p) => CODE_TYPES.has(p.type))) {
    if (ctx.shouldStop()) break;
    if (!await waitIfPaused(ctx)) break;
    const r = await runProgrammingProblem(ctx, setMeta, examId, p);
    if (r.ok) setSummary.accepted += 1;
    else if (r.dryRun || r.skipped) setSummary.skipped += 1; // 预览 / 用户跳过不算失败
    else setSummary.failed += 1;
  }

  // 未知题型：跳过并记日志，不猜。
  for (const p of todo.filter((p) => !OBJECTIVE_TYPES.has(p.type) && !CODE_TYPES.has(p.type))) {
    log(`  ${p.pspId} skipped: unsupported type ${p.type}`);
    store.appendAudit(account.id, { action: 'problem_skipped', psid, problemId: p.pspId, type: p.type, reason: 'unsupported type' });
    setSummary.failed += 1;
  }

  // 收尾：刷新一次状态，写回看板。
  let finalList = [];
  try {
    const finalStatus = await client.problemStatus(examId, psid);
    finalList = finalStatus.problemStatus || finalStatus.status || [];
    const accepted = finalList.filter((s) => (s.status || s.problemStatus) === 'PROBLEM_ACCEPTED').length;
    store.writeProgress(account.id, psid, { fetchedAt: new Date().toISOString(), examId, data: finalStatus });
    store.updateRunState(account.id, psid, {
      stage: 'done', accepted, failed: setSummary.failed,
    }, Object.fromEntries(finalList.map((s) => [(s.problemSetProblemId || s.id), { status: s.status || s.problemStatus, stage: (s.status || s.problemStatus) === 'PROBLEM_ACCEPTED' ? 'done' : 'todo' }])));
    setSummary.accepted = accepted;
    // 验收闭环：这一轮通过的题，若在待复核队列里（pending / rework），
    // 说明返工成功或人工已处理，自动标记 accepted，不再挂在队列里。
    for (const s of finalList) {
      if ((s.status || s.problemStatus) !== 'PROBLEM_ACCEPTED') continue;
      const key = store.reviewKey(account.id, psid, s.problemSetProblemId || s.id);
      const item = store.getReviewItems(account.id).find((r) => r.key === key);
      if (item && (item.status === 'pending' || item.status === 'rework')) {
        store.updateReviewItem(key, { status: 'accepted' });
        store.appendAudit(account.id, { action: 'review_auto_accepted', psid, problemId: s.problemSetProblemId || s.id, reason: item.reason });
      }
    }
  } catch (e) {
    store.updateRunState(account.id, psid, { stage: 'done', failed: setSummary.failed });
    log(`  final status refresh failed: ${e.message}`);
  }

  // 交卷（触发客观题判题）：只在 --finish 且真交模式下做，默认不交卷。
  // 交卷端点全网无人实现（自研，见 RESEARCH.md §12.6.3），7 条小心事项：
  // ①交卷不可逆，必须是显式前置确认动作（面板二次确认），绝不能作为 runAll
  //   默认收尾自动执行；②交卷前客观题无法自查（standard-answers 交卷前返回
  //   空），门控只能是“客观题答案已全部提交 + 编程题已判题通过”，不能是
  //   “客观题全对”；③交卷后状态未知，首次实测必须用可丢弃的练习 exam，
  //   完整记录请求/响应体，并确认交卷后再次提交是否被拒；④失败重试风险：
  //   不知道该 PUT 是否幂等，重试前必须先 GET exam 状态确认是否已结束，
  //   禁止盲重试；⑤截止窗口：提交前先读 serverTime 与 endAt，过期 exam
  //   不要在 endAt 前最后一分钟交卷；⑥整卷一致性：交卷前确认最后一次提交
  //   覆盖了该题型全部答案（分批提交会互相覆盖），交卷动作本身不补交答案；
  // ⑦响应语义未知：响应码 + 响应体 + 交卷后状态查询三者都记入审计日志，
  //   失败时状态置 blocked 等人工处理，不自动重试。
  if (ctx.finish && ctx.yes) {
    const endAt = setMeta.endAt ? new Date(setMeta.endAt).getTime() : 0;
    const now = Date.now();
    const unansweredObjective = finalList.filter((s) => {
      const p = problems.find((x) => x.pspId === (s.problemSetProblemId || s.id));
      return p && OBJECTIVE_TYPES.has(p.type) && (s.status || s.problemStatus) === 'PROBLEM_NO_ANSWER';
    });
    if (endAt && now > endAt) {
      log(`  endExam skipped: endAt ${setMeta.endAt} already passed`);
      store.appendAudit(account.id, { action: 'exam_finish_blocked', psid, examId, reason: 'endAt passed' });
    } else if (endAt && endAt - now < 60_000) {
      log(`  endExam skipped: endAt is within 60s, too close to deadline`);
      store.appendAudit(account.id, { action: 'exam_finish_blocked', psid, examId, reason: 'endAt within 60s' });
    } else if (unansweredObjective.length) {
      log(`  endExam skipped: ${unansweredObjective.length} objective problem(s) still unanswered`);
      store.appendAudit(account.id, { action: 'exam_finish_blocked', psid, examId, reason: 'objective unanswered', count: unansweredObjective.length });
    } else {
      try {
        const resp = await client.endExam(examId);
        store.appendAudit(account.id, { action: 'exam_finished', psid, examId, response: JSON.stringify(resp).slice(0, 1000) });
        log(`  exam ${examId} finished (endExam called)`);
        // 交卷后状态查询：确认已结束，并把结果记入审计。
        try {
          const after = await client.problemStatus(examId, psid);
          store.appendAudit(account.id, { action: 'exam_finished_state', psid, examId, status: JSON.stringify(after).slice(0, 500) });
        } catch (e) {
          store.appendAudit(account.id, { action: 'exam_finished_state_failed', psid, examId, reason: e.message });
        }
      } catch (e) {
        log(`  endExam failed: ${e.message}`);
        store.appendAudit(account.id, { action: 'exam_finish_failed', psid, examId, reason: e.message });
        store.updateRunState(account.id, psid, { stage: 'blocked' });
      }
    }
  }
  return setSummary;
}

async function submitBatch(ctx, { examId, psid, type, details, label, customTestData = null }) {
  const { account, client, log } = ctx;
  if (!ctx.yes) {
    log(`  dry-run: would submit ${details.length} ${type} detail(s) to exam ${examId} (re-run with --yes)`);
    store.appendAudit(account.id, { action: 'submit_preview', psid, type, count: details.length });
    return { submitted: false, dryRun: true };
  }
  await ctx.pacer.waitGap(label);
  await ctx.pacer.waitBeforeSubmit(label, details[0]?.programmingSubmissionDetail?.program || details[0]?.codeCompletionSubmissionDetail?.program || details[0]?.sqlProgrammingSubmissionDetail?.program || '');
  const res = await client.submit(examId, type, details, { customTestData });
  ctx.pacer.markSubmitted();
  store.appendAudit(account.id, { action: 'submitted', psid, type, count: details.length, customTest: customTestData != null });
  log(`  submitted ${details.length} ${type} detail(s) to exam ${examId}`);
  const submissionId = res?.submissionId || res?.id || await findSubmissionId(client, examId, psid, type);
  if (submissionId) {
    // 判题约 1 秒出结果，WAITING 最多再等 2×1 秒；编程题上限 60 次 × 1 秒
    // （vscode-pintia TEST_POLL_MAX_ATTEMPTS=60），客观题 3 次（判题在交卷时触发）。
    const { judged, detail } = await client.pollSubmission(examId, submissionId, { tries: type === 'PROGRAMMING' || type === 'CODE_COMPLETION' || type === 'SQL_PROGRAMMING' ? 60 : 3, intervalMs: 1000, customTest: customTestData != null });
    const verdict = verdictFromDetail(detail);
    store.appendAudit(account.id, { action: 'judged', psid, type, submissionId, judged, verdict: verdict.verdict });
    log(`  judged ${label}: ${verdict.verdict} (submission ${submissionId})`);
    return { submitted: true, submissionId, judged, verdict: verdict.verdict, detail };
  }
  return { submitted: true, submissionId: null, judged: false, verdict: 'UNKNOWN' };
}

async function findSubmissionId(client, examId, psid, problemType) {
  try {
    const data = await client.lastSubmissions(examId, psid, problemType);
    const list = data.submissions || data.lastSubmissions || data || [];
    const first = Array.isArray(list) ? list[0] : null;
    return first?.submissionId || first?.id || null;
  } catch {
    return null;
  }
}

async function runProgrammingProblem(ctx, setMeta, examId, p) {
  const { account, client, log } = ctx;
  const psid = setMeta.id;
  const workDir = join(store.accountDir(account.id), 'work', p.pspId);
  // 运行中点了“单题跳过”：下一题开始前检查。
  if (store.isSkipped(account.id, psid, p.pspId)) {
    log(`  ${p.pspId} skipped by user (skip list)`);
    store.appendAudit(account.id, { action: 'problem_skipped', psid, problemId: p.pspId, type: p.type, reason: 'user skip list' });
    return { ok: false, skipped: true };
  }
  try {
    await ctx.pacer.waitRead(p.content, p.type, p.pspId);
    const solved = await solveProgramming(ctx.ds, p, { workDir, maxFixes: ctx.maxFixes });
    store.appendAudit(account.id, {
      action: 'problem_solved', psid, problemId: p.pspId, type: p.type,
      verified: solved.verified, attempts: solved.attempts, note: solved.note || '',
      blocked: solved.blocked || false, blockReason: solved.blockReason || '',
    });
    if (solved.blocked) {
      // 停表触发（报错相同 2 轮 / 通过数零增长 2 轮）：不交，等人工接手。
      log(`  ${p.pspId} blocked: ${solved.blockReason}, NOT submitting`);
      store.appendAudit(account.id, { action: 'problem_blocked', psid, problemId: p.pspId, type: p.type, reason: solved.blockReason });
      store.addReviewItem(account.id, { psid, pspId: p.pspId, type: p.type, reason: 'blocked', detail: { blockReason: solved.blockReason, attempts: solved.attempts } });
      store.updateRunState(account.id, psid, {}, { [p.pspId]: { stage: 'blocked', lastAction: 'self-test', lastAt: new Date().toISOString() } });
      return { ok: false };
    }
    if (!solved.verified && solved.note && /failed after/.test(solved.note)) {
      log(`  ${p.pspId} self-test failed after ${solved.attempts} attempts, NOT submitting`);
      store.appendAudit(account.id, { action: 'problem_failed', psid, problemId: p.pspId, type: p.type, reason: 'self-test failed' });
      store.addReviewItem(account.id, { psid, pspId: p.pspId, type: p.type, reason: 'self-test-failed', detail: { attempts: solved.attempts, note: solved.note } });
      store.updateRunState(account.id, psid, {}, { [p.pspId]: { stage: 'failed', lastAction: 'self-test', lastAt: new Date().toISOString() } });
      return { ok: false };
    }
    // 代码差异化（按账号种子）：变换后重新跑样例，失败回退原代码。
    let code = solved.code;
    let varied = false;
    if (solved.samples.length) {
      const lang = /PYTHON/i.test(solved.compiler) ? 'python' : 'c';
      const v = await varyCodeSafe(solved.code, lang, `${account.id}:${p.pspId}`, async (c) => runSamples({ code: c, compiler: solved.compiler, samples: solved.samples, workDir }));
      code = v.code;
      varied = v.varied;
      store.appendAudit(account.id, { action: 'code_varied', psid, problemId: p.pspId, varied, verified: v.verified });
    } else {
      log(`  ${p.pspId} no samples: variation skipped (cannot verify without samples)`);
    }
    store.updateRunState(account.id, psid, {}, { [p.pspId]: { stage: 'solved', lastAction: 'solve', lastAt: new Date().toISOString() } });

    // 本地无编译器（noLocalCompiler）：先走服务端自定义测试（customTestData），
    // 把第一条样例发服务端判，输出对上了再真交；对不上就把差异喂回模型改一次。
    // 服务端判题语义在 mock 里无法覆盖（mock 同样无 JDK），见 PLAN §11。
    if (solved.noLocalCompiler && solved.samples?.length) {
      const sample = solved.samples[0];
      log(`  ${p.pspId} no local compiler (${solved.compiler}), verifying via server custom test`);
      store.appendAudit(account.id, { action: 'custom_test_start', psid, problemId: p.pspId, compiler: solved.compiler });
      const detail = buildDetail(p, { code: solved.code, compiler: solved.compiler });
      const probe = await submitBatch(ctx, { examId, psid, type: p.type, details: [detail], label: `${p.pspId} custom-test`, customTestData: sample.input });
      if (probe.judged && probe.detail?.customTestResult) {
        const actual = String(probe.detail.customTestResult.output ?? '').trim();
        const expected = String(sample.output ?? '').trim();
        store.appendAudit(account.id, { action: 'custom_test_result', psid, problemId: p.pspId, match: actual === expected, actual: actual.slice(0, 200), expected: expected.slice(0, 200) });
        if (actual !== expected) {
          log(`  ${p.pspId} custom test mismatch (got ${JSON.stringify(actual.slice(0, 80))}, want ${JSON.stringify(expected.slice(0, 80))}), NOT submitting`);
          return { ok: false };
        }
        log(`  ${p.pspId} custom test passed, submitting for real`);
      } else if (!probe.submitted) {
        return { ok: false, dryRun: true };
      } else {
        // 服务端没返回自定义测试结果：不盲目真交，记日志等人工处理。
        log(`  ${p.pspId} custom test returned no result, NOT submitting`);
        store.appendAudit(account.id, { action: 'custom_test_no_result', psid, problemId: p.pspId });
        return { ok: false };
      }
    }
    const detail = buildDetail(p, { code, compiler: solved.compiler });
    let r = await submitBatch(ctx, { examId, psid, type: p.type, details: [detail], label: `${p.pspId} (${p.type})` });
    if (!r.submitted) return { ok: false, dryRun: true };
    // 判题不过：把判题反馈（失败用例四段，各截 200 字符）喂回模型改一次，
    // 再交一次；只重试 1 次。
    if (r.judged && r.verdict !== 'ACCEPTED') {
      log(`  ${p.pspId} judged ${r.verdict}, retrying once with judge feedback`);
      store.appendAudit(account.id, { action: 'retry', psid, problemId: p.pspId, verdict: r.verdict });
      const feedback = formatJudgeFeedback(r.detail);
      const retry = await solveProgramming(ctx.ds, p, { workDir, maxFixes: ctx.maxFixes, feedback });
      if (retry.verified || !retry.note?.includes('failed after')) {
        let code2 = retry.code;
        if (retry.samples.length) {
          const lang = /PYTHON/i.test(retry.compiler) ? 'python' : 'c';
          const v2 = await varyCodeSafe(retry.code, lang, `${account.id}:${p.pspId}:retry`, async (c) => runSamples({ code: c, compiler: retry.compiler, samples: retry.samples, workDir }));
          code2 = v2.code;
        }
        r = await submitBatch(ctx, { examId, psid, type: p.type, details: [buildDetail(p, { code: code2, compiler: retry.compiler })], label: `${p.pspId} retry` });
      }
    }
    const ok = r.judged ? r.verdict === 'ACCEPTED' : r.submitted;
    store.updateRunState(account.id, psid, {}, { [p.pspId]: { stage: ok ? 'done' : 'failed', status: ok ? 'PROBLEM_ACCEPTED' : 'PROBLEM_WRONG_ANSWER', lastAction: 'judge', lastAt: new Date().toISOString() } });
    store.appendAudit(account.id, { action: ok ? 'problem_accepted' : 'problem_failed', psid, problemId: p.pspId, type: p.type, verdict: r.verdict || 'UNKNOWN' });
    return { ok };
  } catch (e) {
    log(`  ${p.pspId} error: ${e.message}`);
    store.appendAudit(account.id, { action: 'problem_failed', psid, problemId: p.pspId, type: p.type, reason: e.message });
    store.updateRunState(account.id, psid, {}, { [p.pspId]: { stage: 'failed', lastAction: 'error', lastAt: new Date().toISOString() } });
    return { ok: false };
  }
}
