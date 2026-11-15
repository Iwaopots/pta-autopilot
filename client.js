window.__ModuleLoader__.load({
  id: 'dsh-pta',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const PANEL_ID = 'dsh-pta';
    const API = '/dsh-pta/api';

    const css = `
      .ptap-wrap{display:flex;flex-direction:column;gap:14px;padding:18px;height:100%;overflow:auto;font-size:13px;color:var(--dsw-alias-label-primary,#1f2328)}
      .ptap-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
      .ptap-title{font-size:16px;font-weight:600}
      .ptap-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7280)}
      .ptap-card{border:1px solid var(--dsw-alias-border-secondary,#e5e7eb);border-radius:10px;padding:14px;background:var(--dsw-alias-bg-primary,#fff)}
      .ptap-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-secondary,#f0f1f3)}
      .ptap-row:first-of-type{border-top:none}
      .ptap-name{font-weight:600}
      .ptap-id{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7280)}
      .ptap-grow{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
      .ptap-chip{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid transparent}
      .ptap-chip-ok{color:#116329;background:#dafbe1;border-color:#aceebb}
      .ptap-chip-bad{color:#82071e;background:#ffebe9;border-color:#ffcecb}
      .ptap-btn{border:1px solid var(--dsw-alias-border-secondary,#d0d7de);background:var(--dsw-alias-bg-primary,#fff);color:inherit;border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit}
      .ptap-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}
      .ptap-btn[disabled]{opacity:.55;cursor:not-allowed}
      .ptap-btn-primary{background:var(--dsw-alias-state-business-primary,#0969da);border-color:transparent;color:#fff}
      .ptap-btn-primary:hover{filter:brightness(1.05)}
      .ptap-field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}
      .ptap-label{font-size:12px;font-weight:600}
      .ptap-input{border:1px solid var(--dsw-alias-border-secondary,#d0d7de);border-radius:8px;padding:7px 9px;font-size:13px;font-family:inherit;background:var(--dsw-alias-bg-primary,#fff);color:inherit}
      .ptap-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#0969da);outline-offset:-1px}
      .ptap-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#6b7280);line-height:1.5}
      .ptap-msg{border-radius:8px;padding:8px 10px;font-size:12.5px;line-height:1.5}
      .ptap-msg-ok{background:#dafbe1;color:#116329}
      .ptap-msg-err{background:#ffebe9;color:#82071e}
      .ptap-empty{padding:18px;text-align:center;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:12.5px}
      .ptap-tips{margin:0;padding-left:18px;line-height:1.7;font-size:12px;color:var(--dsw-alias-label-secondary,#4b5563)}
    `;

    async function call(action, payload) {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true) {
        throw new Error(body?.error?.message ?? `请求失败（HTTP ${response.status}）`);
      }
      return body.data;
    }

    function Chip({ status }) {
      const ok = status === 'ready';
      const label = ok ? '已登录' : status === 'auth_required' ? '需重新登录' : status;
      return h('span', { className: `ptap-chip ${ok ? 'ptap-chip-ok' : 'ptap-chip-bad'}` }, label);
    }

    function Panel() {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState('');
      const [label, setLabel] = useState('');
      const [cookie, setCookie] = useState('');

      const refresh = useCallback(async () => {
        try {
          setError(null);
          setData(await call('info'));
        } catch (cause) {
          setError(String(cause.message ?? cause));
        }
      }, []);

      useEffect(() => { void refresh(); }, [refresh]);

      const run = async (key, task) => {
        setBusy(key);
        setNotice(null);
        setError(null);
        try {
          const result = await task();
          await refresh();
          setNotice(result ?? '已完成');
        } catch (cause) {
          setError(String(cause.message ?? cause));
        } finally {
          setBusy('');
        }
      };

      const add = () => run('add', async () => {
        const result = await call('accounts.add', { label: label.trim(), cookie: cookie.trim() });
        setLabel('');
        setCookie('');
        const account = result?.account;
        return `已添加 ${account?.id ?? ''}（${account?.nickname || account?.label || ''}）`;
      });

      const check = (id) => run(`check:${id}`, async () => {
        const result = await call('accounts.check', { id });
        return `${id} 校验通过：${result?.account?.nickname || ''}`;
      });

      const makeDefault = (id) => run(`default:${id}`, async () => {
        await call('accounts.default', { id });
        return `默认账号已设为 ${id}`;
      });

      const remove = (id) => run(`remove:${id}`, async () => {
        await call('accounts.remove', { id });
        return `已删除 ${id}（凭据一并删除）`;
      });

      const accounts = data?.accounts ?? [];
      const defaultId = data?.defaultAccount ?? null;

      return h('div', { className: 'ptap-wrap' },
        h('div', { className: 'ptap-head' },
          h('div', { className: 'ptap-title' }, 'PTA 作业'),
          h('div', { className: 'ptap-sub' }, '账号与登录态；Cookie 只进 DSH 凭据服务，不进对话')),
        error ? h('div', { className: 'ptap-msg ptap-msg-err' }, error) : null,
        notice ? h('div', { className: 'ptap-msg ptap-msg-ok' }, notice) : null,

        h('div', { className: 'ptap-card' },
          h('div', { className: 'ptap-label', style: { marginBottom: 8 } }, `已绑定账号（${accounts.length}）`),
          accounts.length === 0
            ? h('div', { className: 'ptap-empty' }, '还没有账号。在下面粘贴一次 PTASession 就行。')
            : accounts.map((account) => h('div', { className: 'ptap-row', key: account.id },
              h('div', { className: 'ptap-grow' },
                h('div', { className: 'ptap-name' }, `${account.label}${account.id === defaultId ? '（默认）' : ''}`),
                h('div', { className: 'ptap-id' }, `${account.id} · ${account.nickname || '未校验'}`)),
              h(Chip, { status: account.status }),
              h('button', {
                className: 'ptap-btn', disabled: busy !== '' || account.id === defaultId,
                onClick: () => makeDefault(account.id),
              }, '设为默认'),
              h('button', {
                className: 'ptap-btn', disabled: busy !== '',
                onClick: () => check(account.id),
              }, busy === `check:${account.id}` ? '校验中…' : '校验'),
              h('button', {
                className: 'ptap-btn', disabled: busy !== '',
                onClick: () => remove(account.id),
              }, '删除')))),

        h('div', { className: 'ptap-card' },
          h('div', { className: 'ptap-label', style: { marginBottom: 8 } }, '添加账号'),
          h('div', { className: 'ptap-field' },
            h('div', { className: 'ptap-label' }, '标签'),
            h('input', {
              className: 'ptap-input', value: label, placeholder: '例如：张三（学号）',
              onChange: (event) => setLabel(event.target.value),
            })),
          h('div', { className: 'ptap-field' },
            h('div', { className: 'ptap-label' }, 'PTASession'),
            h('input', {
              className: 'ptap-input', type: 'password', value: cookie, autoComplete: 'off',
              placeholder: '浏览器 F12 → 应用程序 → Cookie → pintia.cn → PTASession 的 Value',
              onChange: (event) => setCookie(event.target.value),
            })),
          h('div', { className: 'ptap-hint' },
            '粘贴后立即写入 Windows 凭据服务；提交时只发送一次，之后不再显示。这个输入框的内容不会出现在对话或日志里。'),
          h('div', { style: { marginTop: 10 } },
            h('button', {
              className: 'ptap-btn ptap-btn-primary', disabled: busy !== '' || !label.trim() || !cookie.trim(),
              onClick: add,
            }, busy === 'add' ? '校验并保存…' : '添加账号'))),

        h('div', { className: 'ptap-card' },
          h('div', { className: 'ptap-label', style: { marginBottom: 6 } }, '怎么用'),
          h('ul', { className: 'ptap-tips' },
            h('li', null, '对 Agent 说「做 PTA 作业」，它会先列账号和未结束题目集。'),
            h('li', null, '题目、答案、待办都存在本机 state 目录，Agent 只读需要的那一小段。'),
            h('li', null, '账号失效时这里会显示「需重新登录」，重新粘贴一次 PTASession 即可。'))),
      );
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
      // 设置页里的同一个面板：侧栏入口不出现时的第二条入口
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: PANEL_ID, order: 120, label: () => 'PTA 作业',
      }, Panel));
    }

    return { apply, inject: ['slots'] };
  },
});
