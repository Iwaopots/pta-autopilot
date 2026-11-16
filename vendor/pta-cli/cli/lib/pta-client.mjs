// PTA（pintia.cn）API 客户端。端点形状来自 kisakiayano/PTA-mcp 的 PLATFORM_NOTES.md
//（生产前端逆向 + 实测），未经我方真号验证 —— 每个方法上标了 TODO(verify)，实测后消掉。
// 只用标准 fetch，不依赖任何第三方包。

const BASE = (process.env.PTA_BASE_URL || 'https://pintia.cn').replace(/\/$/, '');
const PASSPORT = (process.env.PTA_PASSPORT_URL || 'https://passport.pintia.cn').replace(/\/$/, '');

// 浏览器级请求头：网关会按请求特征打风控分，裸 fetch 极易触发验证码。
// 取自 PTA-mcp（MIT）的实测配置。
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Origin: 'https://pintia.cn',
  Referer: 'https://pintia.cn/',
  'sec-ch-ua': '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-site': 'same-site',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
};

export class PTAError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// 路径写错时 PTA 前端路由兜底返回 index.html，配 Accept: application/json 会得到
// 406 空响应体 —— 直接 .json() 会抛错，统一归一成 NOT_JSON。
// 返回 null 表示 body 不是 JSON（调用方按状态码决定是 NOT_JSON 还是可重试的网关错）。
function parseJsonOrNull(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// 可重试：网络错误（fetch 抛错）与网关 502/503/504。只重试这几种，业务错误不重试。
const RETRYABLE_STATUS = new Set([502, 503, 504]);
function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickCookies(res) {
  // undici 的 getSetCookie()；没有时退回单条 set-cookie。
  if (typeof res.headers.getSetCookie === 'function') {
    const all = res.headers.getSetCookie();
    if (all.length) return all.map((c) => c.split(';')[0]).join('; ');
  }
  const single = res.headers.get('set-cookie');
  return single ? single.split(';')[0] : '';
}

// 从判题详情里抽出逐用例结果（PTA-mcp 的 check_program_status 语义）。
// 真实路径是嵌套的：judgeResponseContents[].programmingJudgeResponseContent
// .testcaseJudgeResults，每条 { case, result, score, time_ms }；
// 根级 testcaseJudgeResults 也可能直接出现，两边都认。
export function extractJudgeResults(detail) {
  if (!detail || typeof detail !== 'object') return [];
  if (Array.isArray(detail.testcaseJudgeResults)) return detail.testcaseJudgeResults;
  const out = [];
  const contents = detail.judgeResponseContents;
  if (Array.isArray(contents)) {
    for (const c of contents) {
      const inner = c?.programmingJudgeResponseContent;
      if (inner && Array.isArray(inner.testcaseJudgeResults)) out.push(...inner.testcaseJudgeResults);
      else if (Array.isArray(c?.testcaseJudgeResults)) out.push(...c.testcaseJudgeResults);
    }
  }
  return out;
}

export class PTAClient {
  constructor(cookie = '') {
    this.cookie = cookie;
  }

  async request(path, { method = 'GET', body = null, base = BASE } = {}) {
    // 网络重试 3 次（HZ-Abox 的两级重试思想：网络层重试 3 次、间隔约 5 秒；
    // 业务重试另走 maxFixes/判题重试，不混在一起）。
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: {
            ...BROWSER_HEADERS,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(this.cookie ? { Cookie: this.cookie } : {}),
          },
          body: body ? JSON.stringify(body) : null,
        });
        const next = pickCookies(res);
        if (next) this.cookie = next;
        const text = await res.text();
        const data = parseJsonOrNull(text);
        if (data && typeof data === 'object' && data.error) {
          const code = data.error.code || data.error;
          // USER_NOT_FOUND(404) 在未登录时出现，容易误判，归一成 NOT_LOGGED_IN。
          if (code === 'USER_NOT_FOUND' && res.status === 404) throw new PTAError('NOT_LOGGED_IN', 'session expired or not logged in');
          throw new PTAError(code, data.error.message || code);
        }
        if (!data) {
          // 非 JSON 响应：网关 502/503/504 的 HTML 错误页可重试；其他（路径错被 SPA
          // 兜底成 index.html、406 空体）报 NOT_JSON。
          if (RETRYABLE_STATUS.has(res.status)) throw new PTAError(`HTTP_${res.status}`, `HTTP ${res.status} on ${path}`);
          throw new PTAError('NOT_JSON', `non-JSON body (HTTP ${res.status}): ${text.slice(0, 120)}`);
        }
        if (!res.ok) {
          if (RETRYABLE_STATUS.has(res.status)) throw new PTAError(`HTTP_${res.status}`, `HTTP ${res.status} on ${path}`);
          throw new PTAError(`HTTP_${res.status}`, `HTTP ${res.status} on ${path}`);
        }
        return data;
      } catch (e) {
        lastErr = e;
        const retryable = e instanceof PTAError
          ? RETRYABLE_STATUS.has(Number(String(e.code).replace('HTTP_', ''))) || e.code === 'NETWORK_ERROR'
          : true; // fetch 抛错（超时/断网/DNS）都按网络错误重试
        if (!retryable || attempt === 2) break;
        await sleepMs(5000);
      }
    }
    if (lastErr instanceof PTAError) throw lastErr;
    throw new PTAError('NETWORK_ERROR', lastErr?.message || 'network error');
  }

  // 预热：先 GET 登录页拿 PTASession / JSESSIONID 再登录。
  // 不预热直接发登录请求极易被网关判风险（PTA-mcp 实测）。
  async prewarm() {
    const res = await fetch(`${BASE}/auth/login`, {
      headers: { ...BROWSER_HEADERS, Accept: 'text/html,application/xhtml+xml' },
    });
    const next = pickCookies(res);
    if (next) this.cookie = this.cookie ? `${this.cookie}; ${next}` : next;
    await res.text().catch(() => {});
  }

  // TODO(verify): 登录。reactive 验证码：先无票发一次，网关回 GATEWAY_WRONG_CAPTCHA
  // 才需要 ticket + randStr（腾讯防水墙 TencentCaptcha("194593025") 的票）。
  async login({ user, password, ticket = '', randStr = '' }) {
    const isEmail = user.includes('@');
    const body = {
      ...(isEmail ? { email: user } : { phone: user }),
      password,
      rememberMe: true,
      ticket,
      randStr,
    };
    const data = await this.request('/api/users/sessions', { method: 'POST', body, base: PASSPORT });
    return data;
  }

  // TODO(verify): 会话复用判定。有效直接复用，避免重复登录触发风控。
  // 注意：u/current 在 passport 域名下，不在 pintia.cn 下（之前写错过）。
  async current() {
    return this.request('/api/u/current', { base: PASSPORT });
  }

  // TODO(verify): 题目集列表，含 examIdByProblemSetId。
  // onlyAlive：只返回未截止的题集（kisaki get_exam_id 的做法：filter 用
  // URLSearchParams 编码，勿手写 quote）。
  async problemSets({ limit = 20, onlyAlive = false } = {}) {
    const params = new URLSearchParams({ limit: String(limit), order_by: 'END_AT', asc: 'true' });
    if (onlyAlive) params.set('filter', JSON.stringify({ endAtAfter: new Date().toISOString() }));
    return this.request(`/api/problem-sets?${params}`);
  }

  // TODO(verify)
  async exams(psid) {
    return this.request(`/api/problem-sets/${psid}/exams`);
  }

  // 无 exam 时自动建一个（vscode-pintia 的 createProblemSetExam：POST 空 body 再 GET）。
  // MY_PROBLEM_SET 个人题集不自动建 —— 调用方（run.mjs）在建之前先判类型。
  async createExam(psid) {
    return this.request(`/api/problem-sets/${psid}/exams`, { method: 'POST', body: {} });
  }

  // 题集的编译器列表（vscode-pintia 的 getProblemSetCompilers）：
  // problemSet.problemSetConfig.compilers，题面无 compiler 时作回退。取不到返回 []。
  async compilers(psid) {
    try {
      const data = await this.problemSets({ limit: 100 });
      const list = data?.problemSets || data?.problem_sets || [];
      const set = list.find((s) => s.id === psid || s.problemSetId === psid);
      const cs = set?.problemSetConfig?.compilers || set?.problem_set_config?.compilers || [];
      return Array.isArray(cs) ? cs : [];
    } catch {
      return [];
    }
  }

  // TODO(verify): 各题型题量与总分。
  async problemSummaries(psid) {
    return this.request(`/api/problem-sets/${psid}/problem-summaries`);
  }

  // TODO(verify): 题目列表。注意 id = 提交用的 problemSetProblemId，
  // 该数组里 problemSetProblemId 字段为 null、problemId 是另一套题库 ID，别混。
  async examProblems(psid, { examId = '', problemType = '' } = {}) {
    const q = new URLSearchParams({ ...(examId ? { exam_id: examId } : {}), ...(problemType ? { problem_type: problemType } : {}) });
    return this.request(`/api/problem-sets/${psid}/exam-problems?${q}`);
  }

  // TODO(verify): 学生视角每题状态 —— 可视化的数据源。
  async problemStatus(examId, psid) {
    return this.request(`/api/exams/${examId}/problem-sets/${psid}/problem-status`);
  }

  // TODO(verify): 最近提交（提交响应里没给 submissionId 时用它找）。
  async lastSubmissions(examId, psid, problemType = '') {
    const q = problemType ? `?problemType=${problemType}` : '';
    return this.request(`/api/exams/${examId}/problem-sets/${psid}/last-submissions${q}`);
  }

  // TODO(verify): 判题详情，含 testcaseJudgeResults。
  // customTest：取自定义测试提交的结果（?custom_test_data_submission=true）。
  async submissionDetail(examId, submissionId, { customTest = false } = {}) {
    const q = customTest ? '?custom_test_data_submission=true' : '';
    return this.request(`/api/exams/${examId}/submissions/${submissionId}${q}`);
  }

  // 轮询判题：直到返回里出现 testcaseJudgeResults 或状态不再是 JUDGING/PROCESSING，
  // 或达到次数上限。返回最后一次响应 + judged 标志。
  // 间隔 1 秒：编程题判题约 1 秒出结果，WAITING 最多再等 2×1 秒（PTA-mcp 实测）；
  // 上限 60 次 × 1 秒 = 60 秒（vscode-pintia 的 TEST_POLL_MAX_ATTEMPTS=60，
  // 有界轮询，不用 setInterval，用 for 循环 + sleep）。
  // 终态条件（vscode-pintia 的 isJudgingFinished）：queued === -1 且状态不是
  // WAITING/JUDGING，或出现判题结果，或状态为终态。
  async pollSubmission(examId, submissionId, { tries = 60, intervalMs = 1000, customTest = false } = {}) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      last = await this.submissionDetail(examId, submissionId, { customTest });
      const results = extractJudgeResults(last);
      const status = String(last?.status || '').toUpperCase();
      const done = results.length > 0
        || ['DONE', 'JUDGED', 'ACCEPTED', 'WRONG_ANSWER', 'PARTIAL_ACCEPTED'].includes(status)
        || (last?.queued === -1 && !['WAITING', 'JUDGING'].includes(status));
      if (done) return { judged: true, detail: last };
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { judged: false, detail: last };
  }

  // TODO(verify): 提交。客观题整卷 upsert（按题型一次全交），编程题逐题。
  // details[i] = { problemId:"0", problemSetProblemId:<exam-problems[].id>, <detailKey>:{...} }
  // customTestData（vscode-pintia）：把样例发服务端判，本地无编译器时先验。
  // 附在第一个编程类 detail 上：{ hasCustomTestData: true, content: "<输入>\n" }。
  async submit(examId, problemType, details, { customTestData = null } = {}) {
    if (customTestData != null) {
      const d = details.find((x) => x.programmingSubmissionDetail || x.codeCompletionSubmissionDetail);
      if (d) {
        const key = d.programmingSubmissionDetail ? 'programmingSubmissionDetail' : 'codeCompletionSubmissionDetail';
        d[key].customTestData = { hasCustomTestData: true, content: `${customTestData}\n` };
      }
    }
    return this.request(`/api/exams/${examId}/exam-submissions`, {
      method: 'POST',
      body: { problemType, details },
    });
  }

  // TODO(verify): 交卷（触发客观题判题）。
  async endExam(examId) {
    return this.request(`/api/exams/${examId}/end`, { method: 'PUT' });
  }
}
