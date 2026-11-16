// 答案生成：调 DeepSeek Chat Completions 解题（用户定：答案由 DS 自己生成）。
// key 只从环境变量 DEEPSEEK_API_KEY 读，绝不写进文件；无 key 时报错并说明去 DSH 里配。
// 客观题返回 { answer, confidence }；编程题生成代码后本地跑题目样例，
// 失败把报错喂回模型最多改 3 次。
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { extractJudgeResults } from './pta-client.mjs';

const execFileAsync = promisify(execFile);

export function deepSeekConfig(override = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY || '';
  if (!apiKey) {
    throw new Error('no DEEPSEEK_API_KEY: set it in the environment (in DSH, add it to the workspace env / credential service), never commit it');
  }
  return {
    apiKey,
    base: (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(/\/$/, ''),
    model: override.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  };
}

export class DSClient {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.base = config.base;
    this.model = config.model;
    // token 预算：DEEPSEEK_MAX_TOKENS（默认 200000），超了就停，不无限烧。
    // 成本上限另由调用方按 usage 折算；这里只做 token 硬上限。
    this.tokenBudget = Number(process.env.DEEPSEEK_MAX_TOKENS || 200000);
    this.tokensUsed = 0;
  }

  async chat(messages, { temperature = 0.2, maxTokens = 4000 } = {}) {
    if (this.tokensUsed >= this.tokenBudget) {
      throw new Error(`deepseek token budget exhausted (${this.tokensUsed}/${this.tokenBudget} tokens); raise DEEPSEEK_MAX_TOKENS or stop`);
    }
    const res = await fetch(`${this.base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`deepseek HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    }
    const usage = data?.usage;
    if (usage) {
      this.tokensUsed += (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
    }
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error(`deepseek empty reply: ${JSON.stringify(data).slice(0, 300)}`);
    return text;
  }
}

// 从模型回复里抠 JSON（允许模型多说两句，只取第一个 {...}）。
export function extractJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in model reply: ${String(text).slice(0, 200)}`);
  return JSON.parse(m[0]);
}

// 从模型回复里抠代码块（第一个 ``` 块；没有围栏则整段当代码）。
export function extractCode(text) {
  const m = String(text).match(/```(?:[A-Za-z0-9_+-]*)\n([\s\S]*?)```/);
  if (m) return m[1].trim() + '\n';
  return String(text).trim() + '\n';
}

const OBJECTIVE_PROMPT = `你是 PTA（拼题A）作业的解题助手。只输出一个 JSON，不要解释。
题目类型在 problem.type 里，答案格式：
- TRUE_OR_FALSE：{"answer": true/false, "confidence": 0-1}
- SINGLE_CHOICE：{"answer": "A"/"B"/"C"/"D", "confidence": 0-1}
- MULTIPLE_CHOICE：{"answer": ["A","B"], "confidence": 0-1}（按字母序）
- FILL_IN_THE_BLANK：{"answer": "填空内容", "confidence": 0-1}（多空用数组）`;

export async function solveObjective(ds, problem) {
  const answers = [];
  const userContent = (content) => `题型：${problem.type}\n题目：\n${content}`;
  // 3 次采样（temperature 0.7 拉开差异）+ 1 次选项重排（打乱选项顺序再问，
  // 答案翻转就说明低置信）。自报 confidence 不可信（普遍过度自信），
  // 用 4 次答案的一致率当置信度代理。
  // 阈值 0.75 只是初值、无文献依据（4 票制下的工程取整：2/4 平票无法决策、
  // 3/4 是最小有效多数、4/4 过严；Wang et al. 2022 arXiv:2203.11171 只用
  // 多次采样 + 多数票，全文无阈值/弃答概念）。必须在目标题库 + DeepSeek 上
  // 用 100–400 道题校准：自动提交桶准确率目标 ≥90%，否则升阈值到 4/4
  // 或采样数提到 5 次。低于阈值标 low-confidence，调用方不提交、进人工复核。
  for (let i = 0; i < 3; i++) {
    const text = await ds.chat([
      { role: 'system', content: OBJECTIVE_PROMPT },
      { role: 'user', content: userContent(problem.content) },
    ], { temperature: 0.7 });
    const parsed = extractJson(text);
    if (parsed.answer === undefined) throw new Error('model returned no answer');
    answers.push(parsed.answer);
  }
  const shuffled = shuffleOptions(problem.content);
  if (shuffled) {
    const text = await ds.chat([
      { role: 'system', content: OBJECTIVE_PROMPT },
      { role: 'user', content: userContent(shuffled.content) },
    ], { temperature: 0.7 });
    const parsed = extractJson(text);
    if (parsed.answer !== undefined) {
      // 重排后的答案字母要映射回原选项。
      answers.push(remapAnswer(parsed.answer, shuffled.map, problem.type));
    }
  } else {
    const text = await ds.chat([
      { role: 'system', content: OBJECTIVE_PROMPT },
      { role: 'user', content: userContent(problem.content) },
    ], { temperature: 0.7 });
    const parsed = extractJson(text);
    if (parsed.answer !== undefined) answers.push(parsed.answer);
  }
  const counts = new Map();
  const originals = new Map(); // 归一化 key -> 第一次见到的原始答案（填空题要保住原大小写）
  for (const a of answers) {
    const k = normalizeAnswer(a, problem.type);
    counts.set(k, (counts.get(k) || 0) + 1);
    if (!originals.has(k)) originals.set(k, a);
  }
  let best = '';
  let bestCount = 0;
  for (const [k, c] of counts) {
    if (c > bestCount) { best = k; bestCount = c; }
  }
  const confidence = answers.length ? bestCount / answers.length : 0;
  const answer = originals.get(best);
  return { answer, confidence, lowConfidence: confidence < 0.75, votes: answers.length, agree: bestCount };
}

// 答案归一化（用于多数投票比较）：选择题大写字母排序拼串，
// 判断题转 TRUE/FALSE，填空题去空白小写。
export function normalizeAnswer(answer, type) {
  if (type === 'TRUE_OR_FALSE') {
    return (answer === true || String(answer).toUpperCase() === 'TRUE') ? 'TRUE' : 'FALSE';
  }
  if (Array.isArray(answer)) {
    return answer.map((a) => String(a).trim().toUpperCase()).sort().join(',');
  }
  return String(answer).trim().toUpperCase();
}

// 打乱选择题选项顺序（行首 A. / B. / C. / D. 这种写法），返回新题面 + 映射。
// 找不到选项行（如判断题、填空题）返回 null，调用方改做第 4 次普通采样。
export function shuffleOptions(content) {
  const lines = String(content || '').split('\n');
  const idx = [];
  const re = /^([A-D])[.、．]\s*(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i].trim())) idx.push(i);
  }
  if (idx.length < 2) return null;
  const opts = idx.map((i) => ({ old: lines[i].trim().match(re)[1], text: lines[i].trim().match(re)[2] }));
  const order = opts.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const map = {}; // 新字母 -> 旧字母
  const newLines = [...lines];
  order.forEach((oldIdx, newPos) => {
    const label = labels[newPos];
    map[label] = opts[oldIdx].old;
    newLines[idx[newPos]] = `${label}. ${opts[oldIdx].text}`;
  });
  return { content: newLines.join('\n'), map };
}

