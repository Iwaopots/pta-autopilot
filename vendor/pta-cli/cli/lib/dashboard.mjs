// 看板数据与渲染：读 state.json + 账号表 + 审计日志尾巴，拼成快照；
// serve 用同一份快照做 JSON API，静态 dashboard 命令用它生成 dashboard.html。
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as store from './store.mjs';

const STAGE_LABEL = {
  idle: '待开始', fetching: '拉题中', solving: '解题中', submitting: '提交中',
  judging: '判题中', done: '完成', blocked: '卡住', refused: '已拒绝', failed: '失败', todo: '待做',
  solved: '已解出', submitted: '已提交', 'low-confidence': '低置信待人工',
};

const STATUS_COLOR = {
  PROBLEM_NO_ANSWER: '#9ca3af',
  PROBLEM_SUBMITTED: '#3b82f6',
  PROBLEM_ACCEPTED: '#22c55e',
  PROBLEM_WRONG_ANSWER: '#ef4444',
  PARTIAL_ACCEPTED: '#eab308',
};

export function buildSnapshot() {
  const state = store.readState();
  const accounts = store.loadAccounts();
  const activeAccountId = store.getActiveAccountId();
  const out = { updatedAt: state.updatedAt || '', accounts: [], activeAccountId };
  // 待复核队列（只取当前账号；无当前账号时取全部）：验收/返工闭环的读模型。
  const allReview = store.getReviewItems(activeAccountId || '');
  out.review = {
    pending: allReview.filter((r) => r.status === 'pending'),
    rework: allReview.filter((r) => r.status === 'rework'),
    counts: {
      pending: allReview.filter((r) => r.status === 'pending').length,
      rework: allReview.filter((r) => r.status === 'rework').length,
      accepted: allReview.filter((r) => r.status === 'accepted').length,
      exhausted: allReview.filter((r) => r.status === 'exhausted').length,
    },
  };
  for (const a of accounts) {
    const accState = state.accounts[a.id] || { sets: {} };
    const sets = [];
    for (const [psid, s] of Object.entries(accState.sets || {})) {
      const problems = Object.entries(s.problems || {}).map(([pid, p]) => ({
        id: pid, type: p.type || '', score: p.score ?? 0,
        status: p.status || 'PROBLEM_NO_ANSWER', stage: p.stage || 'todo',
        lastAction: p.lastAction || '', lastAt: p.lastAt || '',
      }));
      sets.push({
        psid, name: s.name || psid, stage: s.stage || 'idle',
        total: s.total ?? problems.length,
        accepted: s.accepted ?? problems.filter((p) => p.status === 'PROBLEM_ACCEPTED').length,
        failed: s.failed ?? 0, problems,
      });
    }
    // 还没进 state.json 的题集（只有进度缓存的）也列出来。
    try {
      const dir = join(store.accountDir(a.id), 'progress');
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'audit.jsonl')) {
        const psid = f.replace('.json', '');
        if (sets.some((s) => s.psid === psid)) continue;
        const c = store.readProgress(a.id, psid);
        const items = c?.data?.problemStatus || c?.data?.status || [];
        sets.push({
          psid, name: psid, stage: 'idle', total: items.length,
          accepted: items.filter((i) => (i.status || i.problemStatus) === 'PROBLEM_ACCEPTED').length,
          failed: 0,
          problems: items.map((i) => ({
            id: i.problemSetProblemId || i.id, type: '', score: 0,
            status: i.status || i.problemStatus || 'PROBLEM_NO_ANSWER', stage: 'todo',
            lastAction: '', lastAt: c?.fetchedAt || '',
          })),
        });
      }
    } catch { /* no progress cache yet */ }
    out.accounts.push({
      id: a.id, label: a.label, loginMasked: a.loginMasked, status: a.status,
      sets, audit: store.readAudit(a.id, 20),
    });
  }
  return out;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderReportMarkdown(snapshot, account) {
  const acc = snapshot.accounts.find((a) => a.id === account.id) || { sets: [], audit: [] };
  const lines = [`# PTA 作业报告 — ${account.label}（${account.loginMasked}）`, '', `生成时间：${new Date().toLocaleString('zh-CN')}`, ''];
  for (const s of acc.sets) {
    lines.push(`## ${s.name}（${s.psid}）`, '', `- 阶段：${STAGE_LABEL[s.stage] || s.stage}；进度：${s.accepted}/${s.total} 通过；失败 ${s.failed} 题`, '');
    for (const p of s.problems) {
      lines.push(`- ${p.id} [${p.type}] ${p.score}分 — ${p.status}（${STAGE_LABEL[p.stage] || p.stage}）${p.lastAction ? `，最后动作 ${p.lastAction} ${p.lastAt}` : ''}`);
    }
    lines.push('');
  }
  lines.push('## 最近审计日志', '');
  for (const e of acc.audit.slice(-50)) {
    lines.push(`- ${e.ts} ${e.action} ${e.psid || ''} ${e.problemId || ''} ${e.verdict || e.reason || ''}`);
  }
  return lines.join('\n');
}

