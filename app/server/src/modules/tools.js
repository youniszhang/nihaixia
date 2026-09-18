// 玄枢 · 工具脚本桥
//
// 「死规矩」计算（八字排盘、塔罗抽牌、奇门排盘）一律执行 scripts/xuanshu/ 下的
// Python 脚本，结果作为权威数据拼进模型上下文；模型只解读，不自己算。
//
// 安全：所有参数先过白名单正则；子进程固定超时、限制输出体积；
// Python 解释器路径取环境变量 XUANSHU_PYTHON（默认 python3）。

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SCRIPTS_DIR } from './registry.js';

const PYTHON = process.env.XUANSHU_PYTHON || 'python3';
const TIMEOUT_MS = Number(process.env.XUANSHU_TOOL_TIMEOUT_MS || 20000);
const MAX_OUT = 20000; // 脚本输出上限（字符）

// 子进程环境变量白名单（安全）：脚本只需要解释器自身的基础变量，
// 绝不能把 LLM_API_KEY / APP_SECRET / INTERNAL_TOKEN 等整个 process.env 透传给脚本
// （脚本一旦被替换或引入第三方依赖，就等于把全套密钥交出去）。
function scriptEnv() {
  const allow = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'PYTHONPATH'];
  const env = { PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  for (const k of allow) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

function sh(args) {
  return spawn(PYTHON, args, { cwd: os.tmpdir(), env: scriptEnv() });
}

function runScript(args, { stdinData = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = sh(args);
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; child.kill('SIGKILL'); reject(new Error(`脚本执行超时（${TIMEOUT_MS}ms）`)); }
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { if (out.length < MAX_OUT * 2) out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(new Error(`无法启动 ${PYTHON}：${e.message}`)); } });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (out.length > MAX_OUT) out = out.slice(0, MAX_OUT) + '\n…（输出过长已截断）';
      if (code !== 0) {
        reject(new Error(`脚本退出码 ${code}：${(err || out || '无输出').slice(0, 300)}`));
      } else {
        resolve(out);
      }
    });
    if (stdinData) {
      child.stdin.write(stdinData);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

// ---------- 参数白名单 ----------
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const RE_SEX = /^[男女]$/;
const RE_SHICHEN = /^[子丑寅卯辰巳午未申酉戌亥]$/;
const RE_INT = /^-?\d{1,10}$/;
const RE_SAFE_TEXT = /^[\p{L}\p{N}\s，。？！、：；""''（）()\-_,.?!:;]{0,120}$/u;
const RE_SPREAD = /^(single|three|diamond|moon|horseshoe|celtic)$/;

// ---------- 八字排盘（bazi_pai_pan.py，零依赖） ----------
export async function baziPaiPan({ solar, lunar, leap, hour, shichen, sex, place } = {}) {
  const args = [path.join(SCRIPTS_DIR, 'bazi_pai_pan.py')];
  if (solar) { if (!RE_DATE.test(solar)) throw new Error('阳历日期格式应为 YYYY-MM-DD'); args.push('--solar', solar); }
  if (lunar) { if (!RE_DATE.test(lunar)) throw new Error('农历日期格式应为 YYYY-MM-DD（数字）'); args.push('--lunar', lunar); }
  if (leap) args.push('--leap');
  if (hour) { if (!RE_TIME.test(hour)) throw new Error('钟点格式应为 HH:MM'); args.push('--hour', hour); }
  if (shichen) { if (!RE_SHICHEN.test(shichen)) throw new Error('时辰应为十二地支之一'); args.push('--shichen', shichen); }
  if (!sex || !RE_SEX.test(sex)) throw new Error('性别必填（男/女，影响大运顺逆）');
  args.push('--sex', sex);
  if (place) { if (!RE_SAFE_TEXT.test(place)) throw new Error('出生地含不支持的字符'); args.push('--place', place); }
  return runScript(args);
}

// ---------- 塔罗抽牌（tarot_draw.py，零依赖） ----------
export async function tarotDraw({ spread = 'three', question = '', seed, timeFactor } = {}) {
  if (!RE_SPREAD.test(spread)) throw new Error('未知牌阵');
  const q = String(question || '').trim();
  if (q && !RE_SAFE_TEXT.test(q)) throw new Error('问题含不支持的字符');
  const args = [path.join(SCRIPTS_DIR, 'tarot_draw.py'), '--spread', spread, '--question', q];
  if (seed !== undefined && seed !== null && RE_INT.test(String(seed))) args.push('--seed', String(seed));
  if (timeFactor && /^(morning|afternoon|night)$/.test(timeFactor)) args.push('--time-factor', timeFactor);
  const raw = await runScript(args);
  try {
    return JSON.parse(raw);
  } catch {
    return { raw, note: '脚本输出非 JSON，已原文附带' };
  }
}

// ---------- 奇门排盘（qimen_cli.py，需 lunar_python） ----------
export async function qimenPaiPan({ calendarType = 'solar', timeInput, city = '', country = '中国', questionType = '', questionGoal = '' } = {}) {
  if (!/^(solar|lunar|now)$/.test(calendarType)) throw new Error('calendar_type 仅支持 solar/lunar/now');
  if (!RE_SAFE_TEXT.test(city) || !RE_SAFE_TEXT.test(questionType) || !RE_SAFE_TEXT.test(questionGoal)) {
    throw new Error('输入含不支持的字符');
  }
  let ti = null;
  if (calendarType !== 'now') {
    if (timeInput && typeof timeInput === 'object') {
      const y = Number(timeInput.year), m = Number(timeInput.month), d = Number(timeInput.day);
      const hh = Number(timeInput.hour) || 0, mm = Number(timeInput.minute) || 0;
      if (!Number.isInteger(y) || y < 1901 || y > 2100) throw new Error('年份应在 1901-2100');
      if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error('月份无效');
      if (!Number.isInteger(d) || d < 1 || d > 31) throw new Error('日期无效');
      ti = { year: y, month: m, day: d, hour: hh, minute: mm, second: 0, is_leap_month: Boolean(timeInput.isLeapMonth) };
    } else if (typeof timeInput === 'string' && RE_DATE.test(timeInput)) {
      const [y, m, d] = timeInput.split('-').map(Number);
      ti = { year: y, month: m, day: d, hour: 12, minute: 0, second: 0, is_leap_month: false };
    } else {
      throw new Error('缺少起局时间');
    }
  }
  // qimen_cli.py 走 --input/--output JSON；输出写到临时文件再读回
  const tmpIn = path.join(os.tmpdir(), `xuanshu_qm_in_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  const tmpOut = `${tmpIn}.out`;
  const payload = {
    mode: '排盘',
    calendar_type: calendarType,
    time_input: ti,
    location: { country: country || '中国', city: city || '' },
    question_type: questionType || '',
    question_goal: questionGoal || '',
  };
  fs.writeFileSync(tmpIn, JSON.stringify(payload, null, 2));
  try {
    await runScript([path.join(SCRIPTS_DIR, 'qimen_cli.py'), '--input', tmpIn, '--output', tmpOut]);
    const data = fs.readFileSync(tmpOut, 'utf8');
    try { return JSON.parse(data); } catch { return data.slice(0, MAX_OUT); }
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// 工具是否可用（脚本存在即视为可用；lunar_python 缺失在调用时报错并提示）
export function toolAvailable(script) {
  try { return fs.existsSync(path.join(SCRIPTS_DIR, script)); } catch { return false; }
}
