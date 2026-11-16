// 账号凭据引用：密码永远不落盘。登录时密码只用一次；需要重登时按以下顺序找密码，
// 找不到就停下报人工，不猜、不存、不写日志。
// 1. 环境变量 PTA_PASSWORD + PTA_PASSWORD_ACCOUNT（label 或 id 必须匹配该账号，
//    否则不用 —— 避免拿 A 号的密码去登 B 号触发风控）。
// 2. PTA_CREDENTIAL_CMD：一条取密码的命令模板，{key} 会被替换成凭据 key，
//    例如 `dsh credentials get {key}`。命令的标准输出（去空白后）就是密码。
//    这是 DSH 凭据服务的接入口：用户在 DSH 里把密码存进凭据服务，
//    再把取密码的命令配成 PTA_CREDENTIAL_CMD。
// 3. DSH_CREDENTIALS_DIR：一个目录，里面按凭据 key 放文件，文件内容就是密码
//    （DSH 凭据服务把凭据以文件形式挂进工作区时用）。
// 凭据 key 格式：dsh-pta/account-<accountId>。只存 key 的引用，不存密码本身。
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function credentialKey(accountId) {
  return `dsh-pta/account-${accountId}`;
}

// 返回密码字符串，或 null（找不到）。调用方用完立即丢弃，不得写日志、不得落盘。
export async function getPasswordForRelogin(account) {
  // 1. 环境变量（必须同时指定账号，否则不用）。
  if (process.env.PTA_PASSWORD && process.env.PTA_PASSWORD_ACCOUNT
    && (process.env.PTA_PASSWORD_ACCOUNT === account.id || process.env.PTA_PASSWORD_ACCOUNT === account.label)) {
    return process.env.PTA_PASSWORD;
  }
  // 2. 取密码的命令（DSH 凭据服务接入口）。
  const cmdTemplate = process.env.PTA_CREDENTIAL_CMD || '';
  if (cmdTemplate) {
    const key = credentialKey(account.id);
    const cmd = cmdTemplate.replaceAll('{key}', key).replaceAll('{id}', account.id).replaceAll('{label}', account.label);
    try {
      const { stdout } = await execFileAsync('/bin/sh', ['-c', cmd], { timeout: 15000, maxBuffer: 1024 * 1024 });
      const pw = String(stdout || '').trim().split('\n')[0]?.trim();
      if (pw) return pw;
    } catch {
      // 命令失败就当没找到，继续往下找，不抛错。
    }
  }
  // 3. 凭据目录挂载。
  const dir = process.env.DSH_CREDENTIALS_DIR || '';
  if (dir) {
    const file = join(dir, credentialKey(account.id));
    try {
      if (existsSync(file)) {
        const pw = readFileSync(file, 'utf8').trim().split('\n')[0]?.trim();
        if (pw) return pw;
      }
    } catch { /* ignore */ }
  }
  return null;
}