// 重排 run 的答案字母按映射换回原字母（多选数组逐个换）。
function remapAnswer(answer, map, type) {
  if (type === 'TRUE_OR_FALSE') return answer;
  const remapOne = (a) => map[String(a).trim().toUpperCase()] || a;
  if (Array.isArray(answer)) return answer.map(remapOne);
  return remapOne(answer);
}

// 判题反馈格式化（供 solveProgramming 的重试用）：只喂失败用例，
// 每项截断——输入/期望/实际/报错各最多 200 字符；报错只留最后 30 行。
// 不把全量日志灌进上下文（Self-Debugging 的反馈格式）。
// 逐用例结果用 pta-client 的 extractJudgeResults 取（真实路径是嵌套的
// judgeResponseContents[].programmingJudgeResponseContent.testcaseJudgeResults）。
export function formatJudgeFeedback(detail) {
  const results = extractJudgeResults(detail);
  const lines = [];
  const failed = results.filter((r) => String(r.result || r.status || '').toUpperCase() !== 'ACCEPTED');
  const show = failed.length ? failed : results;
  show.slice(0, 3).forEach((r, i) => {
    const cut = (v) => String(v ?? '').slice(0, 200);
    const score = r.score !== undefined ? ` 得分=${r.score}` : '';
    const time = r.time_ms !== undefined ? ` 用时=${r.time_ms}ms` : '';
    lines.push(`用例${i + 1}：结果=${r.result || r.status || ''}${score}${time} 输入=${cut(r.input || r.testcaseInput || '')} 期望=${cut(r.expectedOutput || r.expected || '')} 实际=${cut(r.actualOutput || r.output || r.stdout || '')} 报错=${cut(r.error || r.stderr || '')}`);
  });
  const errText = String(detail?.error || detail?.stderr || detail?.message || '');
  if (errText) {
    lines.push(`报错（最后30行）：\n${errText.split('\n').slice(-30).join('\n').slice(0, 2000)}`);
  }
  return lines.length ? `判题结果：${detail?.status || detail?.verdict || 'FAILED'}。\n${lines.join('\n')}` : '判题失败（无可用详情）。';
}

