import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

// 服务器一键更新：检查更新 → 拉取并部署 → 轮询状态
export default function SystemUpdate({ onClose }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const pollRef = useRef(null);

  async function loadStatus() {
    try {
      const d = await api.systemStatus();
      setStatus(d);
      if (d.enabled === false) setMsg(d.message || '未启用一键更新');
      return d;
    } catch (e) {
      setErr(e.message || '获取状态失败');
      return null;
    }
  }

  useEffect(() => {
    loadStatus();
    return () => clearInterval(pollRef.current);
  }, []);

  function startPolling() {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const d = await loadStatus();
      if (!d?.running) clearInterval(pollRef.current);
    }, 4000);
  }

  async function doUpdate() {
    setBusy(true); setErr(''); setMsg('正在启动部署…');
    try {
      const r = await api.systemUpdate();
      setMsg(r.message || '部署已启动');
      startPolling();
      setTimeout(loadStatus, 2500);
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
      setTimeout(loadStatus, 2500);
    } catch (e) {
      setErr(e.message || '启动失败');
    } finally { setBusy(false); }
  }

  const running = status?.running;
  const s = status || {};

  return (
    <div className="sheet-form">
      <p className="admin-hint">
        从 GitHub 拉取最新代码并重建 Docker 服务。部署过程约 1-3 分钟，期间页面可能短暂无法访问。
        <br />（需服务器已启用 updater 容器；桌面版无此功能）
      </p>

      {s.enabled === false ? (
        <p className="sheet-msg">{s.message}</p>
      ) : (
        <>
          <div className="sys-grid">
            <div><span>本地版本</span><code>{s.localCommit || '—'}</code></div>
            <div><span>远端版本</span><code>{s.remoteCommit || '—'}</code></div>
            <div><span>状态</span><strong className={running ? 'sys-running' : ''}>{running ? '部署中…' : (s.ok === true ? '上次部署成功' : s.ok === false ? '上次部署失败' : '就绪')}</strong></div>
          </div>

          {s.message && <p className={s.ok === false ? 'auth-error' : 'sheet-msg'}>{s.message}</p>}

          {s.log?.length > 0 && (
            <pre className="sys-log">{s.log.join('\n')}</pre>
          )}

          <div className="sheet-actions">
            <button type="button" className="btn-ghost" onClick={loadStatus} disabled={running}>刷新状态</button>
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
