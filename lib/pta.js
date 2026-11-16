/**
 * PTA（pintia.cn）HTTP 客户端与题型工具。
 *
 * 只负责“手”：签名请求、拉题、提交、轮询判题。所有请求都带 `Cookie: PTASession=…`，
 * 该值由调用方（service）从 DSH 凭据服务取，绝不写入日志或返回给模型。
 */

const BASE = 'https://pintia.cn';
const PASSPORT = 'https://passport.pintia.cn';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Accept: 'application/json;charset=UTF-8',
  'Content-Type': 'application/json;charset=UTF-8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Origin: BASE,
  Referer: BASE + '/',
};

/** 题型 → 提交 details 里的字段名。 */
export const DETAIL = {
  TRUE_OR_FALSE: 'trueOrFalseSubmissionDetail',
  MULTIPLE_CHOICE: 'multipleChoiceSubmissionDetail',
  MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER: 'multipleChoiceMoreThanOneAnswerSubmissionDetail',
  FILL_IN_THE_BLANK: 'fillInTheBlankSubmissionDetail',
  FILL_IN_THE_BLANK_FOR_PROGRAMMING: 'fillInTheBlankForProgrammingSubmissionDetail',
  CHOICE_BLANK: 'choiceBlankSubmissionDetail',
  PROGRAMMING: 'programmingSubmissionDetail',
  CODE_COMPLETION: 'codeCompletionSubmissionDetail',
  SQL_PROGRAMMING: 'sqlProgrammingSubmissionDetail',
};

export const CODE_TYPES = new Set(['PROGRAMMING', 'CODE_COMPLETION', 'SQL_PROGRAMMING']);
/** 模板/挖空信息只在单题接口里，拉题时要补一次详情。 */
export const NEED_DETAIL = new Set([...CODE_TYPES, 'FILL_IN_THE_BLANK_FOR_PROGRAMMING', 'CHOICE_BLANK']);

/**
 * 限时考试 / 监考类题目集识别（红线：这类题集不自动做）。
 * PTA 的题目集对象里，考试类会带 type 含 EXAM、或带时长限制 / 监考字段；字段缺失时按普通作业处理。
 */
export function isExamSet(row) {
  if (!row || typeof row !== 'object') return false;
  const type = String(row.type ?? '').toUpperCase();
  if (type.includes('EXAM') || type.includes('CONTEST')) return true;
  const duration = Number(row.timeLimit ?? row.duration ?? row.examDuration ?? 0);
  if (Number.isFinite(duration) && duration > 0) return true;
  return Boolean(row.proctoring || row.oms || row.omsEnabled || row.monitor);
}

export class PtaError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