// 本地自测失败的反馈格式化：报错最后 30 行 + 最多 3 个失败用例
// （输入/期望/实际/报错四段，各 200 字符），供下一轮模型修正。
export function formatFailure(res) {
  const lines = [];
  if (res.compileError) {
    lines.push(`编译/运行报错（最后30行）：\n${String(res.compileError).split('\n').slice(-30).join('\n').slice(0, 2000)}`);
  }
  const failed = (res.results || []).filter((r) => !r.passed).slice(0, 3);
  for (const r of failed) {
    const cut = (v) => String(v ?? '').slice(0, 200);
    lines.push(`失败用例：输入=${cut(r.input)} 期望=${cut(r.expected)} 实际=${cut(r.actual)} 报错=${cut(r.stderr)}`);
  }
  return lines.join('\n') || '未知失败（无报错输出）。';
}

const PROGRAMMING_PROMPT = `你是 PTA（拼题A）编程题的解题助手。只输出一个代码块，不要解释。
用题目给定的编译器语言写完整可编译的程序，从标准输入读数据、往标准输出写答案，
不要读文件、不要联网。`;

// 用 spawn 跑程序（不用 execFile 的 input 选项：实测它对 scanf 类程序会挂起，
// 直到超时才杀掉；手动 stdin.write + stdin.end 是正常的）。
function runWithInput(cmd, args, input, { timeoutMs = 5000, cwd = undefined } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, stdout, stderr: `${stderr} (timeout ${timeoutMs}ms)`.slice(0, 1000), code: null });
    }, timeoutMs + 500);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, stdout, stderr: String(e.message).slice(0, 1000), code: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, stdout, stderr: stderr.slice(0, 1000), code });
    });
    // stdin 的 EPIPE 是异步错误事件（try/catch 拦不住）：子进程若不读 stdin
    // 就提前退出（如只打印的程序），写 stdin 会 EPIPE；必须挂 error 监听吞掉，
    // 让 close 事件走正常结果，否则整个 Node 进程会被未处理异常拖垮。
    child.stdin.on('error', () => {});
    try {
      if (input) child.stdin.write(input);
      child.stdin.end();
    } catch { /* 子进程已退出：close 事件会正常 resolve */ }
  });
}
// 返回 { ok, results: [{ input, expected, actual, passed, stderr }] }。
export async function runSamples({ code, compiler = 'GCC', samples = [], workDir }) {
  const dir = workDir || join(process.cwd(), '.pta-test');
  mkdirSync(dir, { recursive: true });
  const lang = String(compiler).toUpperCase();
  let runCmd;
  let runArgs = [];
  if (lang === 'PYTHON3' || lang === 'PYTHON2') {
    const file = join(dir, 'main.py');
    writeFileSync(file, code);
    runCmd = 'python3';
    runArgs = [file];
  } else if (lang === 'GCC') {
    const src = join(dir, 'main.c');
    const bin = join(dir, 'main');
    writeFileSync(src, code);
    try {
      await execFileAsync('gcc', ['-O2', '-std=c11', '-o', bin, src], { timeout: 30000 });
    } catch (e) {
      return { ok: false, compileError: String(e.stderr || e.message).slice(0, 2000), results: [] };
    }
    runCmd = bin;
  } else if (lang === 'GXX' || lang === 'CLANGXX' || lang === 'CLANG') {
    const src = join(dir, 'main.cpp');
    const bin = join(dir, 'main');
    writeFileSync(src, code);
    const cc = lang === 'GXX' ? 'g++' : 'clang++';
    try {
      await execFileAsync(cc, ['-O2', '-std=c++17', '-o', bin, src], { timeout: 30000 });
    } catch (e) {
      return { ok: false, compileError: String(e.stderr || e.message).slice(0, 2000), results: [] };
    }
    runCmd = bin;
  } else if (lang === 'JAVAC') {
    if (!existsSync('/usr/bin/javac') && !process.env.JAVA_HOME) {
      return { ok: false, noRunner: true, compileError: 'no JDK on this machine (javac not found), cannot self-test Java', results: [] };
    }
    const src = join(dir, 'Main.java');
    writeFileSync(src, code);
    try {
      await execFileAsync('javac', [src], { timeout: 30000 });
    } catch (e) {
      return { ok: false, compileError: String(e.stderr || e.message).slice(0, 2000), results: [] };
    }
    runCmd = 'java';
    runArgs = ['-cp', dir, 'Main'];
  } else {
    return { ok: false, noRunner: true, compileError: `unsupported compiler for local self-test: ${compiler}`, results: [] };
  }

  const results = [];
  for (const s of samples) {
    const r = await runWithInput(runCmd, runArgs, s.input ?? '', { timeoutMs: 5000, cwd: dir });
    const actual = String(r.stdout || '').trim();
    const expected = String(s.output ?? '').trim();
    results.push({
      input: s.input ?? '',
      expected,
      actual,
      passed: r.ok && actual === expected,
      stderr: String(r.stderr || '').slice(0, 500),
    });
  }
  return { ok: results.length > 0 && results.every((r) => r.passed), results };
}

