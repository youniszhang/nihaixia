/**
 * DeepSeek 网页版自动化（0 Token 问诊通道）。
 * 移植自 obsidian-ai-explainer 参考实现：CDP 驱动专用 Chrome（独立 profile，
 * 登录态持久），注入提示词并拦截网页版 /chat/completion 的 SSE（JSON-Patch）流。
 *
 * 使用前提：在弹出的专用浏览器窗口里登录 chat.deepseek.com 一次（登录态持久保存）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { CDPClient, listTargets, newTab } from './cdp.js';

const PROFILE_DIR = path.join(os.tmpdir(), 'nihaixia-dsweb-profile');

export function findBrowserBinary() {
  const platform = process.platform;
  const candidates =
    platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          path.join(process.env.HOME || '', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        ]
      : platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/usr/bin/microsoft-edge',
          ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

/** 启动专用浏览器（独立 profile，登录态持久）。已启动则复用。 */
export async function ensureBrowser(port, headless = false) {
  try {
    await listTargets(port);
    return; // already running
  } catch { /* not running */ }
  const bin = findBrowserBinary();
  if (!bin) throw new Error('未找到 Chrome/Edge，请先安装后重试');
  let proxyFlag = '';
  try {
    if (process.platform === 'darwin') {
      const out = execSync('scutil --proxy', { encoding: 'utf8' });
      const m = out.match(/HTTPSEnable\s*:\s*1[\s\S]*?HTTPSProxy\s*:\s*([^\s]+)[\s\S]*?HTTPSPort\s*:\s*(\d+)/);
      if (m) proxyFlag = `--proxy-server=${m[1].trim()}:${m[2]}`;
    }
  } catch {}
  const flags = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (headless) flags.push('--headless=new', '--window-size=1400,900');
  if (proxyFlag) flags.push(proxyFlag);
  flags.push('https://chat.deepseek.com/');
  const cmdStr = JSON.stringify(bin) + ' ' + flags.map((f) => JSON.stringify(f)).join(' ');
  spawn('/bin/sh', ['-c', `nohup ${cmdStr} > /dev/null 2>&1 &`], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { await listTargets(port); return; } catch {}
  }
  throw new Error('浏览器启动超时（调试端口未就绪）');
}

