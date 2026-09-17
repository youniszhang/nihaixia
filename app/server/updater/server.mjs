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
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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
  checking: false,
  checkedAt: null,
  checkError: null,
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

// updater 自身的镜像也要随代码更新（server.mjs 改了、容器不重建 → 新逻辑永远不生效）。
// 但**不能在 updater 容器内**直接 `compose up updater`：compose 会先停掉本容器，
// 命令半路夭折，updater 可能就此消失。交给一个 detached 的临时容器执行 ——
// 它不在 compose 管理范围内，不受本容器生命周期影响。
//
// ⚠️ 路径坑（2026-09-17 实际踩过：把线上 updater 的 /workspace 挂成空目录，一键更新全挂）：
//   容器里的 /workspace 只是**挂载点**，宿主机真实路径是别的（如 /root/nihaixia）。
//   - `-v $PROJECT_DIR:...` 不行：拿容器内路径当宿主机路径，daemon 找不到就建空目录；
//   - `--volumes-from self` + compose 相对路径 `..` 同样不行：compose 在临时容器里把 `..`
//     解析成 /workspace，再把这个**容器内路径**发给 daemon，daemon 按**宿主机**去找 → 空目录。
//   可靠做法：先用 docker inspect 问出宿主机真实路径，然后「用宿主机路径挂进临时容器」，
//   使容器内路径 == 宿主机路径；此时 compose 的相对路径解析在客户端与 daemon 两侧一致。
// 失败只记日志：此步在 web/api 部署成功之后，不该影响本次部署结论。
async function scheduleSelfRebuild() {
  const HELPER = 'nihaixia-updater-selfbuild';
  try {
    const self = process.env.HOSTNAME;
    if (!self) throw new Error('拿不到容器 ID（HOSTNAME 为空）');

    // 问出本容器挂载在宿主机上的真实路径（Mounts.Source）
    const mountSource = async (dest) => (await run('docker', ['inspect', '-f',
      `{{range .Mounts}}{{if eq .Destination "${dest}"}}{{.Source}}{{end}}{{end}}`, self])).trim();
    const hostDir = await mountSource('/workspace');
    if (!hostDir) throw new Error('拿不到 /workspace 的宿主机路径（docker inspect 的 Mounts 为空）');
    const hostSock = (await mountSource('/var/run/docker.sock')) || '/var/run/docker.sock';

    await run('docker', ['rm', '-f', HELPER]).catch(() => {});
    await run('docker', [
      'run', '-d', '--rm', '--name', HELPER,
      // 基础镜像的 docker-entrypoint.sh 会把首参当 docker 子命令转发（同 Dockerfile 注释），
      // 这里必须显式覆盖 entrypoint，否则 `sh` 会被当成 `docker sh` 执行
      '--entrypoint', 'sh',
      // 宿主机路径挂到同名容器路径：compose 相对路径的解析结果与 daemon 查找一致
      '-v', `${hostDir}:${hostDir}`,
      '-v', `${hostSock}:/var/run/docker.sock`,
      '-w', hostDir,
      'docker:27-cli', '-c',
      `docker compose -f ${COMPOSE_FILE} --profile updater up -d --build updater`,
    ]);
    log(`🔁 已启动 updater 自更新（后台重建本容器；工作目录 ${hostDir}，页面短暂无响应属正常，稍后自动恢复）`);
  } catch (err) {
    log(`⚠️ updater 自更新启动失败（不影响本次部署）：${(err.stderr || err.message || err).toString().slice(0, 200)}`);
  }
}

async function currentCommit(ref = 'HEAD') {
  try { return await run('git', ['rev-parse', '--short', ref]); } catch { return null; }
}

