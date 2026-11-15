/**
 * 客户端契约冒烟：用桩模拟 window.__ModuleLoader__ / react / slots，
 * 验证 client.js 能被加载、factory 返回值形状正确、三个 slot 都注册上。
 * 运行：node test/client-contract.mjs
 */
import assert from 'node:assert/strict';

let captured;
globalThis.window = { __ModuleLoader__: { load: (module) => { captured = module; } } };

await import('../client.js');
assert.ok(captured, 'client.js 没有调用 window.__ModuleLoader__.load');
assert.equal(captured.id, 'dsh-pta', 'loader id 必须等于包名');
assert.equal(typeof captured.factory, 'function');

const react = {
  createElement: (...args) => ({ args }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
};
const moduleExports = captured.factory((name) => {
  if (name === 'react') return react;
  throw new Error(`未预期的 require：${name}`);
});
assert.equal(typeof moduleExports.apply, 'function');
assert.ok(Array.isArray(moduleExports.inject));
assert.ok(moduleExports.inject.includes('slots'));

const registrations = [];
const ctx = {
  effect: (fn) => fn(),
  slots: {
    inject: (_name, callback) => callback(),
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    },
  },
};
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { append: () => {} },
  querySelector: () => null,
};
moduleExports.apply(ctx);

const byName = Object.fromEntries(registrations.map((item) => [item.options.name, item]));
assert.ok(byName.main, '缺少 main 面板');
assert.equal(byName.main.options.key, 'dsh-pta');
assert.ok(byName['sidebar.panellist'], '缺少侧栏入口');
assert.equal(byName['sidebar.panellist'].options.id, 'dsh-pta');
assert.equal(typeof byName['sidebar.panellist'].options.label, 'string');
assert.ok(byName['settings.section'], '缺少设置页入口');
assert.equal(byName['settings.section'].options.id, 'dsh-pta');
assert.equal(typeof byName['settings.section'].options.label, 'function');
for (const item of registrations) assert.equal(typeof item.component, 'function');

console.log(`ok - client.js 可加载，注册 ${registrations.length} 个 slot：${registrations.map((item) => item.options.name).join(', ')}`);
