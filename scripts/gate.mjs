#!/usr/bin/env node
/**
 * 发版闸门（跨平台）：语法 → 全部离线测试（skip 也算红）→ 版本一致 →（可选）本机插件在线。
 *
 *   node scripts/gate.mjs            # 全部，含本机 /_pta/ping
 *   node scripts/gate.mjs --offline  # 不连本机 DSH（CI / 沙箱用）
 *   node scripts/gate.mjs --syntax-only  # 只做语法检查（npm run check）
 *
 * 环境变量：PTA_PING_URL（默认取 DSH_WEB_URL，再退到 http://127.0.0.1:49531/_pta/ping）、PTA_ALLOW_SKIP=1（允许测试 skip，仅本地临时用）。
 * 任一项失败退出码 1，最后一行 ALL GREEN 才算过。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const offline = process.argv.includes('--offline');
const syntaxOnly = process.argv.includes('--syntax-only');
const failed = [];
const node = process.execPath;

function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'vendor', '.github'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.(m?js)$/u.test(entry.name)) out.push(path);
  }
  return out;
}

console.log('== 1. 语法 ==');
for (const file of sources(root)) {
  const result = spawnSync(node, ['--check', file], { encoding: 'utf8' });
  const name = relative(root, file);
  if (result.status !== 0) { failed.push(`syntax:${name}`); console.log(`  FAIL ${name}\n${result.stderr}`); } else console.log(`  ok   ${name}`);
}

if (syntaxOnly) {
  if (failed.length) { console.log(`FAILED: ${failed.join(', ')}`); process.exit(1); }
  console.log('syntax ok');
  process.exit(0);
}

console.log('== 2. 离线测试 ==');
const tests = readdirSync(join(root, 'test')).filter((name) => name.endsWith('.mjs') && name !== 'live-probe.mjs').sort();
for (const name of tests) {
  const result = spawnSync(node, [join('test', name)], { cwd: root, encoding: 'utf8', env: process.env });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  const last = out.split(/\r?\n/u).filter(Boolean).pop() ?? '';
  const skipped = /^skip\b/mu.test(result.stdout ?? '');
  if (result.status !== 0) { failed.push(`test:${name}`); console.log(`  FAIL ${name}\n${out.split(/\r?\n/u).slice(-15).join('\n')}`); }
  else if (skipped && process.env.PTA_ALLOW_SKIP !== '1') { failed.push(`skip:${name}`); console.log(`  FAIL ${name} 被跳过（${last}）；npm install 装好 devDependencies 再跑`); }
  else console.log(`  ok   ${name} -> ${last}`);
}

console.log('== 3. 版本一致 ==');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
if (!new RegExp(`^## ${pkg.version.replace(/\./gu, '\\.')}\\b`, 'mu').test(changelog)) { failed.push('changelog'); console.log(`  FAIL CHANGELOG.md 没有 ## ${pkg.version}`); }
else console.log(`  ok   package.json ${pkg.version} 与 CHANGELOG 对齐`);

if (offline) {
  console.log('== 4. 插件在线 == （--offline，跳过）');
} else {
  console.log('== 4. 插件在线 ==');
  const defaultPing = `${(process.env.DSH_WEB_URL ?? 'http://127.0.0.1:49531').replace(/\/+$/u, '')}/_pta/ping`;
  const url = process.env.PTA_PING_URL ?? defaultPing;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const ping = await response.json();
    console.log(`  version=${ping.version} tools=${ping.tools?.length} toolErrors=${ping.toolErrors?.length} launch=${ping.launch?.available}/${ping.launch?.mode}`);
    if (ping.version !== pkg.version) { failed.push('plugin:version'); console.log(`  FAIL 本机装的是 ${ping.version}，仓库是 ${pkg.version}：重装插件`); }
    if ((ping.toolErrors ?? []).length) failed.push('plugin:toolErrors');
    if ((ping.tools ?? []).length < 11) failed.push('plugin:tools');
  } catch (error) {
    failed.push('plugin:ping');
    console.log(`  FAIL ${url} 无响应（${error?.message ?? error}）；不在本机跑请加 --offline`);
  }
}

console.log('');
if (failed.length === 0) { console.log('ALL GREEN'); process.exit(0); }
console.log(`FAILED: ${failed.join(', ')}`);
process.exit(1);
