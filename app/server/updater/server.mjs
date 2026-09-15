#!/usr/bin/env node
/**
 * 一键更新服务（updater）。
 * 独立容器内运行，挂载：项目目录(/workspace)、docker.sock。
 * 只在内网被主应用调用（Bearer Token 校验），不映射公网端口。
 *
 * 环境变量：
 *   UPDATER_TOKEN     必填，长随机串
 *   PROJECT_DIR       项目目录（默认 /workspace）
 *   GIT_BRANCH        分支（默认 main）
 *   SERVICE_NAME      要重建的 compose 服务（默认 web api）
 *   COMPOSE_FILE      compose 文件（默认 docker-compose.yml）
 */

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const TOKEN = process.env.UPDATER_TOKEN || '';
const PROJECT_DIR = process.env.PROJECT_DIR || '/workspace';
const BRANCH = process.env.GIT_BRANCH || 'main';
const COMPOSE_FILE = process.env.COMPOSE_FILE || 'docker-compose.yml';
const SERVICES = (process.env.SERVICE_NAME || 'web api').split(/\s+/).filter(Boolean);
const PORT = Number(process.env.PORT || 8765);

const state = {
  running: false,
  ok: null,
  stage: 'idle',
  message: '就绪',
  startedAt: null,
  finishedAt: null,
  localCommit: null,
  remoteCommit: null,
  log: [],
};

function log(line) {
  const t = new Date().toISOString().slice(11, 19);
  state.log.push(`[${t}] ${line}`);
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
  console.log(line);
}

async function run(cmd, args, opts = {}) {
  const { stdout } = await exec(cmd, args, { cwd: PROJECT_DIR, maxBuffer: 10 * 1024 * 1024, ...opts });
  return stdout.trim();
}

// 自动探测 docker compose v2 / v1
let composeCmd = null;
async function detectCompose() {
  if (composeCmd) return composeCmd;
  try {
    await exec('docker', ['compose', 'version']);
    composeCmd = ['docker', ['compose']];
  } catch {
    await exec('docker-compose', ['version']);
    composeCmd = ['docker-compose', []];
  }
  return composeCmd;
}

async function currentCommit(ref = 'HEAD') {
  try { return await run('git', ['rev-parse', '--short', ref]); } catch { return null; }
}

async function doUpdate() {
  state.running = true;
  state.ok = null;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.stage = 'git';
  state.message = '拉取代码…';
  try {
    state.localCommit = await currentCommit();

    // 检查已跟踪文件是否被本地改动（避免覆盖服务器热修）
    const dirty = await run('git', ['status', '--porcelain', '--untracked-files=no']);
    if (dirty) {
      throw new Error(`项目目录存在未提交改动，已停止部署：\n${dirty.slice(0, 300)}`);
    }

    log('git fetch…');
    await run('git', ['fetch', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`, '--prune']);
    state.remoteCommit = await currentCommit(`origin/${BRANCH}`);
    log(`本地 ${state.localCommit} → 远端 ${state.remoteCommit}`);

    await run('git', ['checkout', '-B', BRANCH, `origin/${BRANCH}`]);
    state.localCommit = await currentCommit();
    log(`已更新到 ${state.localCommit}`);

    state.stage = 'build';
    state.message = '重建镜像并重启服务…';
    const [cmd, prefix] = await detectCompose();
    log(`${cmd} ${prefix.join(' ')} up -d --build ${SERVICES.join(' ')}`);
    await run(cmd, [...prefix, '-f', COMPOSE_FILE, 'up', '-d', '--build', ...SERVICES]);

    state.stage = 'health';
    state.message = '健康检查…';
    // 等主服务就绪（容器内通过服务名访问）
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch('http://api:8080/health', { signal: AbortSignal.timeout(3000) });
        if (res.ok) { healthy = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!healthy) throw new Error('新版本健康检查未通过（http://api:8080/health）');

    state.ok = true;
    state.stage = 'done';
    state.message = '部署完成，健康检查已通过';
    log('✅ 部署完成');
  } catch (err) {
    state.ok = false;
    state.stage = 'failed';
    state.message = (err.stderr || err.message || String(err)).slice(0, 600);
    log(`❌ 部署失败：${state.message}`);
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }
}

async function doRestart() {
  state.running = true;
  state.ok = null;
  state.startedAt = new Date().toISOString();
  state.stage = 'build';
  state.message = '重建并重启服务（不拉代码）…';
  try {
    const [cmd, prefix] = await detectCompose();
    await run(cmd, [...prefix, '-f', COMPOSE_FILE, 'up', '-d', '--build', ...SERVICES]);
    state.ok = true;
    state.stage = 'done';
    state.message = '重启完成';
  } catch (err) {
    state.ok = false;
    state.stage = 'failed';
    state.message = (err.stderr || err.message || String(err)).slice(0, 600);
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(res, 403, { error: 'forbidden' });
  }
  const url = req.url.split('?')[0];

  if (url === '/health') return send(res, 200, { ok: true });

  if (url === '/status') {
    return send(res, 200, {
      running: state.running,
      ok: state.ok,
      stage: state.stage,
      message: state.message,
      localCommit: state.localCommit,
      remoteCommit: state.remoteCommit,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      log: state.log.slice(-40),
    });
  }

  if (url === '/update' && req.method === 'POST') {
    if (state.running) return send(res, 409, { accepted: false, message: '已有部署任务在运行' });
    state.log = [];
    doUpdate(); // 异步执行，立即返回
    return send(res, 202, { accepted: true, running: true, message: '部署任务已启动，正在后台拉取代码并重建服务' });
  }

  if (url === '/restart' && req.method === 'POST') {
    if (state.running) return send(res, 409, { accepted: false, message: '已有任务在运行' });
    state.log = [];
    doRestart();
    return send(res, 202, { accepted: true, running: true, message: '重启任务已启动' });
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => console.log(`updater listening on :${PORT}`));
