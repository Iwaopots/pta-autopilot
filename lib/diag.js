/**
 * 面板/登录诊断日志：DSH 桌面端不持久化宿主日志，插件自己落一份 JSONL。
 *
 * 位置：<stateDir>/logs/plugin.log；超过 2 MB 时改名带时间戳。
 * 只记动作、错误码、耗时和脱敏后的错误文本，绝不记密码、Cookie、ticket。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;

export function createDiagLog(stateDir) {
  const dir = join(stateDir, 'logs');
  const file = join(dir, 'plugin.log');
  let ready = false;
  let checkedAt = 0;

  const write = (level, event, data) => {
    try {
      if (!ready) {
        mkdirSync(dir, { recursive: true });
        ready = true;
      }
      const now = Date.now();
      if (now - checkedAt > 60_000) {
        checkedAt = now;
        try {
          if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.${now}`);
        } catch {
          /* 首次写或轮转失败都不影响写日志 */
        }
      }
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), level, event, ...data })}\n`, 'utf8');
    } catch {
      /* 日志失败不能影响主流程 */
    }
  };

  return {
    file,
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
  };
}
