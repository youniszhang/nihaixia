import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import Icon from '../Icon.jsx';

function fmtTime(t) {
  return t ? t.replace('T', ' ').slice(0, 16) : '—';
}
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const creditsText = (c) => (c === null || c === undefined ? '不限' : `${c} 次`);

export default function AdminUsers({ onViewConversations, onGrantSubscription }) {
  const [users, setUsers] = useState([]);
  const [adminSource, setAdminSource] = useState('env');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // 选择 / 筛选
  const [selected, setSelected] = useState(() => new Set());
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  // 弹窗
  const [editUser, setEditUser] = useState(null);   // 新增（null）或编辑对象
  const [form, setForm] = useState({ username: '', password: '', note: '' });
  const [pwFor, setPwFor] = useState(null);
  const [pwValue, setPwValue] = useState('');
  const [quotaFor, setQuotaFor] = useState(null);   // 额度弹窗对象
  const [confirmAsk, setConfirmAsk] = useState(null); // { title, body, danger, onOk }

  async function load() {
    try {
      const d = await api.adminListUsers();
      setUsers(d.users || []);
      setAdminSource(d.admin_source || 'env');
      setSelected((prev) => new Set([...prev].filter((id) => (d.users || []).some((u) => u.id === id))));
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  function flash(t) { setMsg(t); setTimeout(() => setMsg(''), 4000); }

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return users.filter((u) => {
      if (statusFilter === 'active' && u.status === 'disabled') return false;
      if (statusFilter === 'disabled' && u.status !== 'disabled') return false;
      if (statusFilter === 'admin' && !u.is_admin) return false;
      if (statusFilter === 'quota' && (u.credits === null || u.credits === undefined)) return false;
      if (kw && !`${u.username} ${u.note || ''} ${u.plan_name || ''}`.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [users, keyword, statusFilter]);

  // 可被选中的用户（管理员自己不参与批量操作）
  const selectable = filtered.filter((u) => !u.is_admin);
  const allChecked = selectable.length > 0 && selectable.every((u) => selected.has(u.id));
  const someChecked = selectable.some((u) => selected.has(u.id));

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allChecked) selectable.forEach((u) => next.delete(u.id));
      else selectable.forEach((u) => next.add(u.id));
      return next;
    });
  }
  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // ---------- 单个操作 ----------
  function openCreate() {
    setEditUser({ id: null, username: '', note: '' });
    setForm({ username: '', password: '', note: '' });
  }
  function openEdit(u) {
    setEditUser(u);
    setForm({ username: u.username, password: '', note: u.note || '' });
  }

  async function submitForm(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      if (editUser.id) {
        const patch = {};
        if (form.username.trim() && form.username.trim() !== editUser.username) patch.username = form.username.trim();
        if (form.note !== (editUser.note || '')) patch.note = form.note;
        if (form.password) patch.password = form.password;
        if (!Object.keys(patch).length) { setEditUser(null); return; }
        const r = await api.adminUpdateUser(editUser.id, patch);
        flash(`已保存：${(r.changes || []).join('；') || '无变化'}`);
      } else {
        await api.adminCreateUser(form.username.trim(), form.password, form.note);
        flash('用户已创建');
      }
      setEditUser(null);
      await load();
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  }

  function askToggleStatus(u) {
    const disable = u.status !== 'disabled';
    setConfirmAsk({
      title: disable ? '禁用账号' : '启用账号',
      body: disable
        ? `确定禁用「${u.username}」？\n禁用后该用户立即无法登录，已登录的会话也会失效。`
        : `确定恢复「${u.username}」的登录权限？`,
      danger: disable,
      okText: disable ? '禁用' : '启用',
      onOk: async () => {
        try {
          await api.adminUpdateUser(u.id, { status: disable ? 'disabled' : 'active' });
          flash(disable ? '已禁用' : '已启用');
          await load();
        } catch (e) { setErr(e.message); }
      },
    });
  }

  function askDelete(u) {
    setConfirmAsk({
      title: '删除账号',
      danger: true,
      okText: '永久删除',
      body: `确定删除「${u.username}」？\n\n该操作会一并删除：\n• ${u.session_count} 个问诊会话及其全部对话记录\n• 体质档案、用量与额度记录、签到记录\n\n此操作不可恢复！`,
      onOk: async () => {
        try {
          await api.adminDeleteUser(u.id);
          flash('用户已删除');
          await load();
        } catch (e) { setErr(e.message); }
      },
    });
  }

  async function savePassword(e) {
    e.preventDefault();
    if (!pwValue) return;
    setBusy(true); setErr('');
    try {
      await api.adminUpdateUser(pwFor.id, { password: pwValue });
      setPwFor(null); setPwValue('');
      flash('密码已重置，该用户需重新登录');
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  }

  // ---------- 批量操作 ----------
  function askBulk(action) {
    const ids = [...selected];
    if (!ids.length) return;
    const names = users.filter((u) => ids.includes(u.id)).map((u) => u.username);
    const label = { disable: '禁用', enable: '启用', delete: '删除' }[action];
    const extra = action === 'delete'
      ? `\n\n将永久删除这些账号及其全部问诊记录（共 ${users.filter((u) => ids.includes(u.id)).reduce((n, u) => n + u.session_count, 0)} 个会话），不可恢复！`
      : action === 'disable' ? '\n\n禁用后这些用户立即无法登录。' : '';
    setConfirmAsk({
      title: `批量${label}（${ids.length} 个账号）`,
      danger: action === 'delete' || action === 'disable',
      okText: `确认${label}`,
      body: `即将${label}：${names.join('、')}${extra}`,
      onOk: async () => {
        try {
          const r = await api.adminBulkUsers(ids, action);
          flash(r.message || '操作完成');
          setSelected(new Set());
          await load();
        } catch (e) { setErr(e.message); }
      },
    });
  }

  function exportCsv() {
    const rows = [
      ['ID', '用户名', '状态', '管理员', '剩余额度', '每日上限', '订阅套餐', '订阅到期', '签到天数', '问诊数', '提问数', '调用数', '注册时间', '最近登录', '备注'],
      ...filtered.map((u) => [
        u.id, u.username, u.status === 'disabled' ? '已禁用' : '正常',
        u.is_admin ? '是' : '否', creditsText(u.credits),
        u.daily_chat_limit == null ? '跟随套餐/站点' : u.daily_chat_limit,
        u.plan_name || '', u.plan_expires_at || '', u.checkin_count ?? 0,
        u.session_count, u.question_count, u.call_count,
        u.created_at, u.last_login_at || '', u.note || '',
      ]),
    ];
    const csv = '\uFEFF' + rows.map((r) => r.map(csvEscape).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `nihaixia-users-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const selCount = selected.size;

  return (
    <div className="admin-users">
      <div className="admin-toolbar">
        <div className="admin-filter">
          <input
            className="admin-input"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索用户名 / 备注 / 套餐"
          />
          <select className="admin-input admin-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">全部状态</option>
            <option value="active">仅正常</option>
            <option value="disabled">仅禁用</option>
            <option value="admin">仅管理员</option>
            <option value="quota">仅额度制</option>
          </select>
          <span className="admin-count">{filtered.length} / {users.length} 位用户</span>
        </div>
        <div className="admin-filter">
          <button className="btn-ghost" onClick={exportCsv} title="导出当前筛选结果为 CSV">
            <Icon name="download" size={15} /> 导出 CSV
          </button>
          <button className="btn-primary" onClick={openCreate}>
            <Icon name="plus" size={15} /> 新建用户
          </button>
        </div>
      </div>

      {selCount > 0 && (
        <div className="bulk-bar">
          <span>已选 <strong>{selCount}</strong> 个账号</span>
          <button className="btn-ghost" onClick={() => setSelected(new Set())}>取消选择</button>
          <button className="btn-ghost" onClick={() => askBulk('enable')}>批量启用</button>
          <button className="btn-ghost" onClick={() => askBulk('disable')}>批量禁用</button>
          <button className="btn-ghost danger" onClick={() => askBulk('delete')}>批量删除</button>
        </div>
      )}

      {msg && <p className="sheet-msg">{msg}</p>}
      {err && <p className="auth-error">{err}</p>}
      {adminSource === 'legacy' && (
        <p className="admin-hint">
          <Icon name="info" size={14} /> 当前未在配置文件指定管理员，沿用老规则（第一个注册的用户为管理员）。
          建议在服务器 <code>.env</code> 中设置 <code>ADMIN_USERNAME=你的用户名</code> 并重启，管理员身份将以配置为准。
        </p>
      )}

      <table className="admin-table">
        <thead>
          <tr>
            <th className="th-check">
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => { if (el) el.indeterminate = !allChecked && someChecked; }}
                onChange={toggleAll}
                title="全选（不含管理员）"
              />
            </th>
            <th>用户名</th>
            <th>状态</th>
            <th>额度</th>
            <th>订阅</th>
            <th>签到</th>
            <th>问诊</th>
            <th>提问数</th>
            <th>注册时间</th>
            <th>最近登录</th>
            <th>备注</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((u) => (
            <tr key={u.id} className={u.status === 'disabled' ? 'row-disabled' : ''}>
              <td className="th-check">
                {!u.is_admin && (
                  <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggleOne(u.id)} />
                )}
              </td>
              <td>
                <strong>{u.username}</strong>
                {u.is_admin && <span className="badge badge-admin">管理员</span>}
                {u.is_self && <span className="badge badge-self">当前账号</span>}
                {u.pending_subs > 0 && <span className="badge badge-warn">待审批</span>}
              </td>
              <td>
                <span className={`badge ${u.status === 'disabled' ? 'badge-off' : 'badge-on'}`}>
                  {u.status === 'disabled' ? '已禁用' : '正常'}
                </span>
              </td>
              <td className="td-amount">
                <span className={u.credits != null && u.credits <= 3 ? 'qty-down' : ''}>{creditsText(u.credits)}</span>
                {u.daily_chat_limit != null && <div className="td-dim td-note">每日 {u.daily_chat_limit || '不限'}</div>}
              </td>
              <td>
                {u.plan_name
                  ? <><span className="badge badge-plan">{u.plan_name}</span><div className="td-dim td-note">{fmtTime(u.plan_expires_at)}</div></>
                  : <span className="td-dim">—</span>}
              </td>
              <td className="td-dim">{u.checkin_count ?? 0} 天</td>
              <td>{u.session_count}</td>
              <td>{u.question_count}</td>
              <td className="td-dim">{fmtTime(u.created_at)}</td>
              <td className="td-dim">{fmtTime(u.last_login_at)}</td>
              <td className="td-dim td-note" title={u.note || ''}>{u.note || '—'}</td>
              <td className="td-actions">
                <button className="link-btn" onClick={() => setQuotaFor(u)} disabled={u.is_admin}>额度</button>
                <button className="link-btn" onClick={() => onGrantSubscription(u)} disabled={u.is_admin}>订阅</button>
                <button className="link-btn" onClick={() => onViewConversations(u)}>对话</button>
                <button className="link-btn" onClick={() => openEdit(u)} disabled={u.is_admin}>编辑</button>
                <button className="link-btn" onClick={() => { setPwFor(u); setPwValue(''); }} disabled={u.is_admin}>改密</button>
                <button className="link-btn" onClick={() => askToggleStatus(u)} disabled={u.is_admin}>
                  {u.status === 'disabled' ? '启用' : '禁用'}
                </button>
                <button className="link-btn danger" onClick={() => askDelete(u)} disabled={u.is_admin}>删除</button>
              </td>
            </tr>
          ))}
          {filtered.length === 0 && <tr><td colSpan={12} className="td-empty">{users.length ? '没有匹配的用户' : '暂无用户'}</td></tr>}
        </tbody>
      </table>

      {/* 新增 / 编辑 */}
      {editUser && (
        <div className="admin-modal-mask" onClick={() => setEditUser(null)}>
          <form className="admin-modal" onClick={(e) => e.stopPropagation()} onSubmit={submitForm}>
            <h3>{editUser.id ? `编辑用户 · ${editUser.username}` : '新建用户'}</h3>
            <label className="field">
              <span>用户名</span>
              <input
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                placeholder="2-24 位用户名，或邮箱地址"
                autoFocus
              />
            </label>
            <label className="field">
              <span>{editUser.id ? '新密码（留空不修改）' : '初始密码'}</span>
              <input
                type="text"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                placeholder={editUser.id ? '留空则保持原密码' : '至少 6 位'}
              />
            </label>
            <label className="field">
              <span>备注（仅管理员可见）</span>
              <input
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                placeholder="如：张医生 / 内测用户"
              />
            </label>
            <div className="sheet-actions">
              <button type="button" className="btn-ghost" onClick={() => setEditUser(null)}>取消</button>
              <button
                type="submit"
                className="btn-primary"
                disabled={busy || !form.username.trim() || (!editUser.id && form.password.length < 6)}
              >
                {editUser.id ? '保存' : '创建'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 重置密码 */}
      {pwFor && (
        <div className="admin-modal-mask" onClick={() => setPwFor(null)}>
          <form className="admin-modal" onClick={(e) => e.stopPropagation()} onSubmit={savePassword}>
            <h3>重置密码 · {pwFor.username}</h3>
            <label className="field">
              <span>新密码</span>
              <input type="text" value={pwValue} onChange={(e) => setPwValue(e.target.value)} placeholder="至少 6 位" autoFocus />
            </label>
            <p className="admin-hint">重置后该用户的所有登录状态立即失效，需用新密码重新登录。</p>
            <div className="sheet-actions">
              <button type="button" className="btn-ghost" onClick={() => setPwFor(null)}>取消</button>
              <button type="submit" className="btn-primary" disabled={busy || pwValue.length < 6}>保存</button>
            </div>
          </form>
        </div>
      )}

      {/* 额度与订阅明细 */}
      {quotaFor && (
        <QuotaModal user={quotaFor} onClose={() => setQuotaFor(null)} onSaved={load} />
      )}

      {/* 通用确认（删除/禁用/批量） */}
      {confirmAsk && (
        <div className="admin-modal-mask" onClick={() => setConfirmAsk(null)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className={confirmAsk.danger ? 'modal-danger-title' : ''}>{confirmAsk.title}</h3>
            <p className="confirm-body">{confirmAsk.body}</p>
            <div className="sheet-actions">
              <button type="button" className="btn-ghost" onClick={() => setConfirmAsk(null)}>取消</button>
              <button
                type="button"
                className={confirmAsk.danger ? 'btn-danger' : 'btn-primary'}
                onClick={async () => { const fn = confirmAsk.onOk; setConfirmAsk(null); await fn(); }}
              >
                {confirmAsk.okText || '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 单个用户的额度/上限调整 + 订阅与流水明细
function QuotaModal({ user, onClose, onSaved }) {
  const [detail, setDetail] = useState(null);
  const [creditsInput, setCreditsInput] = useState('');
  const [limitInput, setLimitInput] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.adminUserQuota(user.id);
      setDetail(d);
      setCreditsInput(d.quota.unlimited ? '' : String(d.quota.credits));
      setLimitInput(d.quota.user_limit == null ? '' : String(d.quota.user_limit));
    } catch (e) { setErr(e.message); }
  }, [user.id]);
  useEffect(() => { load(); }, [load]);

  function flash(t) { setMsg(t); setTimeout(() => setMsg(''), 3000); }

  async function patch(body, okText) {
    setBusy(true); setErr('');
    try {
      const r = await api.adminUpdateUser(user.id, body);
      flash(okText || (r.changes || []).join('；'));
      await load();
      await onSaved?.();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  const q = detail?.quota;

  return (
    <div className="admin-modal-mask" onClick={onClose}>
      <div className="admin-modal admin-modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3><Icon name="coins" size={17} /> 额度与订阅 · {user.username}</h3>

        {!detail ? (err ? <p className="auth-error">{err}</p> : <p className="admin-loading">加载中…</p>) : (
          <>
            <div className="quota-summary">
              <div><span>剩余额度</span><strong>{q.unlimited ? '不限次' : `${q.credits} 次`}</strong></div>
              <div><span>今日已用</span><strong>{q.used_today}{q.daily_limit > 0 ? ` / ${q.daily_limit}` : ' / 不限'}</strong></div>
              <div><span>生效套餐</span><strong>{q.subscription ? q.subscription.plan_name : '无'}</strong></div>
              <div><span>签到天数</span><strong>{detail.checkins?.length || 0} 天</strong></div>
            </div>

            <div className="field-row">
              <label className="field">
                <span>剩余额度（留空 = 不限次）</span>
                <input
                  type="number" min="0" step="1"
                  value={creditsInput}
                  placeholder="留空 = 不限次"
                  onChange={(e) => setCreditsInput(e.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="field">
                <span>专属每日上限（留空 = 跟随套餐/站点）</span>
                <input
                  type="number" min="0" step="1"
                  value={limitInput}
                  placeholder="跟随套餐 / 站点"
                  onChange={(e) => setLimitInput(e.target.value)}
                  disabled={busy}
                />
              </label>
            </div>
            <div className="quota-actions">
              <button
                className="btn-primary" disabled={busy}
                onClick={() => patch({ credits: creditsInput.trim() === '' ? null : Number(creditsInput), daily_chat_limit: limitInput.trim() === '' ? null : Number(limitInput) }, '已保存')}
              >
                保存
              </button>
              {!q.unlimited && (
                <>
                  <button className="btn-ghost" disabled={busy} onClick={() => patch({ credit_delta: 10 }, '已增加 10 次')}>
                    <Icon name="plus" size={14} /> 10 次
                  </button>
                  <button className="btn-ghost" disabled={busy} onClick={() => patch({ credit_delta: 50 }, '已增加 50 次')}>
                    <Icon name="plus" size={14} /> 50 次
                  </button>
                  <button className="btn-ghost" disabled={busy} onClick={() => patch({ credit_delta: -10 }, '已扣减 10 次')}>
                    <Icon name="minus" size={14} /> 10 次
                  </button>
                </>
              )}
            </div>

            <h4 className="modal-sub">额度流水</h4>
            <table className="admin-table admin-table-compact">
              <thead><tr><th>时间</th><th>变动</th><th>余额</th><th>说明</th></tr></thead>
              <tbody>
                {(detail.ledger || []).slice(0, 8).map((l, i) => (
                  <tr key={i}>
                    <td className="td-dim">{l.created_at}</td>
                    <td className={l.delta > 0 ? 'qty-up' : l.delta < 0 ? 'qty-down' : 'td-dim'}>{l.delta > 0 ? `+${l.delta}` : l.delta}</td>
                    <td>{l.balance_after == null ? '不限' : l.balance_after}</td>
                    <td className="td-dim">{l.detail || l.reason}</td>
                  </tr>
                ))}
                {(detail.ledger || []).length === 0 && <tr><td colSpan={4} className="td-empty">暂无记录</td></tr>}
              </tbody>
            </table>

            <h4 className="modal-sub">订阅记录</h4>
            <table className="admin-table admin-table-compact">
              <thead><tr><th>套餐</th><th>状态</th><th>到期</th></tr></thead>
              <tbody>
                {(detail.subscriptions || []).slice(0, 5).map((s) => (
                  <tr key={s.id}>
                    <td>{s.plan_name}</td>
                    <td>{{ pending: '待审批', active: '生效中', rejected: '已驳回', expired: '已过期', canceled: '已撤销' }[s.status] || s.status}</td>
                    <td className="td-dim">{s.expires_at || '—'}</td>
                  </tr>
                ))}
                {(detail.subscriptions || []).length === 0 && <tr><td colSpan={3} className="td-empty">暂无订阅</td></tr>}
              </tbody>
            </table>
          </>
        )}

        <div className="sheet-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>关闭</button>
        </div>
        {msg && <p className="sheet-msg">{msg}</p>}
        {err && <p className="auth-error">{err}</p>}
      </div>
    </div>
  );
}