// 环境自检：/workspace 必须是带 .git 的仓库，否则所有 git 操作（含版本检查/部署）都会失败。
// 2026-09-17 事故：自更新时挂载路径搞错 → 新容器里 /workspace 是空目录，
// 页面报 "fatal: not a git repository"，但失败只落在日志里、没人察觉。这里把它显性化。
function checkWorkspace() {
  try {
    const st = fs.statSync(path.join(PROJECT_DIR, '.git'));
    return st.isDirectory()
      ? { ok: true }
      : { ok: false, message: `工作目录 ${PROJECT_DIR} 下的 .git 不是目录` };
  } catch {
    // 附上宿主机视角的真实挂载来源，便于定位（容器内路径 ≠ 宿主机路径）
    let src = '';
    try {
      src = execFileSync('docker', ['inspect', '-f',
        `{{range .Mounts}}{{if eq .Destination "${PROJECT_DIR}"}}{{.Source}}{{end}}{{end}}`,
        process.env.HOSTNAME || ''], { encoding: 'utf8' }).trim();
    } catch { /* ignore */ }
    return {
      ok: false,
      message: `${PROJECT_DIR} 不是 git 仓库（缺少 .git）。宿主机挂载来源=${src || '未知'}；`
        + '若为空目录，说明重建 updater 容器时卷路径解析错误',
    };
  }
}

// 实时读取版本：本地 HEAD 总是现读（便宜）；远端要 git fetch 才知道有没有新提交，
// 只在显式要求（check=true）时执行 —— 打开「系统更新」页就会触发一次，
// 这样版本号不会像以前那样永远是「—」（此前只在部署时才写入内存）。
async function refreshVersions({ check = false } = {}) {
  state.localCommit = await currentCommit();
  if (!check || state.checking) return;
  state.checking = true;
  state.checkError = null;
  try {
    await run('git', ['fetch', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`, '--prune'], { timeout: 30000 });
    state.remoteCommit = await currentCommit(`origin/${BRANCH}`);
  } catch (err) {
    state.checkError = err.killed
      ? '拉取远端版本超时（30 秒），服务器访问 GitHub 可能较慢'
      : (err.stderr || err.message || String(err)).toString().slice(0, 300);
    // fetch 失败（服务器网络不通 GitHub 等）时不要清空上次结果，页面照旧显示旧值 + 报错
  } finally {
    state.checking = false;
    state.checkedAt = new Date().toISOString();
  }
}

async function doUpdate() {
  state.running = true;
  state.ok = null;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.stage = 'git';
  state.message = '拉取代码…';
  try {
    // 先自检工作目录：不是 git 仓库时给出可操作的错误，而不是让 git 抛晦涩报错
    const ws = checkWorkspace();
    if (!ws.ok) throw new Error(ws.message);

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
    try {
      await run(cmd, [...prefix, '-f', COMPOSE_FILE, 'up', '-d', '--build', ...SERVICES]);
    } catch (err) {
      // 已发生过的事故（2026-09-17）：compose 重建时报 "No such container: <id>"，
      // 旧入口容器已删、新容器被丢弃 → 整站 502。这里补一次不带 --build 的 up 再复查。
      log(`⚠️ 重建报错（${(err.stderr || err.message || err).toString().slice(0, 200)}），尝试单独补起入口容器…`);
      await run(cmd, [...prefix, '-f', COMPOSE_FILE, 'up', '-d', ...SERVICES]);
      log('↩  已执行补起，继续健康检查');
    }

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

    // 最后把 updater 自己也重建到位（新逻辑要重建容器才生效）。
    // 放在成功路径的最后：即使自更新失败，web/api 也已经部署成功。
    await scheduleSelfRebuild();
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
    // check=1 时实时 git fetch 拉取远端版本（页面打开/点「检查更新」用）
    const check = /(?:^|&)check=1(?:&|$)/.test(req.url.split('?')[1] || '');
    // /workspace 不是 git 仓库时，一切 git 操作都会失败——先自检并把原因显性回传
    const ws = checkWorkspace();
    if (ws.ok) await refreshVersions({ check });
    else { state.checkError = ws.message; state.localCommit = null; state.remoteCommit = null; }
    return send(res, 200, {
      running: state.running,
      ok: state.ok,
      stage: state.stage,
      message: state.message,
      workspaceOk: ws.ok,
      workspaceError: ws.ok ? null : ws.message,
      localCommit: state.localCommit,
      remoteCommit: state.remoteCommit,
      updateAvailable:
        state.localCommit && state.remoteCommit ? state.localCommit !== state.remoteCommit : null,
      checking: state.checking,
      checkedAt: state.checkedAt,
      checkError: state.checkError,
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