// 从题面里抠样例（多种写法都试；抠不到返回 []，由调用方决定只做编译检查）。
export function extractSamples(content) {
  const text = String(content || '');
  const patterns = [
    /样例输入\s*[:：]?\s*\n([\s\S]*?)\n\s*样例输出\s*[:：]?\s*\n([\s\S]*?)(?=\n\s*样例输入|\n\s*提示|\n\s*说明|\s*$)/g,
    /输入样例\s*[:：]?\s*\n([\s\S]*?)\n\s*输出样例\s*[:：]?\s*\n([\s\S]*?)(?=\n\s*输入样例|\n\s*提示|\n\s*说明|\s*$)/g,
    /Sample Input\s*[:：]?\s*\n([\s\S]*?)\n\s*Sample Output\s*[:：]?\s*\n([\s\S]*?)(?=\n\s*Sample Input|\s*$)/gi,
  ];
  for (const re of patterns) {
    const samples = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      samples.push({ input: (m[1] || '').trim(), output: (m[2] || '').trim() });
    }
    if (samples.length) return samples;
  }
  return [];
}

// 编程题：mini-SWE-agent + Self-Debugging 循环——生成 → 本地自测 →
// 只喂“最后 30 行报错 + 失败用例四段” → 模型先用一句话解释“错在哪”再改代码。
// 停表规则：轮数上限（maxFixes，默认 3，最多 5）；连续 2 轮报错完全相同；
// 连续 2 轮通过样例数零增长；三者任一即停，标 blocked，不无限烧 token。
// feedback（可选）：判题失败后的反馈文本，第一次生成时就带上。
// 返回 { code, compiler, verified, samples, attempts, history, blocked, blockReason }。
// verified=false（无样例时）表示只通过了编译检查，调用方要在日志里标明。
export async function solveProgramming(ds, problem, { workDir, maxFixes = 3, feedback = '' } = {}) {
  const compiler = problem.compiler || 'GCC';
  const samples = problem.samples?.length ? problem.samples : extractSamples(problem.content);
  const history = [];
  let code = '';
  let lastError = '';
  let lastErrorKey = '';
  let sameErrorRounds = 0;
  let lastPassedCount = -1;
  let stagnantRounds = 0;
  for (let attempt = 0; attempt <= maxFixes; attempt++) {
    const userMsg = attempt === 0
      ? `${feedback ? `${feedback}\n\n` : ''}编译器：${compiler}\n题目：\n${problem.content}`
      : `上一版代码编译/运行失败。先用一句话解释“错在哪”，再给出修正后的完整代码（只输出一个代码块，解释写在代码块前面）：\n${lastError}\n\n题目：\n${problem.content}\n\n上一版代码：\n\`\`\`\n${code}\n\`\`\``;
    const text = await ds.chat([
      { role: 'system', content: PROGRAMMING_PROMPT },
      { role: 'user', content: userMsg },
    ]);
    code = extractCode(text);
    const res = await runSamples({ code, compiler, samples, workDir });
    const passedCount = (res.results || []).filter((r) => r.passed).length;
    history.push({ attempt, ok: res.ok, compileError: res.compileError || '', results: res.results, passedCount });
    if (res.ok) return { code, compiler, verified: true, samples, attempts: attempt + 1, history };
    if (res.noRunner) {
      // 本地没有这个编译器：不是代码错，别烧修复轮次。调用方走服务端自定义测试
      // （customTestData）先验，再决定真交。
      return { code, compiler, verified: false, samples, attempts: attempt + 1, history, noLocalCompiler: true, note: res.compileError };
    }
    if (!samples.length) {
      // 无样例：编译通过即算“编译检查通过”，不再回炉。
      if (!res.compileError) return { code, compiler, verified: false, samples, attempts: attempt + 1, history, note: 'no samples, compile-only check' };
      lastError = formatFailure(res);
    } else {
      lastError = formatFailure(res);
    }
    // 停表 1：连续 2 轮报错完全相同（模型在原地打转）。
    const errKey = lastError.slice(0, 500);
    sameErrorRounds = (errKey === lastErrorKey) ? sameErrorRounds + 1 : 0;
    lastErrorKey = errKey;
    // 停表 2：连续 2 轮通过样例数零增长。
    stagnantRounds = (passedCount <= lastPassedCount) ? stagnantRounds + 1 : 0;
    lastPassedCount = passedCount;
    if (attempt >= 1 && sameErrorRounds >= 1) {
      return { code, compiler, verified: false, samples, attempts: attempt + 1, history, blocked: true, blockReason: 'same error 2 rounds in a row' };
    }
    if (attempt >= 1 && stagnantRounds >= 2) {
      return { code, compiler, verified: false, samples, attempts: attempt + 1, history, blocked: true, blockReason: 'passed sample count stagnant 2 rounds' };
    }
    if (attempt === maxFixes) {
      return { code, compiler, verified: false, samples, attempts: attempt + 1, history, note: `self-test failed after ${maxFixes + 1} attempts` };
    }
  }
  return { code, compiler, verified: false, samples, attempts: maxFixes + 1, history };
}