export function renderDashboardHTML(snapshot, { live = false, job = null, registry = null } = {}) {
  const reg = registry || { groups: [], actions: [] };
  const actionZone = live ? `
<style>body.readonly .write-action{display:none}</style>
<section style="border:2px solid #2563eb;border-radius:8px;padding:12px;margin:12px 0;background:#eff6ff">
<h2 style="margin-top:0">控制台（面板驱动：点按钮就跑，不用再跟模型对话）</h2>
<div id="jobBanner" style="margin-bottom:10px;font-weight:bold">${job ? `任务 ${esc(job.id)}：${esc(job.status)}（${esc(job.accountLabel)} / ${esc(job.problemSet)}）` : '当前没有运行中的任务'}</div>
<pre id="jobLog" style="background:#111;color:#0f0;padding:8px;max-height:160px;overflow:auto;font-size:12px">${job ? esc((job.log || []).slice(-30).join('\n')) : ''}</pre>
<fieldset style="margin:10px 0"><legend>登录（密码只进内存，不写文件、不记日志）</legend>
<input id="loginUser" placeholder="邮箱或手机号" style="width:200px">
<input id="loginPass" type="password" placeholder="密码" style="width:160px">
<input id="loginLabel" placeholder="备注名（可选）" style="width:120px">
<label><input id="loginRemember" type="checkbox"> 记住凭据引用（只存 key，不存密码）</label>
</fieldset>
<fieldset style="margin:10px 0"><legend>账号 / 题集 / 节律</legend>
账号 <select id="runAccount">${snapshot.accounts.map((a) => `<option value="${esc(a.id)}" ${snapshot.activeAccountId === a.id ? 'selected' : ''}>${esc(a.label)}（${esc(a.loginMasked)}）</option>`).join('')}</select>
题集 <select id="runSet"><option value="">（先选账号，再选题集）</option></select>
节律 <select id="runPace"><option value="normal">正常</option><option value="slow">慢速</option><option value="fast">快速（测试用）</option></select>
单题重做题号 <input id="retryProblemId" placeholder="如 P5" style="width:80px">
待复核题 <select id="reviewKey">${[...(snapshot.review?.pending || []), ...(snapshot.review?.rework || [])].map((r) => `<option value="${esc(r.key)}">${esc(r.pspId)}（${esc(r.psid)}，${esc(r.reason)}，返工 ${r.reworkCount || 0}/5）</option>`).join('') || '<option value="">（暂无待复核）</option>'}</select>
</fieldset>
<fieldset style="margin:10px 0"><legend>设置（重试次数、DS 模型）</legend>
重试次数 <input id="setMaxFixes" type="number" min="0" max="5" value="${snapshot.settings?.maxFixes ?? 3}" style="width:60px">
DS 模型 <input id="setModel" placeholder="默认 deepseek-chat" value="${esc(snapshot.settings?.model || '')}" style="width:180px">
</fieldset>
<div id="actionGrid"></div>
<p><span id="actionMsg" style="font-weight:bold"></span></p>
<pre id="actionOutput" style="background:#f8f8f8;padding:8px;max-height:240px;overflow:auto;font-size:12px;white-space:pre-wrap"></pre>
<script>
window.__REGISTRY__ = ${JSON.stringify(reg)};
window.__jobRunning = ${job && (job.status === 'running' || job.status === 'paused') ? 'true' : 'false'};
function escHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
function collectParams(action) {
  const p = { ...(action.defaults || {}) };
  const acc = document.getElementById('runAccount');
  if (acc) p.account = acc.value;
  if (action.form === 'login') {
    p.user = document.getElementById('loginUser').value;
    p.password = document.getElementById('loginPass').value;
    p.label = document.getElementById('loginLabel').value;
    p.remember = document.getElementById('loginRemember').checked;
  }
  if (action.form === 'run') {
    p.problemSet = document.getElementById('runSet').value;
    p.pace = document.getElementById('runPace').value;
  }
  if (action.form === 'retryOne') {
    p.problemSet = document.getElementById('runSet').value;
    p.pace = document.getElementById('runPace').value;
    p.onlyProblem = document.getElementById('retryProblemId').value.trim();
  }
  if (action.form === 'settings') {
    p.maxFixes = Number(document.getElementById('setMaxFixes').value);
    p.model = document.getElementById('setModel').value.trim();
    p.pace = document.getElementById('runPace').value;
  }
  if (action.form === 'review') {
    p.key = document.getElementById('reviewKey').value;
  }
  return p;
}
async function runAction(action) {
  const msg = document.getElementById('actionMsg');
  const out = document.getElementById('actionOutput');
  // 纯前端动作（不调服务端）：复制配置、只读开关。
  if (action.clientOnly) {
    if (action.id === 'manage.copyConfig') {
      const p = collectParams(action);
      const cfg = { account: p.account, problemSet: p.problemSet, pace: p.pace, maxFixes: Number(document.getElementById('setMaxFixes').value), model: document.getElementById('setModel').value.trim() };
      await navigator.clipboard.writeText(JSON.stringify(cfg, null, 2));
      msg.textContent = '任务配置已复制到剪贴板';
      out.textContent = JSON.stringify(cfg, null, 2);
      return;
    }
    if (action.id === 'manage.readonly') {
      const on = document.body.classList.toggle('readonly');
      msg.textContent = on ? '只读模式已开：写按钮已隐藏，再点一次恢复' : '只读模式已关：写按钮已恢复';
      return;
    }
  }
  if (action.confirm && !confirm(action.confirm)) return;
  if (!action.allowedWhileRunning && window.__jobRunning) { msg.textContent = '任务运行中，这个动作现在不能点'; return; }
  const params = collectParams(action);
  if (action.form === 'login' && (!params.user || !params.password)) { msg.textContent = '请先填账号和密码'; return; }
  if (action.form === 'retryOne' && !params.onlyProblem) { msg.textContent = '请先填要重做的题号'; return; }
  if (action.form === 'review' && !params.key) { msg.textContent = '请先选一道待复核的题'; return; }
  if ((action.form === 'run' || action.form === 'retryOne') && action.endpoint !== '/api/account/ping' && !params.problemSet && ['/api/run', '/api/refresh', '/api/problems', '/api/report', '/api/audit', '/api/audit/download', '/api/cache/clear', '/api/problem', '/api/problem/skip'].includes(action.endpoint)) { msg.textContent = '请先选一个题集'; return; }
  msg.textContent = '执行中…';
  try {
    if (action.method === 'GET') {
      if (action.endpoint === '/api/report' || action.endpoint === '/api/audit/download') {
        const q = new URLSearchParams({ account: params.account || '' }).toString();
        location.href = action.endpoint + '?' + q;
        msg.textContent = '开始下载…';
        return;
      }
      const q = new URLSearchParams();
      if (params.account) q.set('account', params.account);
      if (params.psid) q.set('psid', params.psid);
      if (params.problemSet) q.set('psid', params.problemSet);
      if (params.onlyProblem) q.set('problem', params.onlyProblem);
      if (params.limit) q.set('limit', params.limit);
      const r = await fetch(action.endpoint + '?' + q.toString()).then((x) => x.json());
      msg.textContent = r.ok === false ? ('失败：' + (r.error || '')) : (action.name + '完成');
      out.textContent = JSON.stringify(r, null, 2).slice(0, 4000);
    } else {
      if (action.endpoint === '/api/cache/clear' || action.endpoint === '/api/account/delete') params.confirm = true;
      // 一次用户意图一个幂等键：防双击 / 重连重投递导致任务建两次。
      if (action.endpoint === '/api/run') params.idempotencyKey = crypto.randomUUID();
      if (action.endpoint === '/api/problem/skip') params.problem = params.onlyProblem;
      const r = await api('POST', action.endpoint, params);
      msg.textContent = r.ok === false ? ('失败：' + (r.error || '')) : (action.name + '完成' + (r.jobId ? ('，任务 ' + r.jobId) : ''));
      if (action.id === 'account.login' || action.id === 'account.add') document.getElementById('loginPass').value = '';
      if (r.ok && (action.id === 'account.login' || action.id === 'account.add' || action.id === 'account.switch' || action.id === 'account.toggle' || action.id === 'account.delete')) setTimeout(() => location.reload(), 800);
      if (r.ok && r.jobId) window.__jobRunning = true;
      if (r.ok && (action.id === 'set.pause' || action.id === 'set.resume' || action.id === 'set.stop')) setTimeout(() => location.reload(), 1200);
    }
  } catch (e) {
    msg.textContent = '请求失败：' + e.message;
  }
}
(function renderActions() {
  const grid = document.getElementById('actionGrid');
  for (const g of window.__REGISTRY__.groups) {
    const acts = window.__REGISTRY__.actions.filter((a) => a.group === g.id);
    if (!acts.length) continue;
    const fs = document.createElement('fieldset');
    fs.style.margin = '10px 0';
    fs.innerHTML = '<legend>' + escHtml(g.name) + '</legend>';
    for (const a of acts) {
      const b = document.createElement('button');
      b.textContent = a.icon + ' ' + a.name;
      b.title = a.hint || '';
      b.style.margin = '2px';
      if (a.method === 'POST') b.classList.add('write-action'); // 只读模式开关隐藏它
      b.onclick = () => runAction(a);
      fs.appendChild(b);
    }
    grid.appendChild(fs);
  }
})();
async function loadSets() {
  const acc = document.getElementById('runAccount');
  if (!acc || !acc.value) return;
  const sel = document.getElementById('runSet');
  const r = await fetch('/api/problem-sets?account=' + encodeURIComponent(acc.value)).then((x) => x.json());
  sel.innerHTML = r.ok ? r.sets.map((s) => '<option value="' + s.id + '">' + escHtml(s.name) + '（' + s.id + '）</option>').join('') : '<option value="">拉题集失败：' + escHtml(r.error || '') + '</option>';
}
document.getElementById('runAccount').addEventListener('change', loadSets);
loadSets();
</script>
</section>` : '';
  const body = snapshot.accounts.map((a) => {
    const setsHtml = a.sets.map((s) => {
      const total = s.total || 1;
      const pct = Math.round((s.accepted / total) * 100);
      const rows = s.problems.map((p) => `<tr><td>${esc(p.id)}</td><td>${esc(p.type)}</td><td>${p.score}</td>
        <td><span style="color:${STATUS_COLOR[p.status] || '#666'}">●</span> ${esc(p.status)}</td>
        <td>${esc(STAGE_LABEL[p.stage] || p.stage)}</td><td>${esc(p.lastAction)} ${esc(p.lastAt)}</td></tr>`).join('');
      return `<section style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:12px 0">
        <h3>${esc(s.name)} <small>(${esc(s.psid)}) · ${esc(STAGE_LABEL[s.stage] || s.stage)}</small></h3>
        <div style="background:#eee;height:16px;border-radius:8px;overflow:hidden"><div style="width:${pct}%;background:#22c55e;height:100%"></div></div>
        <p>${s.accepted}/${s.total} 通过 · ${s.failed} 失败</p>
        <table style="border-collapse:collapse;width:100%;font-size:13px">
        <tr><th align="left">题号</th><th align="left">题型</th><th align="left">分值</th><th align="left">状态</th><th align="left">阶段</th><th align="left">最后动作</th></tr>
        ${rows || '<tr><td colspan="6">暂无题目</td></tr>'}</table></section>`;
    }).join('');
    const auditHtml = a.audit.map((e) => `<li>${esc(e.ts)} ${esc(e.action)} ${esc(e.psid || '')} ${esc(e.problemId || '')} ${esc(e.verdict || e.reason || '')}</li>`).join('');
    return `<section><h2>账号 ${esc(a.label)} <small>${esc(a.loginMasked)} · ${esc(a.status)}</small></h2>
      ${setsHtml || '<p>暂无题集，先跑 run 或 status。</p>'}
      <details><summary>最近审计日志（${a.audit.length} 条）</summary><ul>${auditHtml || '<li>无</li>'}</ul></details></section>`;
  }).join('');
  const refresh = live
    ? `<script>
(function () {
  function applyState(s) {
    document.getElementById('updated').textContent = '更新 ' + s.updatedAt;
    const b = document.getElementById('jobBanner');
    if (b && s.job) {
      b.textContent = '任务 ' + s.job.id + '：' + s.job.status + '（' + s.job.accountLabel + ' / ' + s.job.problemSet + '）';
      const l = document.getElementById('jobLog');
      if (l) l.textContent = (s.job.log || []).slice(-30).join('\\n');
      if ((s.job.status === 'done' || s.job.status === 'failed' || s.job.status === 'stopped') && !window.__reloaded) { window.__reloaded = true; setTimeout(() => location.reload(), 1500); }
    }
  }
  async function pollOnce() { try { const r = await fetch('/api/state'); applyState(await r.json()); } catch {} }
  // 优先用 SSE（/api/events，重连先发全量 snapshot）；失败再退回 5 秒轮询。
  try {
    const es = new EventSource('/api/events');
    es.addEventListener('snapshot', (e) => { try { applyState(JSON.parse(e.data)); } catch {} });
    es.onerror = () => { es.close(); setInterval(pollOnce, 5000); };
  } catch { setInterval(pollOnce, 5000); }
})();
</script>`
    : '';
  const reviewRows = [...(snapshot.review?.pending || []), ...(snapshot.review?.rework || [])];
  const reviewHtml = `<section style="border:1px solid #f59e0b;border-radius:8px;padding:12px;margin:12px 0">
    <h2>待复核（${snapshot.review?.counts?.pending || 0} 待处理 · ${snapshot.review?.counts?.rework || 0} 返工中 · ${snapshot.review?.counts?.accepted || 0} 已验收 · ${snapshot.review?.counts?.exhausted || 0} 已耗尽）</h2>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
    <tr><th align="left">题号</th><th align="left">题集</th><th align="left">原因</th><th align="left">返工</th><th align="left">状态</th><th align="left">更新时间</th></tr>
    ${reviewRows.map((r) => `<tr><td>${esc(r.pspId)}</td><td>${esc(r.psid)}</td><td>${esc(r.reason)}</td><td>${r.reworkCount || 0}/5</td><td>${esc(r.status)}</td><td>${esc(r.updatedAt || '')}</td></tr>`).join('') || '<tr><td colspan="6">暂无待复核的题</td></tr>'}</table>
    <p style="font-size:12px;color:#666">低置信 / 停表 / 自测失败的题进这里等人验收或返工；返工最多 5 次，满了置 exhausted。验收后人工已看过，不再自动处理；返工重做成功后自动验收。</p></section>`;
  return `<!doctype html><meta charset="utf-8"><title>PTA 全链路看板</title>
<h1>PTA 全链路看板</h1><p id="updated">更新 ${esc(snapshot.updatedAt)}</p>
${live ? '<p>SSE 推送进度（/api/events），失败时退回每 5 秒轮询（/api/state）。</p>' : `<p>静态快照（${new Date().toLocaleString('zh-CN')} 生成），用 <code>serve</code> 起实时版。</p>`}
${actionZone}
${reviewHtml}
${body || '<p>暂无账号，先在上面登录。</p>'}${refresh}`;
}