/** 把可能混进文本里的 Cookie 抹掉（双保险）。 */
export function redact(text) {
  return String(text ?? '')
    .replace(/PTASession=[^;\s"']+/giu, 'PTASession=***')
    .replace(/Cookie:\s*[^\r\n]+/giu, 'Cookie: ***');
}

function decoder() {
  return new TextDecoder('utf-8');
}

export function createPta({ cookie, fetchImpl = fetch }) {
  if (typeof cookie !== 'string' || cookie === '') throw new PtaError('auth_required', '账号没有可用的 PTASession。');

  async function request(method, path, { query, body, base = BASE } = {}) {
    const url = new URL(path, base);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    let response;
    const headers = { ...HEADERS, Cookie: `PTASession=${cookie}` };
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'follow',
      });
    } catch (error) {
      throw new PtaError('unavailable', `网络不通：${redact(error?.message ?? error)}`);
    }
    const type = response.headers.get('content-type') ?? '';
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (response.status !== 200 || !type.includes('json') || json === undefined) {
      const code = json?.error?.code;
      if (code === 'USER_NOT_FOUND' || code === 'NOT_LOGGED_IN' || response.status === 401 || response.status === 403) {
        throw new PtaError('auth_required', 'PTA 登录已失效，请重新录入该账号的 PTASession。');
      }
      if (response.status === 429) throw new PtaError('rate_limited', 'PTA 限流了，稍等一会儿再试。');
      throw new PtaError('platform_error', `PTA 返回 HTTP ${response.status}${code ? ` ${code}` : ''}：${redact(text).slice(0, 200)}`);
    }
    return json;
  }

  const api = {
    me: async () => {
      const data = await request('GET', '/api/u/current', { base: PASSPORT });
      const user = data?.user;
      if (!user) throw new PtaError('auth_required', 'PTA 登录已失效（passport 未返回用户）。');
      return { nickname: user.nickname ?? '', email: user.email ?? user.phone ?? '', uid: String(user.id ?? '') };
    },
    sets: async ({ all = false } = {}) => {
      const filter = all ? '' : JSON.stringify({ endAtAfter: new Date().toISOString().slice(0, 19) + '.000Z' });
      const data = await request('GET', '/api/problem-sets', {
        query: { filter, limit: 100, order_by: 'END_AT', asc: 'true' },
      });
      return (data.problemSets ?? []).map((row) => ({
        id: row.id,
        name: row.name ?? '',
        endAt: row.endAt ?? '',
        beginAt: row.beginAt ?? '',
        type: String(row.type ?? ''),
        exam: isExamSet(row),
      }));
    },
    examId: async (psid) => {
      let data = await request('GET', `/api/problem-sets/${psid}/exams`);
      if (!data.exam) {
        data = await request('POST', `/api/problem-sets/${psid}/exams`, { body: {} });
        if (!data.exam) data = await request('GET', `/api/problem-sets/${psid}/exams`);
      }
      if (!data.exam) throw new PtaError('not_started', `题目集 ${psid} 打不开练习（可能未开始、已结束或没有权限）。`);
      return data.exam.id;
    },
    summaries: async (psid) => (await request('GET', `/api/problem-sets/${psid}/problem-summaries`)).summaries ?? {},
    problemList: async (psid, examId, type) => {
      const out = [];
      for (let page = 0; page < 20; page += 1) {
        const data = await request('GET', `/api/problem-sets/${psid}/exam-problem-list`, {
          query: { exam_id: examId, problem_type: type, page, limit: 100 },
        });
        const items = data.problemSetProblems ?? [];
        out.push(...items);
        if (items.length < 100) break;
      }
      return out;
    },
    problemDetail: async (psid, pid, examId) => {
      const data = await request('GET', `/api/problem-sets/${psid}/exam-problems/${pid}`, { query: { exam_id: examId } });
      return data.problemSetProblem ?? data;
    },
    problemStatus: async (psid, examId) =>
      (await request('GET', `/api/exams/${examId}/problem-sets/${psid}/problem-status`)).problemStatus ?? [],
    submit: async (examId, body) => request('POST', `/api/exams/${examId}/exam-submissions`, { body }),
    submission: async (examId, sid) => (await request('GET', `/api/exams/${examId}/submissions/${sid}`)).submission ?? {},
  };
  return api;
}

/** 列表项补详情：代码类题型、或缺正文时。 */
export async function hydrateProblem(pt, psid, examId, item, type) {
  let full = item;
  if (NEED_DETAIL.has(type) || !item.content) {
    try {
      const detail = await pt.problemDetail(psid, item.id, examId);
      full = { ...item, ...Object.fromEntries(Object.entries(detail).filter(([, v]) => v !== '' && v !== null && v !== undefined)) };
    } catch {
      full = item;
    }
  }
  let choices = null;
  for (const value of Object.values(full.problemConfig ?? {})) {
    if (value && typeof value === 'object' && Array.isArray(value.choices)) choices = value.choices;
  }
  return {
    id: full.id,
    label: full.label ?? '',
    title: full.title ?? '',
    type,
    score: full.score ?? 0,
    compiler: full.compiler ?? '',
    content: full.content ?? '',
    description: full.description ?? '',
    choices,
    config: full.problemConfig ?? null,
  };
}

