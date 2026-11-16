// 腾讯防水墙滑块求解器（纯协议，Node 版）。
// 算法与 kisakiayano/PTA-mcp 的 solve.py 一致（MIT），
// 但 HTTP 全走 Node fetch（本机 Python requests 走出口代理到该域名会超时），
// 图像计算仍调同目录的 locate.py（Pillow + numpy，不联网）。
// 链路：prehandle -> 取背景图 + 拼图块 -> 缺口定位 -> PoW -> verify，
// 成功返回 { ticket, randstr, x, stat }。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'https://turing.captcha.qcloud.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const AID = '194593025';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runLocate(bgPath, spPath, p1) {
  return new Promise((resolve, reject) => {
    const script = new URL('./locate.py', import.meta.url).pathname;
    const child = spawn('python3', [script, '--bg', bgPath, '--sp', spPath,
      '--sprite-pos', JSON.stringify(p1.sprite_pos),
      '--size', JSON.stringify(p1.size_2d),
      '--init-pos', JSON.stringify(p1.init_pos)]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(new Error(`cannot run python3 locate: ${e.message}`)));
    child.on('close', (code) => {
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch {
        reject(new Error(`locate bad output (exit ${code}): ${out.slice(0, 200)} ${err.slice(0, 200)}`));
      }
    });
  });
}

function powSolve(prefix, target, limit = 2_000_000) {
  // 与原实现一致：算出即弃（本链路的 verify 不提交 PoW 答案），只记耗时。
  const t0 = Date.now();
  for (let i = 0; i < limit; i++) {
    if (createHash('md5').update(prefix + String(i)).digest('hex') === target) {
      return { answer: i, ms: Date.now() - t0 };
    }
  }
  return { answer: null, ms: Date.now() - t0 };
}

export async function solveCaptcha({ aid = AID, entry = 'https://pintia.cn/auth/login', timeoutMs = 300000 } = {}) {
  const started = Date.now();
  const stat = {};
  const dir = mkdtempSync(join(tmpdir(), 'pta-cap-'));
  const guard = () => {
    if (Date.now() - started > timeoutMs) throw new Error('captcha solver timed out');
  };
  try {
    const headers = { 'User-Agent': UA, Referer: 'https://pintia.cn/', Accept: '*/*' };
    async function prehandle() {
      guard();
      const tkid = String(Math.floor(Math.random() * 9e8) + 1e8);
      const p = new URLSearchParams({
        aid, protocol: 'https', accver: '1', showtype: 'popup',
        ua: Buffer.from(UA).toString('base64'), noheader: '1', fb: '1', aged: '0',
        enableAged: '0', enableDarkMode: '0', grayscale: '1', clientype: '2',
        cap_cd: '', uid: '', lang: 'zh-cn', entry_url: entry, elder_captcha: '0',
        js: '/tcaptcha-frame.ba387dd1.js', login_appid: '', wb: '2',
        tkid, subsid: '1', callback: `_aq_${Math.floor(Math.random() * 9e5) + 1e5}`, sess: '',
      });
      const t0 = Date.now();
      const res = await fetch(`${API}/cap_union_prehandle?${p}`, { headers, signal: AbortSignal.timeout(60000) });
      const text = await res.text();
      stat.prehandle = Date.now() - t0;
      const d = JSON.parse(text.match(/^[^(]*\((.*)\)\s*$/s)[1]);
      return { d, tkid };
    }

    let { d, tkid } = await prehandle();
    let show = d.data.dyn_show_info;
    let sess = d.sess;
    let p1 = show.fg_elem_list.find((f) => f.id === 1);
    let x = null;
    let contrast = 0;
    let cvMs = 0;
    let agree = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      guard();
      const t0 = Date.now();
      const [bgRes, spRes] = await Promise.all([
        fetch(`${API}${show.bg_elem_cfg.img_url}&tkid=${tkid}`, { headers, signal: AbortSignal.timeout(60000) }),
        fetch(`${API}${show.sprite_url}&tkid=${tkid}`, { headers, signal: AbortSignal.timeout(60000) }),
      ]);
      const bgPath = join(dir, 'bg');
      const spPath = join(dir, 'sp');
      writeFileSync(bgPath, Buffer.from(await bgRes.arrayBuffer()));
      writeFileSync(spPath, Buffer.from(await spRes.arrayBuffer()));
      stat.images = Date.now() - t0;
      const loc = await runLocate(bgPath, spPath, p1);
      x = loc.x;
      contrast = loc.contrast;
      agree = loc.agree;
      cvMs = Date.now() - t0 - (stat.images ?? 0);
      if (contrast >= 45 && agree) break;
      ({ d, tkid } = await prehandle());
      sess = d.sess;
      show = d.data.dyn_show_info;
      p1 = show.fg_elem_list.find((f) => f.id === 1);
    }

    const pw = d.data.comm_captcha_cfg?.pow_cfg || {};
    const { ms: powMs } = powSolve(pw.prefix || '', pw.md5 || '');
    const ansT = p1.move_cfg.data_type[0];
    const y = p1.init_pos[1];
    let tries = 0;
    let r = null;
    while (tries < 3) {
      guard();
      tries += 1;
      const body = new URLSearchParams({
        collect: '', tlg: '0', eks: '', sess,
        ans: JSON.stringify([{ elem_id: 1, type: ansT, data: `${x},${y}` }]),
        tkid,
      });
      const res = await fetch(`${API}/cap_union_new_verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Origin: 'https://turing.captcha.gtimg.com',
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'User-Agent': UA,
        },
        body: body.toString(),
        signal: AbortSignal.timeout(60000),
      });
      r = await res.json();
      if (r.errorCode === '0') {
        stat.cv_ms = cvMs;
        stat.contrast = Math.round(contrast * 10) / 10;
        stat.pow_ms = powMs;
        stat.x = x;
        stat.tries = tries;
        stat.total_ms = Date.now() - started;
        return { ok: true, ticket: r.ticket, randstr: r.randstr, x, stat };
      }
      sess = r.sess || sess;
      if (tries < 3) await sleep(600);
    }
    stat.cv_ms = cvMs;
    stat.contrast = Math.round(contrast * 10) / 10;
    stat.pow_ms = powMs;
    stat.x = x;
    stat.tries = tries;
    stat.total_ms = Date.now() - started;
    throw new Error(`captcha verify failed: ${JSON.stringify(r).slice(0, 300)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
