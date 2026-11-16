// 代码差异化：按账号种子对代码做语义不变变换，避免多账号交一模一样的代码。
// 只做三类低风险变换：局部变量改名、空行抖动、注释策略。
// 变换后必须由调用方重新跑样例验证，通过才交；验证失败回退原代码。
// 选择题答案不做变换（用户定：可以一样）。
import { createHash } from 'node:crypto';

// 确定性 PRNG（mulberry32），种子来自账号 id + 题目 id。
export function rngFromSeed(seedStr) {
  let h = 0;
  const hex = createHash('sha256').update(seedStr).digest('hex');
  h = parseInt(hex.slice(0, 8), 16) >>> 0;
  return function rand() {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RESERVED = new Set([
  // C / C++ / Java / Python 关键字与常用库标识，绝不改名。
  'int', 'long', 'short', 'char', 'float', 'double', 'void', 'bool', 'unsigned', 'signed',
  'const', 'static', 'extern', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'break', 'continue', 'struct', 'typedef', 'sizeof', 'include', 'main', 'printf',
  'scanf', 'puts', 'gets', 'malloc', 'free', 'NULL', 'true', 'false', 'class', 'public',
  'private', 'static', 'new', 'this', 'import', 'from', 'def', 'print', 'input', 'len',
  'range', 'str', 'list', 'dict', 'int', 'float', 'sum', 'max', 'min', 'abs', 'open',
  'std', 'cin', 'cout', 'endl', 'string', 'vector', 'using', 'namespace', 'template',
  'typename', 'auto', 'nullptr', 'try', 'catch', 'throw', 'finally', 'pass', 'None',
  'True', 'False', 'and', 'or', 'not', 'in', 'is', 'lambda', 'with', 'as', 'elif',
  'except', 'global', 'nonlocal', 'yield', 'async', 'await', 'assert', 'del', 'raise',
]);

// 找可改名的局部变量：C/C++ 的类型声明、Python 的赋值目标与 for 目标。
// 只改出现过至少两次的标识（声明 + 至少一次使用），避免改到只出现一次的东西。
function findRenameCandidates(code, language) {
  const counts = new Map();
  const wordRe = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m;
  while ((m = wordRe.exec(code)) !== null) {
    counts.set(m[0], (counts.get(m[0]) || 0) + 1);
  }
  const declared = new Set();
  if (/^(c|cpp|java)$/i.test(language || '')) {
    const declRe = /\b(?:int|long|short|char|float|double|bool|unsigned|size_t)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
    while ((m = declRe.exec(code)) !== null) declared.add(m[1]);
    const paramRe = /\b[A-Za-z_][A-Za-z0-9_]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/g;
    while ((m = paramRe.exec(code)) !== null) declared.add(m[1]);
  } else {
    // Python：赋值目标与 for 目标。
    const assignRe = /(?:^|[;\n]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/gm;
    while ((m = assignRe.exec(code)) !== null) declared.add(m[1]);
    const forRe = /\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g;
    while ((m = forRe.exec(code)) !== null) declared.add(m[1]);
    const defParamRe = /def\s+[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)/g;
    while ((m = defParamRe.exec(code)) !== null) {
      for (const p of m[1].split(',')) {
        const name = p.trim().split(/[:=]/)[0].trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) declared.add(name);
      }
    }
  }
  return [...declared].filter((n) => !RESERVED.has(n) && (counts.get(n) || 0) >= 2 && n.length >= 2);
}

// 空行抖动：只增删空行，不动缩进与代码行。Python 里空行永远安全。
function jitterBlankLines(code, rand) {
  const lines = code.split('\n');
  const out = [];
  for (const line of lines) {
    out.push(line);
    if (line.trim() !== '' && rand() < 0.12) out.push('');
  }
  return out.join('\n').replace(/\n{4,}/g, '\n\n\n').replace(/^\n+/, '');
}

// 注释策略：去掉整行 // 或 # 注释，或加一句中性注释。只处理行首注释，
// 不动行尾注释（避免碰到字符串里的 //）。
function toggleComments(code, language, rand) {
  const isPy = /python/i.test(language || '');
  const marker = isPy ? '#' : '//';
  const lines = code.split('\n');
  const out = [];
  let added = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(marker) && rand() < 0.5) continue; // 删一半行首注释
    out.push(line);
    if (!added && line.trim() !== '' && rand() < 0.3) {
      // 在第一段代码后加一句中性注释。
      const indent = line.match(/^\s*/)[0];
      out.push(`${indent}${marker} 先读入数据，再按题意计算`);
      added = true;
    }
  }
  return out.join('\n');
}

// 主入口：返回变换后的代码。变换是确定性的（同账号同题总是一样）。
export function varyCode(code, language, seedStr) {
  const rand = rngFromSeed(seedStr);
  let out = String(code || '');
  // 1. 局部变量改名：最多改 3 个，每个加账号相关的后缀。
  const candidates = findRenameCandidates(out, language);
  const suffix = String(Math.floor(rand() * 90) + 10); // 10–99
  const picked = candidates.sort(() => rand() - 0.5).slice(0, 3);
  for (const name of picked) {
    const replacement = `${name}_${suffix}`;
    // 换名后不得与已有标识冲突。
    if (new RegExp(`\\b${replacement}\\b`).test(out)) continue;
    out = out.replace(new RegExp(`\\b${name}\\b`, 'g'), replacement);
  }
  // 2. 空行抖动。
  out = jitterBlankLines(out, rand);
  // 3. 注释策略。
  out = toggleComments(out, language, rand);
  return out.endsWith('\n') ? out : out + '\n';
}

// 带验证的变换：变换后跑 verifyFn（应返回 { ok }），失败回退原代码。
export async function varyCodeSafe(code, language, seedStr, verifyFn) {
  const varied = varyCode(code, language, seedStr);
  if (varied === code) return { code, varied: false, verified: true };
  try {
    const res = await verifyFn(varied);
    if (res && res.ok) return { code: varied, varied: true, verified: true };
  } catch {
    // 验证抛错也算失败，回退。
  }
  return { code, varied: false, verified: false };
}