/** 连接到 DeepSeek 页面（不存在则新开），并导航到新对话页。 */
export async function connectDeepSeek(port, headless = false) {
  await ensureBrowser(port, headless);
  let targets = await listTargets(port);
  let target = targets.find((t) => t.url.includes('chat.deepseek.com') && t.webSocketDebuggerUrl && t.type === 'page');
  if (!target) {
    target = await newTab(port, 'https://chat.deepseek.com/');
  }
  const client = await CDPClient.connect(target.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  if (!target.url.includes('chat.deepseek.com')) {
    await client.send('Page.navigate', { url: 'https://chat.deepseek.com/' });
    await new Promise((r) => setTimeout(r, 2500));
  }
  // 每次开全新会话：网页端同一会话保留上下文，会污染新问题
  await client.send('Page.navigate', { url: 'https://chat.deepseek.com/' });
  await new Promise((r) => setTimeout(r, 4000));
  await client.evaluate('document.readyState');
  return client;
}

/** 页面内探针：登录态 / 输入框（中英文界面都覆盖） */
const PROBE = `(function(){
  const editor = document.querySelector('textarea#chat-input, textarea[placeholder], div[contenteditable="true"]');
  const btns = [...document.querySelectorAll('div[role="button"], button, a')].map(b=>(b.innerText||'').trim()).filter(Boolean);
  const hasLoginBtn = btns.some(t=>/^登录$/.test(t)||/^log ?in$/i.test(t)||/^sign ?in$/i.test(t));
  const hasLogoutBtn = btns.some(t=>/退出|log ?out|sign ?out/i.test(t));
  // 登录表单的强特征（未登录首页特有）
  const loginMarkers = btns.filter(t=>/立即注册|忘记密码|使用 ?Google ?账号登录|使用 ?Apple ?账号登录|create ?account|forgot ?password/i.test(t));
  return {
    hasEditor: !!editor,
    hasLoginBtn, hasLogoutBtn,
    loginMarkerCount: loginMarkers.length,
    url: location.href
  };
})()`;

function judgeLogin(info) {
  // 登录表单强特征 or 无输入框但有登录按钮 → 未登录
  if (info.loginMarkerCount >= 1) return false;
  if (!info.hasEditor && info.hasLoginBtn) return false;
  if (info.hasEditor && info.hasLoginBtn) return false;
  if (info.hasEditor && info.hasLogoutBtn) return true;
  // 输入框存在但无法确认（页面可能未渲染完）→ 交给调用方二次探测
  return info.hasEditor ? null : false;
}

export async function checkLogin(client) {
  let info = await client.evaluate(PROBE);
  let loggedIn = judgeLogin(info);
  if (loggedIn === null) {
    // 模糊状态：等页面渲染完再探一次
    await new Promise((r) => setTimeout(r, 2500));
    info = await client.evaluate(PROBE);
    loggedIn = judgeLogin(info);
  }
  return { loggedIn: loggedIn === true, hasEditor: info.hasEditor, info };
}

/** 设置开关（专家模式=深度思考 / 智能搜索），容错：找不到按钮不算失败 */
export async function setToggle(client, keyword, on) {
  const js = `(function(){
  const kw = ${JSON.stringify(keyword)};
  const target = ${JSON.stringify(on)};
  const chip = [...document.querySelectorAll('div, span, p')]
    .filter(x => x.children.length === 0 && (x.textContent || '').trim() === kw.replace('深度思考', '专家模式').replace('联网搜索', '智能搜索'))
    .pop();
  if (chip) { chip.click(); return true; }
  const toggles = [...document.querySelectorAll('.ds-toggle-button')];
  for (const b of toggles) {
    const t = (b.innerText||'').trim();
    if (!t.includes(kw)) continue;
    const active = b.className.includes('active') || b.className.includes('selected') || b.className.includes('primary');
    if (active !== target) b.click();
    return true;
  }
  const btns = [...document.querySelectorAll('div[role="button"], button')];
  for (const b of btns) {
    const t = (b.innerText||'').trim();
    if (!t.includes(kw)) continue;
    b.click();
    return true;
  }
  return false;
})()`;
  return (await client.evaluate(js)) === true;
}

const SET_TEXT = `(function(){
  const text = "__TEXT__";
  const editor = document.querySelector('textarea#chat-input, textarea[placeholder], div[contenteditable="true"]');
  if (!editor) return false;
  editor.focus();
  if (editor.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(editor, text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
  }
  return true;
})()`;

function buildSetTextJs(text) {
  return SET_TEXT.replace('"__TEXT__"', JSON.stringify(text));
}

/** 页面内拦截器：捕获 /chat/completion 的 SSE 原始流（JSON-Patch 流式） */
const INSTALL_CAPTURE = `(function(){
  window.__aieSSE = '';
  window.__aieDone = false;
  window.__aieUrl = '';
  if (window.__aiePatched) return 'reset';
  window.__aiePatched = true;
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = (typeof args[0] === 'string') ? args[0] : (args[0]?.url || '');
      if (String(url).includes('/chat/completion')) {
        window.__aieUrl = String(url);
        const clone = res.clone();
        (async () => {
          try {
            const reader = clone.body.getReader();
            const dec = new TextDecoder();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              window.__aieSSE += dec.decode(value, { stream: true });
            }
          } finally { window.__aieDone = true; }
        })();
      }
    } catch (e) { window.__aiePatchErr = String(e); }
    return res;
  };
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new OrigXHR();
    const origOpen = xhr.open;
    xhr.open = function(method, url, ...rest) {
      if (String(url).includes('/chat/completion')) {
        window.__aieUrl = String(url);
        xhr.addEventListener('progress', () => { window.__aieSSE = xhr.responseText || ''; });
        xhr.addEventListener('loadend', () => { window.__aieSSE = xhr.responseText || ''; window.__aieDone = true; });
      }
      return origOpen.call(xhr, method, url, ...rest);
    };
    return xhr;
  };
  return 'installed';
})()`;

/** 解析 DeepSeek 新版 JSON-Patch SSE 流 → { content, thinking, finished } */
export function parseDSWebSSE(sse) {
  const fragments = [];
  let appendToContent = false;
  let finished = false;
  for (const rawLine of sse.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    let j;
    try { j = JSON.parse(payload); } catch { continue; }
    const resp = j?.v && typeof j.v === 'object' ? j.v.response : undefined;
    if (resp && typeof resp === 'object') {
      if (Array.isArray(resp.fragments)) {
        for (const f of resp.fragments) fragments.push({ type: f.type ?? '', content: f.content ?? '' });
      }
      if (resp.quasi_status === 'FINISHED' || resp.status === 'FINISHED') finished = true;
      continue;
    }
    if (j.p) {
      if (j.p === 'response/fragments' && Array.isArray(j.v)) {
        for (const f of j.v) fragments.push({ type: f.type ?? '', content: f.content ?? '' });
        appendToContent = true;
      } else if (j.p === 'response/fragments/-1/content' && j.o === 'APPEND') {
        const last = fragments[fragments.length - 1];
        if (last) last.content += String(j.v ?? '');
        appendToContent = true;
      } else if (j.p === 'response/status' && j.v === 'FINISHED') {
        finished = true;
      } else if (j.p === 'response' && j.o === 'BATCH' && Array.isArray(j.v)) {
        for (const b of j.v) {
          if (b.p === 'quasi_status' && b.v === 'FINISHED') finished = true;
        }
      }
      continue;
    }
    if (j.v !== undefined && appendToContent) {
      const last = fragments[fragments.length - 1];
      if (last && typeof j.v === 'string') last.content += j.v;
    }
  }
  const content = fragments.filter((f) => f.type === 'RESPONSE').map((f) => f.content).join('');
  const thinking = fragments.filter((f) => f.type === 'THINK').map((f) => f.content).join('');
  return { content, thinking, finished };
}

const CLICK_SEND = `(function(){
  const editor = document.querySelector('textarea#chat-input, textarea[placeholder], div[contenteditable="true"]');
  const scope = editor ? (editor.closest('[class*="input"], [class*="Input"], form') || editor.parentElement?.parentElement?.parentElement || document) : document;
  const primaries = [...scope.querySelectorAll('.ds-button--primary')].filter(b => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (primaries.length) {
    const btn = primaries[primaries.length - 1];
    if (btn.getAttribute('aria-disabled') !== 'true') { btn.click(); return 'primary'; }
  }
  const allPrimary = [...document.querySelectorAll('.ds-button--primary')].filter(b => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top > innerHeight * 0.5;
  });
  if (allPrimary.length) {
    allPrimary.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
    allPrimary[0].click();
    return 'primary-global';
  }
  const byAria = document.querySelector('[aria-label*="发送"], button[aria-label*="send" i]');
  if (byAria && byAria.getAttribute('aria-disabled') !== 'true') { byAria.click(); return 'aria'; }
  if (editor) {
    editor.focus();
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    return 'enter';
  }
  return false;
})()`;

export function killBrowser() {
  try { execSync('pkill -f "nihaixia-dsweb-profile"', { stdio: 'ignore' }); } catch {}
}

/**
 * 发起一次网页版提问，流式返回增量文本。
 * yields: { type: 'delta'|'thinking'|'done', text }
 */
export async function* askStream(client, { prompt, expertMode = true, webSearch = false, timeoutMs = 240000 }) {
  await client.send('Page.navigate', { url: 'https://chat.deepseek.com/' });
  await new Promise((r) => setTimeout(r, 4000));
  await client.evaluate(INSTALL_CAPTURE);
  if (expertMode) {
    await setToggle(client, '专家模式', true);
    await setToggle(client, '深度思考', true);
  }
  await setToggle(client, '智能搜索', !!webSearch);
  await setToggle(client, '联网搜索', !!webSearch);

  await client.evaluate(buildSetTextJs(''));
  const okSetText = await client.evaluate(buildSetTextJs(prompt));
  if (!okSetText) throw new Error('未能定位输入框（网页结构可能已变化）');
  const sent = await client.evaluate(CLICK_SEND);
  if (!sent) throw new Error('点击发送失败');

  const deadline = Date.now() + timeoutMs;
  let sse = '';
  let sentLen = 0; // already-yielded content length
  let stableCount = 0;
  let lastResponseLen = -1;
  let done = false;
  await new Promise((r) => setTimeout(r, 1500));
  while (Date.now() < deadline) {
    const st = await client.evaluate(
      "JSON.stringify({ sse: window.__aieSSE || '', done: !!window.__aieDone })"
    );
    let parsed = {};
    try { parsed = JSON.parse(st || '{}'); } catch {}
    const cur = parsed.sse ?? '';
    if (cur.length > 0) {
      sse = cur;
      const result = parseDSWebSSE(sse);
      if (result.content && result.content.length > sentLen) {
        yield { type: 'delta', text: result.content.slice(sentLen) };
        sentLen = result.content.length;
      }
      if (result.finished && result.content) {
        yield { type: 'done', thinking: result.thinking || '' };
        done = true;
        return;
      }
      if (cur.length === lastResponseLen) {
        stableCount++;
        if (stableCount >= 2 && parsed.done && result.content) {
          yield { type: 'done', thinking: result.thinking || '' };
          done = true;
          return;
        }
      } else {
        stableCount = 0;
        lastResponseLen = cur.length;
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (done) return;
  // 超时：有部分内容则收尾返回
  if (sse) {
    const result = parseDSWebSSE(sse);
    if (result.content) {
      if (result.content.length > sentLen) yield { type: 'delta', text: result.content.slice(sentLen) };
      yield { type: 'done', thinking: result.thinking || '' };
      return;
    }
  }
  throw new Error(
    '等待网页版回复超时。常见原因：专用浏览器网络不通（需代理）或 DeepSeek 风控；可关闭专用浏览器后重开重试。'
  );
}

/** 登录辅助：打开可见窗口供用户登录 */
export async function openLoginWindow(port) {
  await ensureBrowser(port, false);
  const targets = await listTargets(port);
  const target = targets.find((t) => t.url.includes('chat.deepseek.com') && t.webSocketDebuggerUrl && t.type === 'page');
  if (!target) await newTab(port, 'https://chat.deepseek.com/');
  return { ok: true };
}

/** 登录检测：连接页面并检查登录态（DeepSeek WAF 拦无头浏览器，必须用有头窗口） */
export async function checkLoginStatus(port) {
  const client = await connectDeepSeek(port, false);
  try {
    const res = await checkLogin(client);
    return res;
  } finally {
    client.close();
  }
}
