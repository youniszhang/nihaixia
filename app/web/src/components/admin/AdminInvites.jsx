import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import Icon from '../Icon.jsx';

// 管理后台 · 邀请码：生成（含有效期与可用次数）、停用/启用、删除、复制。
// 站点为邀请制时，注册页要求填写邀请码；一码一用（可调次数），可设有效期。
function fmt(ts) {
  if (!ts) return '—';
  const d = new Date(String(ts).replace(' ', 'T') + (String(ts).includes('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString('zh-CN', { hour12: false });
}

function statusOf(c) {
  if (c.disabled) return { key: 'off', label: '已停用' };
  const now = Date.now();
  if (c.expires_at && new Date(String(c.expires_at).replace(' ', 'T') + 'Z').getTime() <= now) {
    return { key: 'expired', label: '已过期' };
  }
  if (c.used_count >= c.max_uses) return { key: 'used', label: '已用完' };
  return { key: 'ok', label: '可用' };
}

export default function AdminInvites() {
  const [invites, setInvites] = useState([]);
  const [inviteRequired, setInviteRequired] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  // 新建表单
  const [count, setCount] = useState(1);
  const [maxUses, setMaxUses] = useState(1);
  const [days, setDays] = useState(7);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api.adminInvites();
      setInvites(d.invites || []);
      setInviteRequired(Boolean(d.invite_required));
      setErr('');
    } catch (e) {
      setErr(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create() {
    setBusy(true); setErr(''); setMsg('');
    try {
      const n = Math.min(Math.max(Math.floor(Number(count) || 1), 1), 50);
      const created = [];
      for (let i = 0; i < n; i++) {
        const { invite } = await api.adminCreateInvite({
          max_uses: maxUses, expires_in_days: days, note,
        });
        created.push(invite.code);
      }
      setMsg(`已生成 ${created.length} 个：${created.join('、')}`);
      await load();
    } catch (e) {
      setErr(e.message || '生成失败');
    } finally {
      setBusy(false);
    }
  }

  async function toggle(c) {
    setBusy(true);
    try {
      await api.adminToggleInvite(c.id, !c.disabled);
      await load();
    } catch (e) {
      setErr(e.message || '操作失败');
    } finally {
      setBusy(false);
    }
  }

  async function remove(c) {
    if (!confirm(`确定删除邀请码 ${c.code}？此操作不可恢复。`)) return;
    setBusy(true);
    try {
      await api.adminDeleteInvite(c.id);
      await load();
    } catch (e) {
      setErr(e.message || '删除失败');
    } finally {
      setBusy(false);
    }
  }

  async function copy(code) {
    try {
      await navigator.clipboard.writeText(code);
      setMsg(`已复制 ${code}`);
    } catch {
      setMsg(code);
    }
  }

  if (loading) return <p className="admin-loading">加载中…</p>;

  return (
    <div className="admin-invites">
      <section className="admin-section">
        <h3><Icon name="key" size={16} /> 邀请码</h3>
        <p className="setting-desc">
          {inviteRequired
            ? '当前为邀请制：只有填写有效邀请码的人才能注册，一码可用次数与有效期由你设定。'
            : '当前「允许新用户自行注册」已开启，邀请码不是必需（仍可生成备用）。'}
        </p>

        <div className="invite-form">
          <label className="field-inline">
            <span>生成数量</span>
            <input type="number" min="1" max="50" value={count} onChange={(e) => setCount(e.target.value)} />
          </label>
          <label className="field-inline">
            <span>每码可用</span>
            <div className="field-input-unit">
              <input type="number" min="1" max="1000" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
              <em>次</em>
            </div>
          </label>
          <label className="field-inline">
            <span>有效期</span>
            <div className="field-input-unit">
              <input type="number" min="0" max="3650" value={days} onChange={(e) => setDays(e.target.value)} />
              <em>天（0 = 永久）</em>
            </div>
          </label>
          <label className="field-inline grow">
            <span>备注</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：给某某 / 某次活动" />
          </label>
          <button className="btn-primary" onClick={create} disabled={busy}>
            <Icon name="plus" size={16} /> 生成
          </button>
        </div>

        {msg && <p className="admin-ok">{msg}</p>}
        {err && <p className="auth-error">{err}</p>}
      </section>

      <section className="admin-section">
        <h3>已生成的邀请码（{invites.length}）</h3>
        {invites.length === 0 ? (
          <p className="admin-empty">还没有邀请码。设置好次数与有效期后点「生成」。</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>邀请码</th>
                <th>状态</th>
                <th>使用</th>
                <th>有效期至</th>
                <th>使用者</th>
                <th>备注</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {invites.map((c) => {
                const st = statusOf(c);
                return (
                  <tr key={c.id}>
                    <td><code className="invite-code">{c.code}</code></td>
                    <td><span className={`invite-status ${st.key}`}>{st.label}</span></td>
                    <td>{c.used_count}/{c.max_uses}</td>
                    <td>{c.expires_at ? fmt(c.expires_at) : '永久'}</td>
                    <td>{c.last_used_username || '—'}</td>
                    <td>{c.note || '—'}</td>
                    <td className="invite-actions">
                      <button className="text-btn" onClick={() => copy(c.code)} title="复制">复制</button>
                      <button className="text-btn" onClick={() => toggle(c)} disabled={busy}>
                        {c.disabled ? '启用' : '停用'}
                      </button>
                      <button className="text-btn danger" onClick={() => remove(c)} disabled={busy}>删除</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
