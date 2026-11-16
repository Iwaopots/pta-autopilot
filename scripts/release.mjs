#!/usr/bin/env node
/**
 * 一条命令发版：node scripts/release.mjs <版本号>   例如 node scripts/release.mjs 0.4.1
 *
 * 步骤：工作区必须干净 → CHANGELOG 必须已有 "## <版本号>" → 改 package.json 版本 → 闸门（--offline）
 *      → commit "chore(release): v<版本号>" → tag v<版本号> → push main + tag（失败重试 3 次）→ ls-remote 校验远端 tag 指向本次提交。
 * 只做普通推送；不 force、不 reset。任一步失败立即停止并说明怎么收拾。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = String(process.argv[2] ?? '').replace(/^v/u, '');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const die = (message) => { console.error(`✗ ${message}`); process.exit(1); };

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/u.test(version)) die('用法：node scripts/release.mjs 0.4.1');
if (git('status', '--porcelain') !== '') die('工作区有未提交改动，先提交或暂存。');
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') die('请在 main 分支发版。');
if (git('tag', '--list', `v${version}`) !== '') die(`本地已有 tag v${version}。`);
if (!new RegExp(`^## ${version.replace(/\./gu, '\\.')}\\b`, 'mu').test(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'))) {
  die(`CHANGELOG.md 还没有 "## ${version}" 这一节，先写更新说明。`);
}

const pkgFile = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
pkg.version = version;
writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

const gate = spawnSync(process.execPath, [join(root, 'scripts', 'gate.mjs'), '--offline'], { cwd: root, stdio: 'inherit' });
if (gate.status !== 0) {
  git('checkout', '--', 'package.json');
  die('闸门没过，已还原 package.json。');
}

git('add', 'package.json');
git('commit', '-m', `chore(release): v${version}`);
git('tag', '-a', `v${version}`, '-m', `v${version}`);
const head = git('rev-parse', 'HEAD');

for (const ref of ['main', `v${version}`]) {
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
    const result = spawnSync('git', ['push', 'origin', ref], { cwd: root, stdio: 'inherit' });
    ok = result.status === 0;
    if (!ok) console.log(`推送 ${ref} 失败（第 ${attempt}/3 次）`);
  }
  if (!ok) die(`推送 ${ref} 失败。本地提交和 tag 都在，网络好了重跑：git push origin ${ref}`);
}

const remote = git('ls-remote', 'origin', `refs/tags/v${version}^{}`).split(/\s+/u)[0] || git('ls-remote', 'origin', `refs/tags/v${version}`).split(/\s+/u)[0];
if (remote !== head) die(`远端 tag v${version} 指向 ${remote || '（无）'}，不是本次提交 ${head}。`);
console.log(`✓ v${version} 已发布（${head.slice(0, 7)}），远端 tag 校验通过。`);