export function flatten(text, max) {
  const value = String(text ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/[`*_#>]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return max ? value.slice(0, max) : value;
}

export function briefLine(problem, max = 400) {
  let line = `${problem.id} | ${problem.type} | ${problem.label || '-'} | ${problem.score}分 | ${problem.title} | ${flatten(problem.content, max)}`;
  if (problem.description) line += ` | TM:${flatten(problem.description, max)}`;
  if (Array.isArray(problem.choices)) {
    line += ' || ' + problem.choices
      .map((choice) => `${choice.label})${flatten(choice.content ?? choice.title ?? '', 80)}`)
      .join(' ');
  }
  return line;
}

/** 与 pta.py / pta-homework Skill 保持一致的待办判定。 */
export function todoIds(rows) {
  return rows
    .filter((row) => ['PROBLEM_NO_ANSWER', 'PROBLEM_WRONG_ANSWER', 'PARTIAL_ACCEPTED'].includes(row.problemSubmissionStatus) ||
      (CODE_TYPES.has(row.problemType) && row.problemSubmissionStatus !== 'PROBLEM_ACCEPTED'))
    .map((row) => row.id);
}

export function sampleCases(content) {
  const text = String(content ?? '');
  const ins = [];
  const outs = [];
  const re = /###\s*(输入样例|输出样例|Sample Input|Sample Output)[^\n]*\n+```[^\n]*\n(.*?)```/gsu;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match[1].includes('输入') || match[1].includes('Input')) ins.push(match[2]);
    else outs.push(match[2]);
  }
  return ins.map((input, index) => ({ input, output: outs[index] ?? '' }));
}

/** 从 Set-Cookie 里抠出 PTASession。 */
function extractSessionCookie(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter((value) => typeof value === 'string');
  const match = /PTASession=([^;\r\n]+)/u.exec(values.join('\n'));
  return match ? decodeURIComponent(match[1]) : undefined;
}

/**
 * 账号密码直登（不存密码，只留登录后的 PTASession）。
 * PTA 是「reactive 验证码」：先发无票请求，网关要求时才回 GATEWAY_WRONG_CAPTCHA。
 * 要求验证码时抛 captcha_required，由面板提示改用「粘贴 Cookie」。
 */
export async function passwordLogin({ login, password, ticket, randStr, fetchImpl = fetch }) {
  const account = String(login ?? '').trim();
  const secret = String(password ?? '');
  if (account === '' || secret === '') throw new PtaError('invalid_input', '账号和密码都要填。');
  if (account.length > 254 || secret.length > 1024) throw new PtaError('invalid_input', '账号或密码过长。');
  const isEmail = account.includes('@');
  const digits = account.replace(/\D/gu, '');
  // PTA 对手机号的格式敏感（有的账号要带 +86）：同一份密码按候选格式依次重试。
  const candidates = isEmail ? [account] : [...new Set([
    account,
    digits.length === 11 ? `+86${digits}` : '',
    digits.length === 13 && digits.startsWith('86') ? `+${digits}` : '',
  ].filter(Boolean))];
  let lastError;
  for (const candidate of candidates) {
    try {
      return await passwordLoginOnce({ account: candidate, isEmail, password: secret, ticket, randStr, fetchImpl });
    } catch (error) {
      lastError = error;
      if (error?.code !== 'invalid_credentials') throw error;
    }
  }
  throw lastError;
}

async function passwordLoginOnce({ account, isEmail, password, ticket, randStr, fetchImpl = fetch }) {
  const body = { [isEmail ? 'email' : 'phone']: account, password, rememberMe: true };
  if (ticket) {
    body.ticket = String(ticket);
    body.randStr = String(randStr ?? '');
  }
  let response;
  try {
    response = await fetchImpl('https://passport.pintia.cn/api/users/sessions', {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'follow',
    });
  } catch (error) {
    throw new PtaError('unavailable', `网络不通：${redact(error?.message ?? error)}`);
  }
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const code = json?.error?.code;
  if (code === 'GATEWAY_WRONG_CAPTCHA' || code === 'CAPTCHA_REQUIRED') {
    throw new PtaError('captcha_required', 'PTA 这次要求滑块验证码，密码直登过不去。请在面板切到「粘贴 Cookie」登录一次。');
  }
  if (code === 'USER_NOT_FOUND') throw new PtaError('invalid_credentials', 'PTA 说这个账号不存在，检查邮箱/手机号。');
  if (response.status === 401 || code === 'WRONG_PASSWORD' || code === 'INVALID_PASSWORD') {
    throw new PtaError('invalid_credentials', '密码不对，或账号被风控。');
  }
  if (response.status !== 200 || json === undefined) {
    throw new PtaError('platform_error', `PTA 登录返回 HTTP ${response.status}${code ? ` ${code}` : ''}：${redact(text).slice(0, 160)}`);
  }
  const cookie = extractSessionCookie(response);
  if (!cookie) {
    throw new PtaError('captcha_required', 'PTA 没有下发 PTASession（大概率要验证码）。请在面板切到「粘贴 Cookie」登录一次。');
  }
  return { cookie, user: json.user ?? null };
}

