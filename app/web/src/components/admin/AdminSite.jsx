import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

// 站点设置：注册开关 + 管理员来源说明 + 操作审计
export default function AdminSite() {
  const [site, setSite] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setSite(await api.adminGetSite());
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  function flash(t) { setMsg(t); setTimeout(() => setMsg(''), 3000); }

  async function toggleRegistration() {
    const next = !site.registration_enabled;
    setBusy(true); setErr('');
    try {
      setSite(await api.adminSaveSite({ registration_enabled: next }));
      flash(next ? '已开启注册' : '已关闭注册');
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  if (!site) return err ? <p className="auth-error">{err}</p> : <p className="admin-loading">加载中…</p>;

  return (
    <div className="admin-site">
      <section className="admin-section">
        <h3>用户注册</h3>
        <div className="setting-row">
          <div>
            <strong>允许新用户自行注册</strong>
            <p className="setting-desc">
              关闭后，登录页隐藏「注册」入口，注册接口也会拒绝请求；新账号只能由管理员在「用户管理」中创建。
              {!site.registration_explicit && site.registration_enabled && (
                <><br /><span className="setting-warn">当前为默认开放（兼容既有部署）。切换一次后会写入明确设置。</span></>
              )}
            </p>
          </div>
          <button
            className={`switch ${site.registration_enabled ? 'on' : ''}`}
            onClick={toggleRegistration}
            disabled={busy}
            role="switch"
            aria-checked={site.registration_enabled}
            aria-label="允许新用户自行注册"
          >
            <span className="switch-knob" />
          </button>
        </div>
      </section>

      <section className="admin-section">
        <h3>管理员</h3>
        <div className="setting-row">
          <div>
            <strong>管理员账号由配置文件指定</strong>
            <p className="setting-desc">
              在服务器 <code>.env</code> 中设置 <code>ADMIN_USERNAME=用户名</code>，重启后生效。
              该账号即唯一管理员（不再由「第一个注册的用户」自动担任）。
              {site.admin_source === 'legacy' && (
                <><br /><span className="setting-warn">当前未配置 ADMIN_USERNAME，正沿用老规则（第一个注册的用户）。建议尽快在 .env 中明确指定。</span></>
              )}
            </p>
          </div>
          <div className="setting-value">
            {site.admin_username
              ? <code>{site.admin_username}</code>
              : <span className="setting-warn">未配置</span>}
          </div>
        </div>
      </section>

      <AuditLog />

      {msg && <p className="sheet-msg">{msg}</p>}
      {err && <p className="auth-error">{err}</p>}
    </div>
  );
}

function AuditLog() {
  const [logs, setLogs] = useState([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.adminAudit(100).then((d) => setLogs(d.logs || [])).catch((e) => setErr(e.message));
  }, []);

  const LABELS = {
    'user.create': '创建用户',
    'user.update': '修改用户',
    'user.delete': '删除用户',
    'user.bulk_disable': '批量禁用',
    'user.bulk_enable': '批量启用',
    'user.bulk_delete': '批量删除',
    'site.registration': '注册开关',
  };

  return (
    <section className="admin-section">
      <h3>操作审计（最近 100 条）</h3>
      {err && <p className="auth-error">{err}</p>}
      <table className="admin-table">
        <thead>
          <tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>详情</th></tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id}>
              <td className="td-dim">{l.created_at}</td>
              <td>{l.actor_username || '—'}</td>
              <td>{LABELS[l.action] || l.action}</td>
              <td>{l.target || '—'}</td>
              <td className="td-dim">{l.detail || '—'}</td>
            </tr>
          ))}
          {logs.length === 0 && <tr><td colSpan={5} className="td-empty">暂无记录</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
