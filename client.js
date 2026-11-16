window.__ModuleLoader__.load({
  id: 'dsh-pta',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const PANEL_ID = 'dsh-pta';
    const API = '/dsh-pta/api';

    const css = `
      .ptap-wrap{display:flex;flex-direction:column;gap:12px;padding:18px;height:100%;overflow:auto;font-size:13px;color:var(--dsw-alias-label-primary,#1f2328)}
      .ptap-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
      .ptap-title{font-size:16px;font-weight:600}
      .ptap-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7280)}
      .ptap-card{border:1px solid var(--dsw-alias-border-secondary,#e5e7eb);border-radius:10px;padding:14px;background:var(--dsw-alias-bg-primary,#fff)}
      .ptap-cardhead{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
      .ptap-label{font-size:12px;font-weight:600}
      .ptap-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-secondary,#f0f1f3)}
      .ptap-row:first-of-type{border-top:none}
      .ptap-name{font-weight:600}
      .ptap-id{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7280)}
      .ptap-grow{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
      .ptap-chip{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid transparent;white-space:nowrap}
      .ptap-chip-ok{color:#116329;background:#dafbe1;border-color:#aceebb}
      .ptap-chip-bad{color:#82071e;background:#ffebe9;border-color:#ffcecb}
      .ptap-btn{border:1px solid var(--dsw-alias-border-secondary,#d0d7de);background:var(--dsw-alias-bg-primary,#fff);color:inherit;border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}
      .ptap-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}
      .ptap-btn[disabled]{opacity:.55;cursor:not-allowed}
      .ptap-btn-primary{background:var(--dsw-alias-state-business-primary,#0969da);border-color:transparent;color:#fff}
      .ptap-btn-primary:hover{filter:brightness(1.05)}
      .ptap-btn-danger{color:#82071e;border-color:#ffcecb}
      .ptap-field{display:flex;flex-direction:column;gap:5px;margin-bottom:9px}
      .ptap-input{border:1px solid var(--dsw-alias-border-secondary,#d0d7de);border-radius:8px;padding:7px 9px;font-size:13px;font-family:inherit;background:var(--dsw-alias-bg-primary,#fff);color:inherit}
      .ptap-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#0969da);outline-offset:-1px}
      .ptap-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#6b7280);line-height:1.55}
      .ptap-msg{border-radius:8px;padding:8px 10px;font-size:12.5px;line-height:1.5;white-space:pre-wrap}
      .ptap-msg-ok{background:#dafbe1;color:#116329}
      .ptap-msg-err{background:#ffebe9;color:#82071e}
      .ptap-empty{padding:14px;text-align:center;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:12.5px}
      .ptap-tabs{display:flex;gap:6px}
      .ptap-tab{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#4b5563);border-radius:7px;padding:4px 9px;font-size:12px;cursor:pointer;font-family:inherit}
      .ptap-tab[data-on="true"]{background:var(--dsw-alias-interactive-bg-hover,#eef1f4);color:var(--dsw-alias-label-primary,#1f2328);font-weight:600}
      .ptap-table{width:100%;border-collapse:collapse;font-size:12px}
      .ptap-table th{text-align:left;font-weight:600;color:var(--dsw-alias-label-tertiary,#6b7280);padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-secondary,#e5e7eb);font-size:11.5px}
      .ptap-table td{padding:5px 6px;border-bottom:1px solid var(--dsw-alias-border-secondary,#f3f4f6);vertical-align:top}
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

    const statusText = (status) => (status === 'ready' ? '已登录' : status === 'auth_required' ? '需重新登录' : status);
    const dateText = (value) => (value ? String(value).replace('T', ' ').slice(0, 16) : '-');

    function Chip({ status }) {
      return h('span', { className: `ptap-chip ${status === 'ready' ? 'ptap-chip-ok' : 'ptap-chip-bad'}` }, statusText(status));
    }

    function Panel({ close }) {
      const [info, setInfo] = useState(null);
      const [sets, setSets] = useState(null);
      const [busy, setBusy] = useState('');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [mode, setMode] = useState('password');
      const [form, setForm] = useState({ label: '', login: '', password: '', cookie: '' });
      const [relogin, setRelogin] = useState(null);
      const capRef = React.useRef({});

      const loadCaptcha = () => new Promise((resolve, reject) => {
        if (window.TencentCaptcha) { resolve(window.TencentCaptcha); return; }
        const script = document.createElement('script');
        script.src = 'https://turing.captcha.qcloud.com/TCaptcha.js';
        script.onload = () => (window.TencentCaptcha ? resolve(window.TencentCaptcha) : reject(new Error('验证码脚本未就绪')));
        script.onerror = () => reject(new Error('验证码脚本加载失败（可能被网络/CSP 拦截）。可以先切到「粘贴 Cookie」登录。'));
        document.head.append(script);
      });

      const solveCaptcha = async () => {
        setError('');
        try {
          const TC = await loadCaptcha();
          const captcha = new TC('194593025', (result) => {
            if (result && result.ret === 0 && result.ticket) {
              capRef.current = { ticket: result.ticket, randstr: result.randstr };
              setNotice('验证通过，正在自动重试登录…');
              void add();
            } else {
              setError('验证码未完成，可以再试一次，或切到「粘贴 Cookie」。');
            }
          });
          captcha.show();
        } catch (cause) {
          setError(String(cause.message ?? cause));
        }
      };

      const refresh = useCallback(async () => {
        try {
          setError('');
          setInfo(await call('info'));
        } catch (cause) {
          setError(String(cause.message ?? cause));
        }
      }, []);

      useEffect(() => { void refresh(); }, [refresh]);

      const run = async (key, task) => {
        setBusy(key);
        setError('');
        setNotice('');
        try {
          const result = await task();
          if (result && typeof result === 'string') setNotice(result);
          await refresh();
          return result;
        } catch (cause) {
          if (cause.code === 'captcha_required') {
            setMode('cookie');
            setError('PTA 这次要求滑块验证码，密码直登过不去。请在浏览器登录 pintia.cn，然后切到「粘贴 Cookie」把 PTASession 贴进来。');
          } else {
            setError(String(cause.message ?? cause));
          }
          return null;
        } finally {
          setBusy('');
        }
      };

      const add = () => run('add', async () => {
        const payload = mode === 'password'
          ? { label: form.label.trim(), login: form.login.trim(), password: form.password,
              ...(capRef.current.ticket ? { ticket: capRef.current.ticket, randStr: capRef.current.randstr } : {}) }
          : { label: form.label.trim(), cookie: form.cookie.trim() };
        const result = await call('accounts.add', payload);
        setForm({ label: '', login: '', password: '', cookie: '' });
        return `已添加 ${result?.account?.id ?? ''}（${result?.account?.nickname || result?.account?.label || ''}）`;
      });

      const redo = () => run(`relogin:${relogin.id}`, async () => {
        const result = await call('accounts.relogin', { id: relogin.id, password: relogin.password, ticket: relogin.ticket, randStr: relogin.randStr });
        setRelogin(null);
        return `已重新登录 ${result?.account?.nickname || ''}`;
      });

      const defaultAccount = info?.defaultAccount;
      const loadSets = async (account) => {
        setBusy(`sets:${account || 'default'}`);
        setError('');
        try {
          const result = await call('progress', account ? { account } : {});
          setSets(result?.sets ?? []);
        } catch (cause) {
          setSets([]);
          setError(String(cause.message ?? cause));
        } finally {
          setBusy('');
        }
      };

      const accounts = info?.accounts ?? [];
      const setsTable = !sets
        ? h('div', { className: 'ptap-hint' }, '点「刷新」看默认账号各题目集的完成度。')
        : sets.length === 0
          ? h('div', { className: 'ptap-empty' }, '没有未结束的题目集。')
          : h('table', { className: 'ptap-table' },
              h('thead', null, h('tr', null,
                h('th', null, 'PSID'), h('th', null, '名称'), h('th', null, '未完成'),
                h('th', null, '剩余'), h('th', null, '截止'))),
              h('tbody', null, sets.map((row) => h('tr', { key: row.id },
                h('td', null, row.id),
                h('td', null, row.name),
                h('td', null, row.total < 0 ? '—'
                  : row.todo === 0 ? h('span', { className: 'ptap-chip ptap-chip-ok' }, '已完成')
                    : h('span', { className: `ptap-chip ${row.daysLeft !== null && row.daysLeft <= 3 ? 'ptap-chip-bad' : ''}` }, `${row.todo}/${row.total}`)),
                h('td', null, row.daysLeft === null ? '-' : `${row.daysLeft} 天`),
                h('td', null, dateText(row.endAt))))));

      return h('div', { className: 'ptap-wrap' },
        h('div', { className: 'ptap-head' },
          h('div', { className: 'ptap-title' }, 'PTA 作业'),
          h('div', { className: 'ptap-sub' }, '账号与登录都在这里；做题交给 Agent'),
          close ? h('button', { className: 'ptap-btn', style: { marginLeft: 'auto' }, onClick: close }, '关闭') : null),

        error ? h('div', { className: 'ptap-msg ptap-msg-err' }, error) : null,
        notice ? h('div', { className: 'ptap-msg ptap-msg-ok' }, notice) : null,

        h('div', { className: 'ptap-card' },
          h('div', { className: 'ptap-cardhead' },
            h('div', { className: 'ptap-label' }, `账号（${accounts.length}）`),
            h('div', { className: 'ptap-hint' }, defaultAccount ? `默认：${defaultAccount}` : '未设置默认')),
          accounts.length === 0
            ? h('div', { className: 'ptap-empty' }, '还没有账号。用下面「添加账号」登录，或在「粘贴 Cookie」里贴一次 PTASession。')
            : accounts.map((account) => h('div', { className: 'ptap-row', key: account.id },
              h('div', { className: 'ptap-grow' },
                h('div', { className: 'ptap-name' }, `${account.label}${account.id === defaultAccount ? '（默认）' : ''}`),
                h('div', { className: 'ptap-id' }, `${account.id} · ${account.nickname || '未校验'} · ${account.email || '无邮箱'}`)),
              h(Chip, { status: account.status }),
              h('button', { className: 'ptap-btn', disabled: busy !== '' || account.id === defaultAccount, onClick: () => run(`default:${account.id}`, async () => { await call('accounts.default', { id: account.id }); return `默认账号已设为 ${account.id}`; }) }, '设为默认'),
              h('button', { className: 'ptap-btn', disabled: busy !== '', onClick: () => run(`check:${account.id}`, async () => { const r = await call('accounts.check', { id: account.id }); return `校验通过：${r?.account?.nickname || ''}`; }) }, busy === `check:${account.id}` ? '校验中…' : '校验'),
              h('button', { className: 'ptap-btn', disabled: busy !== '', onClick: () => { setRelogin({ id: account.id, password: '', ticket: '', randStr: '' }); setError(''); } }, '重登'),
              h('button', { className: 'ptap-btn ptap-btn-danger', disabled: busy !== '', onClick: () => run(`remove:${account.id}`, async () => { await call('accounts.remove', { id: account.id }); return `已删除 ${account.id}（凭据一并删除）`; }) }, '删除')))),

        relogin ? h('div', { className: 'ptap-card' },
          h('div', { className: 'ptap-label', style: { marginBottom: 8 } }, `重新登录 ${relogin.id}`),
          h('div', { className: 'ptap-field' }, h('div', { className: 'ptap-label' }, '密码'),
            h('input', { className: 'ptap-input', type: 'password', autoComplete: 'off', value: relogin.password, onChange: (e) => setRelogin({ ...relogin, password: e.target.value }) })),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { className: 'ptap-btn ptap-btn-primary', disabled: busy !== '' || !relogin.password, onClick: redo }, busy.startsWith('relogin') ? '登录中…' : '登录'),
            h('button', { className: 'ptap-btn', onClick: () => setRelogin(null) }, '取消'))) : null,

        h('div', { className: 'ptap-card' },
          h('div', { className: 'ptap-cardhead' },
            h('div', { className: 'ptap-label' }, '添加账号'),
            h('div', { className: 'ptap-tabs' },
              h('button', { className: 'ptap-tab', 'data-on': String(mode === 'password'), onClick: () => setMode('password') }, '账号密码'),
              h('button', { className: 'ptap-tab', 'data-on': String(mode === 'cookie'), onClick: () => setMode('cookie') }, '粘贴 Cookie'))),
          h('div', { className: 'ptap-field' }, h('div', { className: 'ptap-label' }, '标签（可留空）'),
            h('input', { className: 'ptap-input', value: form.label, placeholder: '例如：曹宇翔（学号）', onChange: (e) => setForm({ ...form, label: e.target.value }) })),
          mode === 'password'
            ? h('div', null,
              h('div', { className: 'ptap-field' }, h('div', { className: 'ptap-label' }, '账号（邮箱 / 手机号）'),
                h('input', { className: 'ptap-input', value: form.login, autoComplete: 'off', onChange: (e) => setForm({ ...form, login: e.target.value }) })),
              h('div', { className: 'ptap-field' }, h('div', { className: 'ptap-label' }, '密码'),
                h('input', { className: 'ptap-input', type: 'password', autoComplete: 'off', value: form.password, onChange: (e) => setForm({ ...form, password: e.target.value }) })),
              h('div', { className: 'ptap-hint' }, '密码只用于这一次登录，拿到会话后立即丢弃，不落盘；PTA 要求滑块验证码时会提示你切到「粘贴 Cookie」。'))
            : h('div', null,
              h('div', { className: 'ptap-field' }, h('div', { className: 'ptap-label' }, 'PTASession'),
                h('input', { className: 'ptap-input', type: 'password', value: form.cookie, autoComplete: 'off', placeholder: 'F12 → 应用程序 → Cookie → pintia.cn → PTASession 的 Value', onChange: (e) => setForm({ ...form, cookie: e.target.value }) })),
              h('div', { className: 'ptap-hint' }, '粘贴后直接写进 DSH 凭据服务，不会出现在对话或日志里。')),
          h('div', { style: { marginTop: 10, display: 'flex', gap: 8 } },
            h('button', {
              className: 'ptap-btn ptap-btn-primary',
              disabled: busy !== '' || (mode === 'password' ? (!form.login.trim() || !form.password) : !form.cookie.trim()),
              onClick: add,
            }, busy === 'add' ? '校验并保存…' : '添加账号'),
            mode === 'password' ? h('button', { className: 'ptap-btn', disabled: busy !== '', onClick: solveCaptcha }, '完成滑块验证') : null)),

        h('div', { className: 'ptap-card' },
          h('div', { className: 'ptap-cardhead' },
            h('div', { className: 'ptap-label' }, '题目集进度'),
            h('div', { style: { display: 'flex', gap: 6 } },
              h('button', { className: 'ptap-btn', disabled: busy !== '', onClick: () => loadSets(null) }, busy.startsWith('sets') ? '刷新中…' : '刷新'))),
          setsTable));
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
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel));
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
