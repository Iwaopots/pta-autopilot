/**
 * 真实网络冒烟：用假 Cookie 打真实 pintia.cn，验证「客户端 + 错误映射 + 不泄露 Cookie」。
 * 不提交任何东西，不需要真账号。运行：node test/live-probe.mjs
 */
import { createPta, PtaError, redact } from '../lib/pta.js';

const pta = createPta({ cookie: 'not-a-real-ptasession-for-probe' });
const cases = [
  ['me', () => pta.me()],
  ['sets', () => pta.sets()],
  ['examId', () => pta.examId('1')],
];

let pass = 0;
for (const [name, run] of cases) {
  try {
    const value = await run();
    console.log(`unexpected-ok ${name}: ${JSON.stringify(value).slice(0, 120)}`);
  } catch (error) {
    const code = error instanceof PtaError ? error.code : 'unknown';
    const message = redact(error?.message ?? error);
    const leaked = message.includes('not-a-real-ptasession');
    console.log(`${leaked ? 'FAIL' : 'ok'} - ${name} -> ${code} | ${message.slice(0, 90)}`);
    if (!leaked) pass += 1;
  }
}
console.log(`\n${pass}/${cases.length} 项按预期被拒且未泄露 Cookie`);
