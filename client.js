window.__ModuleLoader__.load({
  id: 'dsh-pta',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const PANEL_ID = 'dsh-pta';
    const API = '/dsh-pta/api';
    const CAPTCHA_APP_ID = '194593025';

    // 颜色一律走 DSH 主题 token（--dsw-alias-*），后面的值只是缺省兜底。
    const css = `
      .ptap{--pt-fg:var(--dsw-alias-label-primary,#1f2328);--pt-fg2:var(--dsw-alias-label-secondary,#4b5563);--pt-fg3:var(--dsw-alias-label-tertiary,#6b7280);
        --pt-bg:var(--dsw-alias-bg-primary,#fff);--pt-bg2:var(--dsw-alias-bg-secondary,#f6f8fa);--pt-line:var(--dsw-alias-border-secondary,#e5e7eb);
        --pt-accent:var(--dsw-alias-state-business-primary,#0969da);--pt-hover:var(--dsw-alias-interactive-bg-hover,#f3f4f6);
        --pt-ok:#1a7f37;--pt-okbg:#dafbe1;--pt-bad:#cf222e;--pt-badbg:#ffebe9;--pt-warn:#9a6700;--pt-warnbg:#fff8c5;--pt-run:#0969da;--pt-runbg:#ddf4ff;
        display:flex;flex-direction:column;gap:12px;padding:16px 18px;height:100%;overflow:auto;font-size:13px;color:var(--pt-fg);box-sizing:border-box}
      .ptap *{box-sizing:border-box}
      .ptap-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .ptap-title{font-size:16px;font-weight:650}
      .ptap-sub{font-size:12px;color:var(--pt-fg3)}
      .ptap-sp{flex:1 1 auto}
      .ptap-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
      .ptap-kpi{border:1px solid var(--pt-line);border-radius:10px;padding:10px 12px;background:var(--pt-bg)}
      .ptap-kpi b{display:block;font-size:20px;font-weight:650;line-height:1.2;font-variant-numeric:tabular-nums}
      .ptap-kpi span{font-size:11.5px;color:var(--pt-fg3)}
      .ptap-grid{display:grid;grid-template-columns:minmax(250px,1fr) minmax(340px,1.55fr) minmax(290px,1.2fr);gap:12px;align-items:start}
      @media (max-width:1180px){.ptap-grid{grid-template-columns:1fr 1fr}.ptap-col-q{grid-column:1 / -1}}
      @media (max-width:760px){.ptap-grid{grid-template-columns:1fr}}
      .ptap-col{display:flex;flex-direction:column;gap:12px;min-width:0}
      .ptap-card{border:1px solid var(--pt-line);border-radius:10px;background:var(--pt-bg);min-width:0}
      .ptap-cardhead{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--pt-line)}
      .ptap-cardbody{padding:10px 12px}
      .ptap-label{font-size:12.5px;font-weight:600}
      .ptap-count{font-size:11px;color:var(--pt-fg3);font-variant-numeric:tabular-nums}
      .ptap-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--pt-line)}
      .ptap-row:first-child{border-top:none}
      .ptap-grow{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
      .ptap-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ptap-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--pt-fg3)}
      .ptap-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1px 7px;border-radius:99px;white-space:nowrap;background:var(--pt-bg2);color:var(--pt-fg2)}
      .ptap-chip.ok{color:var(--pt-ok);background:var(--pt-okbg)}.ptap-chip.bad{color:var(--pt-bad);background:var(--pt-badbg)}
      .ptap-chip.warn{color:var(--pt-warn);background:var(--pt-warnbg)}.ptap-chip.run{color:var(--pt-run);background:var(--pt-runbg)}
      .ptap-dot{width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block}
      .ptap-chip.run .ptap-dot{animation:ptap-pulse 1.2s ease-in-out infinite}
      @keyframes ptap-pulse{0%,100%{opacity:1}50%{opacity:.25}}
      .ptap-btn{border:1px solid var(--pt-line);background:var(--pt-bg);color:inherit;border-radius:7px;padding:4px 9px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;line-height:1.4}
      .ptap-btn:hover{background:var(--pt-hover)}
      .ptap-btn[disabled]{opacity:.5;cursor:not-allowed}
      .ptap-btn.primary{background:var(--pt-accent);border-color:transparent;color:#fff}
      .ptap-btn.primary:hover{filter:brightness(1.07)}
      .ptap-btn.danger{color:var(--pt-bad)}
      .ptap-btn.ghost{border-color:transparent;background:transparent;color:var(--pt-fg2);padding:3px 6px}
      .ptap-btn.ghost:hover{background:var(--pt-hover)}
      .ptap-field{display:flex;flex-direction:column;gap:5px;margin-bottom:9px}
      .ptap-input{border:1px solid var(--pt-line);border-radius:7px;padding:7px 9px;font-size:13px;font-family:inherit;background:var(--pt-bg);color:inherit;width:100%}
      .ptap-input:focus{outline:2px solid var(--pt-accent);outline-offset:-1px}
      .ptap-hint{font-size:11.5px;color:var(--pt-fg3);line-height:1.55}
      .ptap-msg{border-radius:8px;padding:8px 10px;font-size:12.5px;line-height:1.5;white-space:pre-wrap;display:flex;gap:8px;align-items:flex-start}
      .ptap-msg.ok{background:var(--pt-okbg);color:var(--pt-ok)}.ptap-msg.err{background:var(--pt-badbg);color:var(--pt-bad)}.ptap-msg.info{background:var(--pt-runbg);color:var(--pt-run)}
      .ptap-empty{padding:18px 10px;text-align:center;color:var(--pt-fg3);font-size:12.5px;line-height:1.6}
      .ptap-tabs{display:flex;gap:2px;background:var(--pt-bg2);border-radius:8px;padding:2px}
      .ptap-tab{border:none;background:transparent;color:var(--pt-fg2);border-radius:6px;padding:3px 8px;font-size:11.5px;cursor:pointer;font-family:inherit;white-space:nowrap}
      .ptap-tab[data-on="true"]{background:var(--pt-bg);color:var(--pt-fg);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.06)}
      .ptap-set{padding:10px 0;border-top:1px solid var(--pt-line);display:flex;flex-direction:column;gap:6px}
      .ptap-set:first-child{border-top:none}
      .ptap-setline{display:flex;align-items:center;gap:8px}
      .ptap-bar{height:6px;border-radius:99px;background:var(--pt-bg2);overflow:hidden;flex:1 1 auto}
      .ptap-bar>i{display:block;height:100%;border-radius:99px;background:var(--pt-ok);transition:width .4s}
      .ptap-bar.warn>i{background:#d4a72c}.ptap-bar.bad>i{background:var(--pt-bad)}.ptap-bar.run>i{background:var(--pt-run)}
      .ptap-meta{display:flex;gap:10px;font-size:11.5px;color:var(--pt-fg3);flex-wrap:wrap}
      .ptap-meta .bad{color:var(--pt-bad);font-weight:600}
      .ptap-task{border:1px solid var(--pt-line);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;background:var(--pt-bg)}
      .ptap-task+.ptap-task{margin-top:8px}
      .ptap-task.running{border-color:var(--pt-run)}
      .ptap-actions{display:flex;gap:4px;flex-wrap:wrap}
      .ptap-log{max-height:260px;overflow:auto;font-size:11.5px}
      .ptap-logrow{display:grid;grid-template-columns:44px 1fr;gap:8px;padding:4px 0;border-top:1px dashed var(--pt-line)}
      .ptap-logrow:first-child{border-top:none}
      .ptap-logrow time{color:var(--pt-fg3);font-variant-numeric:tabular-nums}
      .ptap-collapse{border-top:1px solid var(--pt-line)}
    `;

    async function call(action, payload) {
      const response = await fetch(API, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true) {
        const error = new Error(body?.error?.message ?? `请求失败（HTTP ${response.status}）`);
        error.code = body?.error?.code;
        throw error;
      }
      return body.data;
    }

    const STATUS_TEXT = { ready: '已登录', auth_required: '需重登' };
    const TASK_TEXT = { pending: '待做', running: '执行中', done: '完成', failed: '失败', cancelled: '已取消' };
    const TASK_CHIP = { pending: '', running: 'run', done: 'ok', failed: 'bad', cancelled: '' };
    const LOG_TEXT = {
      enqueue: '入队', start: '开始', progress: '进度', done: '完成', retry: '重试', failed: '失败', cancel: '取消',
      requeue: '重排', bump: '插队', clear: '清理', recover: '恢复', migrate: '迁移',
    };
    const dateText = (value) => (value ? String(value).replace('T', ' ').slice(5, 16) : '-');
    const timeText = (value) => {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    const pct = (done, total) => (total > 0 ? Math.round((done / total) * 100) : 0);

    function Chip({ kind = '', children, dot }) {
      return h('span', { className: `ptap-chip ${kind}` }, dot ? h('i', { className: 'ptap-dot' }) : null, children);
    }

    function Bar({ value, kind = '' }) {
      return h('div', { className: `ptap-bar ${kind}` }, h('i', { style: { width: `${Math.max(0, Math.min(100, value))}%` } }));
    }

    function Card({ title, count, extra, children, bodyClass = 'ptap-cardbody' }) {
      return h('div', { className: 'ptap-card' },
        h('div', { className: 'ptap-cardhead' },
          h('div', { className: 'ptap-label' }, title),
          count !== undefined ? h('span', { className: 'ptap-count' }, count) : null,
          h('div', { className: 'ptap-sp' }),
          extra ?? null),
        h('div', { className: bodyClass }, children));
    }

    function Panel({ close, openSession }) {
      const [info, setInfo] = useState(null);
      const [sets, setSets] = useState(null);
      const [setsAccount, setSetsAccount] = useState('');
      const [board, setBoard] = useState(null);
      const [busy, setBusy] = useState('');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [mode, setMode] = useState('password');
      const [showAdd, setShowAdd] = useState(false);
      const [form, setForm] = useState({ label: '', login: '', password: '', cookie: '' });
      const [relogin, setRelogin] = useState(null);
      const [queueTab, setQueueTab] = useState('active');
      const capRef = useRef({});
      const mounted = useRef(true);
      useEffect(() => () => { mounted.current = false; }, []);

      const refresh = useCallback(async () => {
        try {
          const data = await call('info');
          if (mounted.current) setInfo(data);
        } catch (cause) {
          if (mounted.current) setError(String(cause.message ?? cause));
        }
      }, []);

      const loadBoard = useCallback(async () => {
        try {
          const data = await call('tasks.board');
          if (mounted.current) setBoard(data);
        } catch {
          /* 队列读失败不打断面板，其它区域照常 */
        }
      }, []);

      useEffect(() => { void refresh(); void loadBoard(); }, [refresh, loadBoard]);

      // 有任务在跑时 3s 轮询，否则 15s；面板不可见时（document.hidden）跳过
      const active = (board?.counts?.running ?? 0) + (board?.counts?.pending ?? 0);
      useEffect(() => {
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          void loadBoard();
        }, active > 0 ? 3000 : 15000);
        return () => clearInterval(timer);
      }, [active, loadBoard]);

      // 任务完成后顺手刷新完成度
      const lastDone = useRef(-1);
      useEffect(() => {
        const done = board?.counts?.done ?? 0;
        if (lastDone.current >= 0 && done > lastDone.current && sets) void loadSets(setsAccount || null, true);
        lastDone.current = done;
      }, [board?.counts?.done]);

      const run = async (key, task) => {
        setBusy(key);
        setError('');
        setNotice('');
        try {
          const result = await task();
          if (result && typeof result === 'string') setNotice(result);
          await Promise.all([refresh(), loadBoard()]);
          return result;
        } catch (cause) {
          if (cause.code === 'captcha_required') {
            setMode('cookie');
            setError('PTA 这次要求滑块验证码。点「完成滑块验证」，或切到「粘贴 Cookie」。');
          } else {
            setError(String(cause.message ?? cause));
          }
          return null;
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      const loadCaptcha = () => new Promise((resolve, reject) => {
        if (window.TencentCaptcha) { resolve(window.TencentCaptcha); return; }
        const script = document.createElement('script');
        script.src = 'https://turing.captcha.qcloud.com/TCaptcha.js';
        script.onload = () => (window.TencentCaptcha ? resolve(window.TencentCaptcha) : reject(new Error('验证码脚本未就绪')));
        script.onerror = () => reject(new Error('验证码脚本加载失败（可能被网络/CSP 拦截）。可以先切到「粘贴 Cookie」登录。'));
        document.head.append(script);
      });

      const solveCaptcha = async (after) => {
        setError('');
        try {
          const TC = await loadCaptcha();
          const captcha = new TC(CAPTCHA_APP_ID, (result) => {
            if (result && result.ret === 0 && result.ticket) {
              capRef.current = { ticket: result.ticket, randstr: result.randstr };
              setNotice('验证通过，正在自动重试登录…');
              void after();
            } else {
              setError('验证码未完成，可以再试一次，或切到「粘贴 Cookie」。');
            }
          });
          captcha.show();
        } catch (cause) {
          setError(String(cause.message ?? cause));
        }
      };

      const takeTicket = () => {
        const value = capRef.current.ticket ? { ticket: capRef.current.ticket, randStr: capRef.current.randstr } : {};
        capRef.current = {};
        return value;
      };

      const add = () => run('add', async () => {
        const payload = mode === 'password'
          ? { label: form.label.trim(), login: form.login.trim(), password: form.password, ...takeTicket() }
          : { label: form.label.trim(), cookie: form.cookie.trim() };
        const result = await call('accounts.add', payload);
        setForm({ label: '', login: '', password: '', cookie: '' });
        setShowAdd(false);
        return `已添加 ${result?.account?.nickname || result?.account?.label || ''}`;
      });

      const redo = () => run(`relogin:${relogin.id}`, async () => {
        const result = await call('accounts.relogin', { id: relogin.id, password: relogin.password, ...takeTicket() });
        setRelogin(null);
        return `已重新登录 ${result?.account?.nickname || ''}`;
      });

      async function loadSets(account, quiet = false) {
        if (!quiet) { setBusy('sets'); setError(''); }
        try {
          const result = await call('progress', account ? { account } : {});
          if (mounted.current) setSets(result?.sets ?? []);
        } catch (cause) {
          if (!quiet && mounted.current) { setSets([]); setError(String(cause.message ?? cause)); }
        } finally {
          if (!quiet && mounted.current) setBusy('');
        }
      }

      const defaultAccount = info?.defaultAccount;
      useEffect(() => { if (defaultAccount && !sets) void loadSets(null); }, [defaultAccount]);

      const launch = board?.launch ?? info?.launch ?? { available: false };
      const accounts = info?.accounts ?? [];
      const viewAccount = setsAccount || defaultAccount || '';
      const tasks = board?.tasks ?? [];
      const counts = board?.counts ?? { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
      const activeTaskFor = (psid) => tasks.find((task) => task.psid === String(psid) && task.account === viewAccount && (task.status === 'pending' || task.status === 'running'));

      const dispatch = (row) => run(`dispatch:${row.id}`, async () => {
        let allowExam = false;
        if (row.exam) {
          allowExam = window.confirm(`「${row.name}」看起来是限时考试/监考类题集，默认不自动做。\n确定仍要交给 Agent 吗？`);
          if (!allowExam) return '已取消派发。';
        }
        const result = await call('dispatch', {
          psid: row.id, account: viewAccount || undefined, setName: row.name, endAt: row.endAt, exam: Boolean(row.exam), allowExam,
        });
        if (!result.created) return '这个题集已经在队列里了。';
        return result.launch?.available
          ? '已派发，Agent 会话已自动启动，进度看右侧队列。'
          : '已入队。当前 DSH 不支持插件直接开会话：在对话里说「执行 PTA 任务」即可开工。';
      });

      const dispatchAll = () => run('dispatchAll', async () => {
        const result = await call('dispatch.all', viewAccount ? { account: viewAccount } : {});
        const skipped = result.skipped?.length ? `，跳过 ${result.skipped.length} 个考试类` : '';
        return `已派发 ${result.queued?.length ?? 0} 个题集${skipped}。`;
      });

      const taskAction = (action, task, message) => run(`${action}:${task.id}`, async () => {
        await call(action, { id: task.id });
        return message;
      });

      // ── KPI ──
      const totals = (sets ?? []).reduce((acc, row) => {
        if (row.total > 0) { acc.total += row.total; acc.todo += row.todo; }
        if (row.todo > 0 && row.daysLeft !== null && row.daysLeft <= 3) acc.urgent += 1;
        return acc;
      }, { total: 0, todo: 0, urgent: 0 });
      const readyCount = accounts.filter((row) => row.status === 'ready').length;

      const kpis = h('div', { className: 'ptap-kpis' },
        h('div', { className: 'ptap-kpi' }, h('b', null, `${readyCount}/${accounts.length}`), h('span', null, '账号已登录')),
        h('div', { className: 'ptap-kpi' }, h('b', null, sets ? `${pct(totals.total - totals.todo, totals.total)}%` : '—'), h('span', null, sets ? `完成度 · 剩 ${totals.todo} 题` : '完成度')),
        h('div', { className: 'ptap-kpi' }, h('b', { style: totals.urgent ? { color: 'var(--pt-bad)' } : null }, sets ? totals.urgent : '—'), h('span', null, '3 天内截止未完成')),
        h('div', { className: 'ptap-kpi' }, h('b', null, `${counts.running}/${board?.limits?.maxConcurrent ?? 2}`), h('span', null, `执行中 · 待做 ${counts.pending}`)),
        h('div', { className: 'ptap-kpi' }, h('b', null, counts.done), h('span', null, `已完成任务 · 失败 ${counts.failed}`)));

      // ── 左栏：账号 ──
      const accountRows = accounts.length === 0
        ? h('div', { className: 'ptap-empty' }, '还没有账号。', h('br'), '点右上「添加」用账号密码登录。')
        : accounts.map((account) => h('div', { className: 'ptap-row', key: account.id },
          h('div', { className: 'ptap-grow' },
            h('div', { className: 'ptap-name', title: account.label }, account.label, account.id === defaultAccount ? h('span', { className: 'ptap-count' }, ' · 默认') : null),
            h('div', { className: 'ptap-mono' }, `${account.nickname || '未校验'} · ${account.id.slice(0, 8)}`),
            h('div', { className: 'ptap-actions', style: { marginTop: 4 } },
              h('button', { className: 'ptap-btn ghost', disabled: busy !== '', onClick: () => { setSetsAccount(account.id); void loadSets(account.id); } }, '看进度'),
              account.id !== defaultAccount ? h('button', { className: 'ptap-btn ghost', disabled: busy !== '', onClick: () => run(`default:${account.id}`, async () => { await call('accounts.default', { id: account.id }); return `默认账号已切到 ${account.label}`; }) }, '设为默认') : null,
              h('button', { className: 'ptap-btn ghost', disabled: busy !== '', onClick: () => run(`check:${account.id}`, async () => { const r = await call('accounts.check', { id: account.id }); return `校验通过：${r?.account?.nickname || ''}`; }) }, busy === `check:${account.id}` ? '校验中…' : '校验'),
              h('button', { className: 'ptap-btn ghost', disabled: busy !== '', onClick: () => { setRelogin({ id: account.id, label: account.label, password: '' }); setError(''); } }, '重登'),
              h('button', { className: 'ptap-btn ghost danger', disabled: busy !== '', onClick: () => { if (window.confirm(`删除账号「${account.label}」及其凭据？`)) void run(`remove:${account.id}`, async () => { await call('accounts.remove', { id: account.id }); return '已删除（凭据一并删除）'; }); } }, '删除'))),
          h(Chip, { kind: account.status === 'ready' ? 'ok' : 'bad' }, STATUS_TEXT[account.status] ?? account.status)));

      const reloginBox = relogin ? h('div', { className: 'ptap-cardbody ptap-collapse' },
        h('div', { className: 'ptap-label', style: { marginBottom: 8 } }, `重新登录 · ${relogin.label}`),
        h('div', { className: 'ptap-field' },
          h('input', { className: 'ptap-input', type: 'password', autoComplete: 'off', placeholder: '密码（只用一次，不保存）', value: relogin.password, onChange: (e) => setRelogin({ ...relogin, password: e.target.value }) })),
        h('div', { className: 'ptap-actions' },
          h('button', { className: 'ptap-btn primary', disabled: busy !== '' || !relogin.password, onClick: redo }, busy.startsWith('relogin') ? '登录中…' : '登录'),
          h('button', { className: 'ptap-btn', disabled: busy !== '' || !relogin.password, onClick: () => solveCaptcha(redo) }, '滑块后登录'),
          h('button', { className: 'ptap-btn ghost', onClick: () => setRelogin(null) }, '取消'))) : null;

      const addBox = showAdd ? h('div', { className: 'ptap-cardbody ptap-collapse' },
        h('div', { className: 'ptap-tabs', style: { marginBottom: 10, width: 'fit-content' } },
          h('button', { className: 'ptap-tab', 'data-on': String(mode === 'password'), onClick: () => setMode('password') }, '账号密码'),
          h('button', { className: 'ptap-tab', 'data-on': String(mode === 'cookie'), onClick: () => setMode('cookie') }, '粘贴 Cookie')),
        h('div', { className: 'ptap-field' },
          h('input', { className: 'ptap-input', value: form.label, placeholder: '标签（可留空），例如：本人', onChange: (e) => setForm({ ...form, label: e.target.value }) })),
        mode === 'password'
          ? h('div', null,
            h('div', { className: 'ptap-field' },
              h('input', { className: 'ptap-input', value: form.login, autoComplete: 'off', placeholder: '邮箱 / 手机号', onChange: (e) => setForm({ ...form, login: e.target.value }) })),
            h('div', { className: 'ptap-field' },
              h('input', { className: 'ptap-input', type: 'password', autoComplete: 'off', placeholder: '密码', value: form.password, onChange: (e) => setForm({ ...form, password: e.target.value }) })),
            h('div', { className: 'ptap-hint' }, '密码只用于这一次登录，换到会话后立即丢弃；要滑块时点「滑块后登录」。'))
          : h('div', null,
            h('div', { className: 'ptap-field' },
              h('input', { className: 'ptap-input', type: 'password', value: form.cookie, autoComplete: 'off', placeholder: 'PTASession 的 Value', onChange: (e) => setForm({ ...form, cookie: e.target.value }) })),
            h('div', { className: 'ptap-hint' }, 'F12 → 应用程序 → Cookie → pintia.cn → PTASession。直接进 DSH 凭据服务，不经过对话。')),
        h('div', { className: 'ptap-actions', style: { marginTop: 10 } },
          h('button', {
            className: 'ptap-btn primary',
            disabled: busy !== '' || (mode === 'password' ? (!form.login.trim() || !form.password) : !form.cookie.trim()),
            onClick: add,
          }, busy === 'add' ? '校验并保存…' : '添加账号'),
          mode === 'password' ? h('button', { className: 'ptap-btn', disabled: busy !== '' || !form.login.trim() || !form.password, onClick: () => solveCaptcha(add) }, '滑块后登录') : null)) : null;

      const accountCard = h('div', { className: 'ptap-card' },
        h('div', { className: 'ptap-cardhead' },
          h('div', { className: 'ptap-label' }, '账号'),
          h('span', { className: 'ptap-count' }, accounts.length),
          h('div', { className: 'ptap-sp' }),
          h('button', { className: 'ptap-btn', onClick: () => setShowAdd(!showAdd) }, showAdd ? '收起' : '添加')),
        h('div', { className: 'ptap-cardbody' }, accountRows),
        reloginBox,
        addBox);

      // ── 中栏：题目集完成度 ──
      const viewLabel = accounts.find((row) => row.id === viewAccount)?.label ?? '';
      const setList = !sets
        ? h('div', { className: 'ptap-empty' }, accounts.length ? '加载中…' : '添加账号后这里显示各题目集完成度。')
        : sets.length === 0
          ? h('div', { className: 'ptap-empty' }, '没有未结束的题目集。')
          : sets.map((row) => {
            const done = row.total > 0 ? row.total - row.todo : 0;
            const finished = row.total >= 0 && row.todo === 0;
            const urgent = !finished && row.daysLeft !== null && row.daysLeft <= 3;
            const task = activeTaskFor(row.id);
            const live = task?.status === 'running';
            return h('div', { className: 'ptap-set', key: row.id },
              h('div', { className: 'ptap-setline' },
                h('div', { className: 'ptap-grow' }, h('div', { className: 'ptap-name', title: row.name }, row.name)),
                row.exam ? h(Chip, { kind: 'warn' }, '考试') : null,
                finished ? h(Chip, { kind: 'ok' }, '已完成')
                  : task ? h(Chip, { kind: live ? 'run' : '', dot: live }, live ? `执行中 ${task.progress.total ? `${task.progress.done}/${task.progress.total}` : ''}` : '排队中')
                    : h('button', { className: 'ptap-btn primary', disabled: busy !== '' || row.total < 0, onClick: () => dispatch(row) }, busy === `dispatch:${row.id}` ? '派发中…' : '一键完成')),
              h('div', { className: 'ptap-setline' },
                h(Bar, { value: row.total > 0 ? pct(done, row.total) : 0, kind: finished ? '' : live ? 'run' : urgent ? 'bad' : 'warn' }),
                h('span', { className: 'ptap-count', style: { minWidth: 54, textAlign: 'right' } }, row.total < 0 ? '无权限' : `${done}/${row.total}`)),
              h('div', { className: 'ptap-meta' },
                h('span', { className: 'ptap-mono' }, row.id),
                h('span', { className: urgent ? 'bad' : '' }, row.daysLeft === null ? '无截止' : row.daysLeft < 0 ? '已截止' : `剩 ${row.daysLeft} 天`),
                h('span', null, `截止 ${dateText(row.endAt)}`)));
          });

      const setsCard = h(Card, {
        title: '题目集完成度',
        count: viewLabel ? `· ${viewLabel}` : undefined,
        extra: h('div', { className: 'ptap-actions' },
          h('button', { className: 'ptap-btn', disabled: busy !== '' || !sets?.some((row) => row.todo > 0 && !row.exam && !activeTaskFor(row.id)), onClick: dispatchAll }, busy === 'dispatchAll' ? '派发中…' : '全部完成'),
          h('button', { className: 'ptap-btn', disabled: busy !== '' || !accounts.length, onClick: () => loadSets(viewAccount || null) }, busy === 'sets' ? '刷新中…' : '刷新')),
      }, setList);

      // ── 右栏：任务队列 + 操作日志 ──
      const tabs = [['active', `进行 ${counts.running + counts.pending}`], ['done', `完成 ${counts.done}`], ['failed', `失败 ${counts.failed + counts.cancelled}`]];
      const visible = tasks.filter((task) => (queueTab === 'active' ? task.status === 'running' || task.status === 'pending'
        : queueTab === 'done' ? task.status === 'done' : task.status === 'failed' || task.status === 'cancelled'));

      const taskCard = (task) => {
        const progress = task.progress ?? { done: 0, total: 0, note: '' };
        return h('div', { className: `ptap-task ${task.status}`, key: task.id },
          h('div', { className: 'ptap-setline' },
            h('div', { className: 'ptap-grow' },
              h('div', { className: 'ptap-name', title: task.setName }, task.setName || `题目集 ${task.psid}`),
              h('div', { className: 'ptap-mono' }, `${task.accountLabel || task.account.slice(0, 8)} · 第 ${task.attempts}/${task.maxAttempts} 次`)),
            h(Chip, { kind: TASK_CHIP[task.status], dot: task.status === 'running' }, TASK_TEXT[task.status] ?? task.status)),
          task.status === 'running' || (task.status === 'done' && progress.total) ? h('div', { className: 'ptap-setline' },
            h(Bar, { value: pct(progress.done, progress.total), kind: task.status === 'running' ? 'run' : '' }),
            h('span', { className: 'ptap-count' }, progress.total ? `${progress.done}/${progress.total}` : '—')) : null,
          progress.note || task.error ? h('div', { className: 'ptap-hint', style: task.error ? { color: 'var(--pt-bad)' } : null }, task.error || progress.note) : null,
          task.status === 'pending' && task.nextRunAt ? h('div', { className: 'ptap-hint' }, `退避中，${timeText(task.nextRunAt)} 自动重试`) : null,
          h('div', { className: 'ptap-actions' },
            task.status === 'pending' && launch.available ? h('button', { className: 'ptap-btn ghost', disabled: busy !== '', onClick: () => taskAction('tasks.start', task, '已启动') }, '立即执行') : null,
            task.status === 'pending' ? h('button', { className: 'ptap-btn ghost', disabled: busy !== '', onClick: () => taskAction('tasks.bump', task, '已插队到最前') }, '插队') : null,
            task.sessionId && openSession ? h('button', { className: 'ptap-btn ghost', onClick: () => openSession(task.sessionId) }, '打开会话') : null,
            task.status === 'failed' || task.status === 'cancelled' ? h('button', { className: 'ptap-btn ghost', disabled: busy !== '', onClick: () => taskAction('tasks.retry', task, '已重新排队') }, '重试') : null,
            task.status === 'pending' || task.status === 'running' ? h('button', { className: 'ptap-btn ghost danger', disabled: busy !== '', onClick: () => taskAction('tasks.cancel', task, '已取消') }, '取消') : null));
      };

      const queueCard = h(Card, {
        title: '任务队列',
        extra: h('div', { className: 'ptap-actions' },
          h('div', { className: 'ptap-tabs' }, tabs.map(([key, label]) => h('button', { key, className: 'ptap-tab', 'data-on': String(queueTab === key), onClick: () => setQueueTab(key) }, label))),
          queueTab !== 'active' && visible.length ? h('button', { className: 'ptap-btn ghost', disabled: busy !== '', onClick: () => run('clear', async () => { const r = await call('tasks.clear'); return `已清理 ${r.removed} 个`; }) }, '清理') : null),
      },
      !launch.available ? h('div', { className: 'ptap-msg info', style: { marginBottom: 8 } }, '当前 DSH 不支持插件直接开会话：派发后在对话里说「执行 PTA 任务」。') : null,
      visible.length ? visible.map(taskCard) : h('div', { className: 'ptap-empty' }, queueTab === 'active' ? '没有进行中的任务。点中间的「一键完成」派发。' : '暂无。'));

      const events = board?.events ?? [];
      const logCard = h(Card, { title: '操作日志', count: events.length || undefined },
        events.length ? h('div', { className: 'ptap-log' }, events.slice(0, 40).map((event, index) => h('div', { className: 'ptap-logrow', key: `${event.at}-${index}` },
          h('time', null, timeText(event.at)),
          h('div', null, h('b', null, LOG_TEXT[event.kind] ?? event.kind), ' ', event.message))))
          : h('div', { className: 'ptap-empty' }, '暂无记录。'));

      return h('div', { className: 'ptap' },
        h('div', { className: 'ptap-head' },
          h('div', { className: 'ptap-title' }, 'PTA 作业'),
          h(Chip, { kind: launch.available ? 'ok' : 'warn' }, launch.available ? '一键直达模型' : '需在对话里开工'),
          h('div', { className: 'ptap-sub' }, '面板点，模型做；凭据只进 DSH 凭据服务'),
          h('div', { className: 'ptap-sp' }),
          h('button', { className: 'ptap-btn', disabled: busy !== '', onClick: () => { void refresh(); void loadBoard(); if (accounts.length) void loadSets(viewAccount || null); } }, '全部刷新'),
          close ? h('button', { className: 'ptap-btn', onClick: close }, '关闭') : null),
        error ? h('div', { className: 'ptap-msg err' }, error) : null,
        notice ? h('div', { className: 'ptap-msg ok' }, notice) : null,
        kpis,
        h('div', { className: 'ptap-grid' },
          h('div', { className: 'ptap-col' }, accountCard),
          h('div', { className: 'ptap-col' }, setsCard),
          h('div', { className: 'ptap-col ptap-col-q' }, queueCard, logCard)));
    }

    function Icon({ size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2.5 }),
      h('path', { d: 'M7 9h5M7 13h7M7 17h4' }),
      h('path', { d: 'M16.5 9.5l1.2 1.2 2.3-2.4' }));
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.pluginCss = 'dsh-pta';
        style.textContent = css;
        document.head.append(style);
        return () => style.remove();
      }, 'dsh-pta: styles');
      // 「打开会话」按需取 sessions / uiWorkspace：取不到就不显示按钮，不作为硬依赖（避免旧版 DSH 上插件加载失败）
      const openSession = async (sessionId) => {
        const sessions = ctx.get?.('sessions', false);
        const ui = ctx.get?.('uiWorkspace', false);
        try { await sessions?.refresh?.(); } catch { /* ignore */ }
        ui?.openSession?.(sessionId);
      };
      const canOpen = () => typeof ctx.get?.('uiWorkspace', false)?.openSession === 'function';
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_ID,
        inject: () => (canOpen() ? { openSession } : {}),
      }, Panel));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 33, label: 'PTA 作业',
      }, Icon));
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: PANEL_ID, order: 120, label: () => 'PTA 作业',
      }, Panel));
    }

    return { apply, inject: ['slots'] };
  },
});
