// 拟人化节律：所有等待都是真实 sleep（setTimeout），不空转假装。
// 模型（按 RESEARCH.md §3 的实证参数，来源见该报告；
// “平台真在查时序”这一点未验证——先做便宜的节律层，不上浏览器行为层）：
//   - 间隔不用均匀分布：均匀延迟在统计图上是矩形，一眼识破；
//     人类延迟是对数正态 / 长尾分布，80% 转移快、20% 长停顿。
//   - 读题按题面长度建模：中文默读 300 字/分（保守基准，各口径 250–500 不一），
//     编程题难度系数 1.5–2.5（代码+样例要反复看），客观题 1.0，
//     再叠加 lognormal(0, 0.3) 抖动 + 1–2 次“回读”停顿（2–5 秒）。
//   - 粘贴改分段打字：整段粘贴（Δt ≈ 0、无击键）是最容易被记录的特征；
//     代码按字符逐段“打”进去——击键间隔 lognormal(mean=4.2, sigma=0.5)ms
//     截断到 28–400ms，约 4% 概率附加 400–1400ms 分心停顿。
//     （API 路线实际不产生击键事件，这里只是让“提交前等待”
//     的时长分布接近真人打字，而不是一个固定秒数。）
//   - 题间间隔用指数分布（泊松过程），不是固定秒数；
//     两次提交之间仍至少间隔 15 秒（硬性下限）。
// 档位：slow（×1.6，慢慢做）、normal（×1.0）、fast（×0.05，
// 仅用于 mock 测试，仍是真 sleep，只是短）。

export const PROFILES = {
  slow: { mult: 1.6, minGapMs: 20000 },
  normal: { mult: 1.0, minGapMs: 15000 },
  fast: { mult: 0.05, minGapMs: 15000 },
};

export function profile(name = 'normal') {
  return PROFILES[name] || PROFILES.normal;
}

// Box-Muller 采正态分布。
export function sampleNormal(mu = 0, sigma = 1) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mu + sigma * z;
}

// 对数正态采样，可选截断到 [min, max]。
export function sampleLognormal(mu, sigma, min = -Infinity, max = Infinity) {
  const v = Math.exp(sampleNormal(mu, sigma));
  return Math.min(max, Math.max(min, v));
}

// 指数分布采样（均值 meanMs）：题间到达间隔用。
export function sampleExp(meanMs) {
  return -meanMs * Math.log(1 - Math.random());
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 读题时间：字符数 / 300 字每分 × 难度系数 × lognormal(0, 0.3)，
// 再加 1–2 次回读停顿（2–5 秒）。客观题下限 20 秒、上限 3 分钟；
// 编程题下限 3 分钟、上限 10 分钟。
export function readTimeMs(text = '', type = '', prof = profile('normal')) {
  const chars = String(text || '').replace(/\s+/g, '').length;
  const isProg = /PROGRAMMING|CODE|SQL/i.test(type);
  const cpm = 300; // 中文默读基准：300 字/分
  const difficulty = isProg ? 2.0 : 1.0; // 编程题 1.5–2.5，取中值
  const seconds = (chars / cpm) * 60 * difficulty * Math.exp(sampleNormal(0, 0.3));
  const base = isProg
    ? Math.min(600000, Math.max(180000, seconds * 1000))
    : Math.min(180000, Math.max(20000, seconds * 1000));
  // 1–2 次回读停顿（2–5 秒）。
  const rereads = 1 + (Math.random() < 0.5 ? 1 : 0);
  let extra = 0;
  for (let i = 0; i < rereads; i++) extra += 2000 + Math.random() * 3000;
  return Math.round((base + extra) * prof.mult);
}

// 分段打字耗时：按代码字符数模拟逐字输入。
// 击键间隔 lognormal(4.2, 0.5)ms 截断 28–400ms；
// 约 4% 概率每字符附加 400–1400ms 分心停顿；总长封顶 10 分钟。
// 代码为空（客观题）时退回 2–8 秒的“填答案”延迟。
export function typingDelayMs(code = '', prof = profile('normal')) {
  const text = String(code || '');
  if (!text.length) {
    return Math.round((2000 + Math.random() * 6000) * prof.mult);
  }
  let ms = 0;
  for (let i = 0; i < text.length; i++) {
    ms += sampleLognormal(4.2, 0.5, 28, 400);
    if (Math.random() < 0.04) ms += 400 + Math.random() * 1000;
  }
  return Math.round(Math.min(600000, ms) * prof.mult);
}

// 提交前停顿：打完检查一遍再点提交，3–10 秒（对数正态采样）。
export function preSubmitPauseMs(prof = profile('normal')) {
  return Math.round(sampleLognormal(Math.log(6000), 0.5, 3000, 10000) * prof.mult);
}

export class Pacer {
  // profile 可以是档位名（'slow'|'normal'|'fast'），也可以是一个返回档位名的
  // 函数 —— 面板“节律档位切换”就靠这个在运行中换档。
  constructor(profileNameOrGetter = 'normal', log = () => {}) {
    this.profile = profileNameOrGetter;
    this.log = log;
    this.lastSubmitAt = 0;
  }

  currentProfile() {
    const name = typeof this.profile === 'function' ? this.profile() : this.profile;
    return profile(name);
  }

  // 运行中换档（面板调 /api/pace 时用）。
  setProfile(name) {
    this.profile = name;
  }

  // 读题：真等，返回实际等待毫秒。
  async waitRead(text, type, label = '') {
    const ms = readTimeMs(text, type, this.currentProfile());
    this.log(`pace: read ${label} ${Math.round(ms / 1000)}s`);
    await sleep(ms);
    return ms;
  }

  // 分段打字 + 提交前停顿。code 给代码时按打字时长等，客观题传 ''。
  async waitBeforeSubmit(label = '', code = '') {
    const prof = this.currentProfile();
    const typing = typingDelayMs(code, prof);
    this.log(`pace: typing ${label} ${Math.round(typing / 1000)}s`);
    await sleep(typing);
    const pause = preSubmitPauseMs(prof);
    this.log(`pace: pre-submit pause ${label} ${Math.round(pause / 1000)}s`);
    await sleep(pause);
    return typing + pause;
  }

  // 两次提交之间至少间隔 minGapMs（默认 15 秒），再叠加一次指数分布的
  // 到达间隔（均值 20 秒），不足就补等。
  async waitGap(label = '') {
    const now = Date.now();
    const prof = this.currentProfile();
    const gap = prof.minGapMs + sampleExp(20000) * prof.mult;
    const elapsed = now - this.lastSubmitAt;
    if (this.lastSubmitAt && elapsed < gap) {
      const wait = Math.round(gap - elapsed);
      this.log(`pace: gap ${label} ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }

  markSubmitted() {
    this.lastSubmitAt = Date.now();
  }
}
