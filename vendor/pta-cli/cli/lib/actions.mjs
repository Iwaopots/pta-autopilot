// 共享后端逻辑：CLI（pta.mjs）和面板服务（serve.mjs）都调这里，别写两份。
// 包括：登录（含验证码自动求解）、会话复用 + 过期自动重登。
import { PTAClient, PTAError } from './pta-client.mjs';
import * as store from './store.mjs';

// 登录（含滑块自动求解）：最多 2 轮滑块（kisaki auto_login 的 max_captcha=2）。
// 第一轮票被拒时退避 20 秒再解第二轮；两轮都失败才转人工（CAPTCHA_REQUIRED）。
// ticket/randStr 由调用方传入（用户在 DSH 浏览器里手动过一次滑块拿到的票）。
async function loginWithCaptcha(client, { user, password, ticket = '', randStr = '', noCaptcha = false, log = () => {} }) {
  let curTicket = ticket;
  let curRand = randStr;
  for (let round = 0; round < 2; round++) {
    try {
      await client.login({ user, password, ticket: curTicket, randStr: curRand });
      return;
    } catch (e) {
      if (e.code !== 'GATEWAY_WRONG_CAPTCHA' || noCaptcha) throw e;
      if (round === 1) {
        throw new PTAError('CAPTCHA_REQUIRED', 'captcha required after 2 rounds; complete the Tencent captcha once in the DSH browser and retry with --ticket <T> --rand-str <R>');
      }
      // 已给的票被拒（或首轮无票被弹）：退避 20 秒再解新票，别连着撞网关。
      if (curTicket) {
        log('provided ticket rejected, backing off 20s before solving a new one...');
        await new Promise((r) => setTimeout(r, 20000));
      }
      log('captcha hit, trying protocol solver...');
      try {
        const { solveCaptcha } = await import('./captcha.mjs');
        const solved = await solveCaptcha({});
        log(`captcha solved x=${solved.x} in ${solved.stat?.total_ms}ms, retrying login...`);
        curTicket = solved.ticket;
        curRand = solved.randstr;
      } catch (solveErr) {
        log(`auto-solve failed: ${solveErr.message}`);
        throw new PTAError('CAPTCHA_REQUIRED', 'captcha auto-solve failed; complete the Tencent captcha once in the DSH browser and retry with --ticket <T> --rand-str <R>');
      }
    }
  }
}

// 登录：密码只在内存里用一次，调完即丢；绝不写文件、绝不记日志。
export async function loginAccount({ user, password, label, ticket = '', randStr = '', remember = false, noCaptcha = false, log = () => {} }) {
  if (!user) throw new Error('login needs a user (email or phone)');
  if (!password) throw new Error('no password given');
  // 登录限频（PTA-mcp login.py 的实测结论：20 秒）：同一登录名在间隔内
  // 重复登录会被网关限流/风控，先挡下来，别拿真号去撞。
  // 间隔可用 PTA_MIN_LOGIN_INTERVAL（秒）调，默认 20。
  const minIntervalMs = Number(process.env.PTA_MIN_LOGIN_INTERVAL || 20) * 1000;
  const lastAt = store.getLastLoginAtByLogin(user);
  if (lastAt && Date.now() - lastAt < minIntervalMs) {
    const wait = Math.ceil((minIntervalMs - (Date.now() - lastAt)) / 1000);
    throw new Error(`login too soon: wait ${wait}s (PTA login rate limit is ${minIntervalMs / 1000}s)`);
  }
  const account = store.addAccount({ label, login: user });
  store.setLastLoginAt(account.id);
  const client = new PTAClient();
  await client.prewarm();
  try {
    await loginWithCaptcha(client, { user, password, ticket, randStr, noCaptcha, log });
  } catch (e) {
    if (e.code === 'CAPTCHA_REQUIRED') store.setAccountStatus(account.id, 'manual');
    throw e;
  }
  store.writeSession(account.id, { cookie: client.cookie, updatedAt: new Date().toISOString() });
  store.setAccountStatus(account.id, 'ready');
  if (remember) {
    // 只记凭据引用（key），不记密码。密码由用户存进 DSH 凭据服务，
    // 取密码的命令配成 PTA_CREDENTIAL_CMD（见 lib/credentials.mjs）。
    const { credentialKey } = await import('./credentials.mjs');
    store.writeCredentialRef(account.id, { service: 'dsh-credentials', key: credentialKey(account.id) });
    log(`credential ref saved: ${credentialKey(account.id)} (store the password in the DSH credential service under this key; set PTA_CREDENTIAL_CMD to the command that reads it)`);
  }
  return account;
}

// 登出：清掉该账号的会话 cookie，状态置 auth_required；
// 凭据引用不动（下次登录仍可用它重登），审计日志记一笔。
export function logoutAccount(account) {
  store.clearSession(account.id);
  store.setAccountStatus(account.id, 'auth_required');
  store.appendAudit(account.id, { action: 'logout', result: 'ok' });
  return account;
}

export async function authedClient(account) {
  const session = store.readSession(account.id);
  if (!session?.cookie) throw new PTAError('NOT_LOGGED_IN', `account ${account.label} has no session, run login first`);
  const client = new PTAClient(session.cookie);
  try {
    await client.current(); // 会话复用判定
  } catch (e) {
    if (e.code === 'NOT_LOGGED_IN') {
      // 会话过期：试凭据重登（凭据引用按账号走，密码不落盘）；拿不到密码就停下报人工。
      const relogged = await tryRelogin(account);
      if (relogged) return relogged;
      throw new PTAError('NOT_LOGGED_IN', `session expired for ${account.label}, run login again (password re-entry)`);
    }
    throw e;
  }
  if (client.cookie !== session.cookie) store.writeSession(account.id, { cookie: client.cookie, updatedAt: new Date().toISOString() });
  return client;
}

// 会话过期自动重登：密码从凭据提供方拿（见 lib/credentials.mjs），
// 拿不到就返回 null，由调用方报人工。密码用完即丢，不写日志、不落盘。
export async function tryRelogin(account) {
  if (!account.login) return null; // v0.1 建的旧账号没存登录名，重登不了
  const { getPasswordForRelogin } = await import('./credentials.mjs');
  const password = await getPasswordForRelogin(account);
  if (!password) return null;
  const client = new PTAClient();
  try {
    await client.prewarm();
    await loginWithCaptcha(client, { user: account.login, password, log: () => {} });
  } catch {
    return null;
  }
  store.writeSession(account.id, { cookie: client.cookie, updatedAt: new Date().toISOString() });
  store.setAccountStatus(account.id, 'ready');
  store.appendAudit(account.id, { action: 'relogin', result: 'ok' });
  return client;
}
