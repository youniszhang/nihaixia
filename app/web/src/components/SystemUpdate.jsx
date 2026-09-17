import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

// 服务器一键更新：打开即检查更新（实时 git fetch）→ 拉取并部署 → 轮询状态
export default function SystemUpdate({ onClose }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const pollRef = useRef(null);

  // check=true 时服务端会实时 git fetch（几秒），期间给「检查中…」反馈
  async function loadStatus(check = false) {
    if (check) setChecking(true);
    try {
      const d = await api.systemStatus(check);
      setStatus(d);
      if (d.enabled === false) setMsg(d.message || '未启用一键更新');
      return d;
    } catch (e) {
      setErr(e.message || '获取状态失败');
      return null;
    } finally {
      if (check) setChecking(false);
    }
  }

  useEffect(() => {
    // 打开页面就检查一次远端版本（此前版本号永远是「—」，因为只在部署时才写入内存）
    loadStatus(true);
    return () => clearInterval(pollRef.current);
  }, []);

  function startPolling() {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const d = await loadStatus(false);
      if (!d?.running) {
        clearInterval(pollRef.current);
        // 部署结束后再拉一次远端（部署后本地版本已变，顺便刷新对比）
        setTimeout(() => loadStatus(true), 1500);
      }
    }, 4000);
  }

  async function doUpdate() {
    setBusy(true); setErr(''); setMsg('正在启动部署…');
    try {
      const r = await api.systemUpdate();
      setMsg(r.message || '部署已启动');
      startPolling();
      setTimeout(() => loadStatus(false), 2500);
    } catch (e) {
      setErr(e.message || '启动失败');
    } finally { setBusy(false); }
  }

  async function doRestart() {
    setBusy(true); setErr(''); setMsg('正在重启服务…');
    try {
      const r = await api.systemRestart();
      setMsg(r.message || '重启已启动');
      startPolling();
      setTimeout(() => loadStatus(false), 2500);
    } catch (e) {
      setErr(e.message || '启动失败');
    } finally { setBusy(false); }
  }

  const running = status?.running;
  const s = status || {};
  const upd = s.updateAvailable;

  return (
    <div className="sheet-form">
      <p className="admin-hint">
        从 GitHub 拉取最新代码并重建 Docker 服务。部署过程约 1-3 分钟，期间页面可能短暂无法访问。
        <br />（需服务器已启用 updater 容器；桌面版无此功能）
      </p>

      {s.enabled === false ? (
        <p className="sheet-msg">{s.message}</p>
      ) : s.error ? (
        // updater 不可达（例如它正在自更新重建中，几秒内会恢复）
        <p className="auth-error">{s.error}（若刚完成部署，属 updater 正在重建，稍后点「检查更新」重试）</p>
      ) : (
        <>
          <div className="sys-grid">
            <div>
              <span>本地版本</span>
              <code title={s.localCommit || ''}>{s.localCommit || '—'}</code>
            </div>
            <div>
              <span>远端版本</span>
              <code title={s.remoteCommit || ''}>{checking ? '检查中…' : (s.remoteCommit || '—')}</code>
            </div>
            <div>
              <span>更新状态</span>
              <strong className={upd ? 'sys-has-update' : ''}>
                {checking ? '检查中…'
                  : upd === true ? '有新版本可部署'
                  : upd === false ? '已是最新'
                  : '未知'}
              </strong>
            </div>
            <div>
              <span>运行状态</span>
              <strong className={running ? 'sys-running' : ''}>
                {running ? '部署中…' : (s.ok === true ? '上次部署成功' : s.ok === false ? '上次部署失败' : '就绪')}
              </strong>
            </div>
          </div>

          {/* 工作目录异常（如重建容器时卷挂错 → /workspace 不是 git 仓库）要单独说清楚，
              否则只会看到一句「检查远端版本失败：fatal: not a git repository」 */}
          {s.workspaceOk === false ? (
            <p className="auth-error">
              服务器工作目录异常：{s.workspaceError}
              <br />（一键更新需要 updater 容器能访问仓库目录；请检查服务器上 updater 的卷挂载，
              或在服务器执行 <code>cd /root/nihaixia/app &amp;&amp; docker compose --profile updater up -d updater</code> 重建该容器）
            </p>
          ) : (
            <>
              {upd === true && !running && (
                <p className="sys-update-tip">
                  远端有新提交（{s.localCommit || '?'} → {s.remoteCommit || '?'}），点「拉取并部署」即可上线。
                </p>
              )}
              {s.checkError && <p className="auth-error">检查远端版本失败：{s.checkError}</p>}
              {!s.checkError && s.checkedAt && !checking && (
                <p className="admin-hint">远端版本核对于 {String(s.checkedAt).replace('T', ' ').slice(0, 19)}（UTC）</p>
              )}
            </>
          )}

          {/* 初始 message 就是「就绪」，与上面的运行状态重复，只在有实质状态时显示 */}
          {s.message && (running || s.ok != null) && (
            <p className={s.ok === false ? 'auth-error' : 'sheet-msg'}>{s.message}</p>
          )}

          {s.log?.length > 0 && (
            <pre className="sys-log">{s.log.join('\n')}</pre>
          )}

          <div className="sheet-actions">
            <button type="button" className="btn-ghost" onClick={() => loadStatus(true)} disabled={checking || running}>
              {checking ? '检查中…' : '检查更新'}
            </button>
            <button type="button" className="btn-ghost" onClick={doRestart} disabled={busy || running}>仅重启服务</button>
            <button type="button" className="btn-primary" onClick={doUpdate} disabled={busy || running}>
              {running ? '部署中…' : '拉取并部署'}
            </button>
          </div>
        </>
      )}

      {msg && <p className="sheet-msg">{msg}</p>}
      {err && <p className="auth-error">{err}</p>}

      <div className="sheet-actions">
        <button type="button" className="btn-ghost" onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}
