import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

function fmtTime(t) {
  return t ? t.replace('T', ' ').slice(0, 16) : '—';
}

export default function AdminUsers({ onViewConversations }) {
  const [users, setUsers] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // 新建用户表单
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPass, setNewPass] = useState('');

  // 重置密码
  const [pwFor, setPwFor] = useState(null);
  const [pwValue, setPwValue] = useState('');

  async function load() {
    try {
      const d = await api.adminListUsers();
      setUsers(d.users || []);
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  function flash(t) { setMsg(t); setTimeout(() => setMsg(''), 3000); }

  async function createUser(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api.adminCreateUser(newName.trim(), newPass);
      setShowCreate(false); setNewName(''); setNewPass('');
      flash('用户已创建');
      await load();
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  }

  async function toggleStatus(u) {
    const next = u.status === 'disabled' ? 'active' : 'disabled';
    if (next === 'disabled' && !confirm(`确定禁用「${u.username}」？该用户将立即无法登录和提问。`)) return;
    setErr('');
    try {
      await api.adminUpdateUser(u.id, { status: next });
      flash(next === 'disabled' ? '已禁用' : '已启用');
      await load();
    } catch (e) { setErr(e.message); }
  }

  async function removeUser(u) {
    if (!confirm(`确定删除「${u.username}」及其全部问诊记录？此操作不可恢复。`)) return;
    setErr('');
    try {
      await api.adminDeleteUser(u.id);
      flash('用户已删除');
      await load();
    } catch (e) { setErr(e.message); }
  }

  async function savePassword(e) {
    e.preventDefault();
    if (!pwValue) return;
    setBusy(true); setErr('');
    try {
      await api.adminUpdateUser(pwFor.id, { password: pwValue });
      setPwFor(null); setPwValue('');
      flash('密码已重置');
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="admin-users">
      <div className="admin-toolbar">
        <span className="admin-count">共 {users.length} 位用户</span>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>＋ 新建用户</button>
      </div>

      {msg && <p className="sheet-msg">{msg}</p>}
      {err && <p className="auth-error">{err}</p>}

      <table className="admin-table">
        <thead>
          <tr>
            <th>用户名</th>
            <th>状态</th>
            <th>问诊</th>
            <th>提问数</th>
            <th>调用数</th>
            <th>注册时间</th>
            <th>最近登录</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={u.status === 'disabled' ? 'row-disabled' : ''}>
              <td>
                <strong>{u.username}</strong>
                {u.is_admin && <span className="badge badge-admin">管理员</span>}
              </td>
              <td>
                <span className={`badge ${u.status === 'disabled' ? 'badge-off' : 'badge-on'}`}>
                  {u.status === 'disabled' ? '已禁用' : '正常'}
                </span>
              </td>
              <td>{u.session_count}</td>
              <td>{u.question_count}</td>
              <td>{u.call_count}</td>
              <td className="td-dim">{fmtTime(u.created_at)}</td>
              <td className="td-dim">{fmtTime(u.last_login_at)}</td>
              <td className="td-actions">
                <button className="link-btn" onClick={() => onViewConversations(u)}>对话</button>
                <button className="link-btn" onClick={() => { setPwFor(u); setPwValue(''); }}>改密</button>
                <button className="link-btn" onClick={() => toggleStatus(u)}>
                  {u.status === 'disabled' ? '启用' : '禁用'}
                </button>
                <button className="link-btn danger" onClick={() => removeUser(u)}>删除</button>
              </td>
            </tr>
          ))}
          {users.length === 0 && <tr><td colSpan={8} className="td-empty">暂无用户</td></tr>}
        </tbody>
      </table>

      {showCreate && (
        <div className="admin-modal-mask" onClick={() => setShowCreate(false)}>
          <form className="admin-modal" onClick={(e) => e.stopPropagation()} onSubmit={createUser}>
            <h3>新建用户</h3>
            <label className="field">
              <span>用户名</span>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="2-24 位，中英文/数字/下划线" autoFocus />
            </label>
            <label className="field">
              <span>初始密码</span>
              <input type="text" value={newPass} onChange={(e) => setNewPass(e.target.value)} placeholder="至少 6 位" />
            </label>
            <div className="sheet-actions">
              <button type="button" className="btn-ghost" onClick={() => setShowCreate(false)}>取消</button>
              <button type="submit" className="btn-primary" disabled={busy || !newName.trim() || newPass.length < 6}>创建</button>
            </div>
          </form>
        </div>
      )}

      {pwFor && (
        <div className="admin-modal-mask" onClick={() => setPwFor(null)}>
          <form className="admin-modal" onClick={(e) => e.stopPropagation()} onSubmit={savePassword}>
            <h3>重置密码 · {pwFor.username}</h3>
            <label className="field">
              <span>新密码</span>
              <input type="text" value={pwValue} onChange={(e) => setPwValue(e.target.value)} placeholder="至少 6 位" autoFocus />
            </label>
            <div className="sheet-actions">
              <button type="button" className="btn-ghost" onClick={() => setPwFor(null)}>取消</button>
              <button type="submit" className="btn-primary" disabled={busy || pwValue.length < 6}>保存</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
