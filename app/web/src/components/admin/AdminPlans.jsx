import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import Icon from '../Icon.jsx';

// 管理后台：订阅与额度
//   套餐（计划的额度/每日上限/周期/价格）· 待审批申请 · 生效订阅 · 手动开通 · 签到概况
// 额度模型与用户端完全共用服务端 resolveQuota：用户专属 > 套餐 > 站点默认。

const yuan = (cents) => `¥${(Number(cents || 0) / 100).toFixed(2).replace(/\.00$/, '')}`;

function fmtUtc(t) {
  if (!t) return '—';
  const d = new Date(String(t).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return String(t).slice(0, 16);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function daysLeft(expiresAt) {
  if (!expiresAt) return null;
  const end = new Date(String(expiresAt).replace(' ', 'T') + 'Z');
  return Math.ceil((end.getTime() - Date.now()) / 86400000);
}

const EMPTY_PLAN = { name: '', description: '', price_cents: 0, period_days: 30, credits: 0, daily_chat_limit: 0, sort: 0, active: true };

export default function AdminPlans({ initialGrantFor, onClearGrantFor }) {
  const [plans, setPlans] = useState([]);
  const [subs, setSubs] = useState([]);
  const [stats, setStats] = useState({ pending: 0, active: 0 });
  const [checkins, setCheckins] = useState(null);
  const [users, setUsers] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [planForm, setPlanForm] = useState(null);   // null | 新建/编辑表单对象
  const [grant, setGrant] = useState(null);         // { userId, planId }

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 4000); };

  const load = useCallback(async () => {
    try {
      const [p, s, c, u] = await Promise.all([
        api.adminPlans(), api.adminSubscriptions({ limit: 200 }), api.adminCheckins(14), api.adminListUsers(),
      ]);
      setPlans(p.plans || []);
      setSubs(s.subscriptions || []);
      setStats(s.stats || { pending: 0, active: 0 });
      setCheckins(c);
      setUsers(u.users || []);
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 从「用户管理」带过来的开通请求
  useEffect(() => {
    if (initialGrantFor) {
      setGrant({ userId: String(initialGrantFor.userId), planId: '' });
      onClearGrantFor?.();
    }
  }, [initialGrantFor, onClearGrantFor]);

  const pending = subs.filter((s) => s.status === 'pending');
  const active = subs.filter((s) => s.status === 'active' && daysLeft(s.expires_at) > 0);
  const others = subs.filter((s) => s.status !== 'pending' && !(s.status === 'active' && daysLeft(s.expires_at) > 0));

  async function savePlan(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const body = {
        name: planForm.name.trim(),
        description: planForm.description,
        price_cents: Number(planForm.price_cents) || 0,
        period_days: Number(planForm.period_days) || 30,
        credits: Number(planForm.credits) || 0,
        daily_chat_limit: Number(planForm.daily_chat_limit) || 0,
        sort: Number(planForm.sort) || 0,
        active: planForm.active !== false,
      };
      if (planForm.id) await api.adminUpdatePlan(planForm.id, body);
      else await api.adminCreatePlan(body);
      flash(planForm.id ? '套餐已更新' : '套餐已创建');
      setPlanForm(null);
      await load();
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  }

  async function togglePlan(p) {
    try {
      await api.adminUpdatePlan(p.id, { active: !p.active });
      await load();
    } catch (e) { setErr(e.message); }
  }

  async function removePlan(p) {
    if (!confirm(`删除套餐「${p.name}」？\n\n已开通的老订阅不受影响（额度与到期时间在下单时已快照）。`)) return;
    try {
      await api.adminDeletePlan(p.id);
      flash('套餐已删除');
      await load();
    } catch (e) { setErr(e.message); }
  }

  async function approve(s) {
    setBusy(true);
    try {
      await api.adminApproveSubscription(s.id);
      flash(`已开通「${s.plan_name}」给 ${s.username}`);
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function reject(s) {
    const reason = prompt(`驳回 ${s.username} 的「${s.plan_name}」申请？可填原因（可留空）`, '');
    if (reason === null) return;
    try {
      await api.adminRejectSubscription(s.id, reason);
      flash('已驳回');
      await load();
    } catch (e) { setErr(e.message); }
  }

  async function cancelSub(s) {
    if (!confirm(`撤销 ${s.username} 的「${s.plan_name}」订阅？`)) return;
    try {
      await api.adminCancelSubscription(s.id);
      flash('已撤销');
      await load();
    } catch (e) { setErr(e.message); }
  }

  async function submitGrant(e) {
    e.preventDefault();
    const uid = Number(grant.userId);
    if (!uid || !grant.planId) { setErr('请选择用户与套餐'); return; }
    setBusy(true); setErr('');
    try {
      await api.adminGrantSubscription(uid, Number(grant.planId));
      flash('已开通，额度与上限立即生效');
      setGrant(null);
      await load();
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  }

  const checkinMax = Math.max(1, ...(checkins?.daily || []).map((d) => d.checkins));

  return (
    <div className="admin-plans">
      <div className="admin-toolbar">
        <div className="admin-filter">
          <span className="stat-chip"><Icon name="clock" size={14} /> 待审批 <strong>{stats.pending}</strong></span>
          <span className="stat-chip"><Icon name="crown" size={14} /> 生效订阅 <strong>{stats.active}</strong></span>
          <span className="stat-chip"><Icon name="calendar-check" size={14} /> 今日签到 <strong>{checkins?.summary?.today ?? 0}</strong></span>
        </div>
        <div className="admin-filter">
          <button className="btn-ghost" onClick={() => setGrant({ userId: '', planId: '' })} disabled={!plans.length}>
            <Icon name="plus" size={15} /> 手动开通
          </button>
          <button className="btn-primary" onClick={() => setPlanForm({ ...EMPTY_PLAN })}>
            <Icon name="plus" size={15} /> 新建套餐
          </button>
        </div>
      </div>

      {msg && <p className="sheet-msg">{msg}</p>}
      {err && <p className="auth-error">{err}</p>}

      {/* ---------- 待审批申请 ---------- */}
      <section className="admin-section">
        <h3>待审批申请（{pending.length}）</h3>
        <table className="admin-table">
          <thead>
            <tr><th>用户</th><th>套餐</th><th>应付</th><th>提交时间</th><th>备注</th><th>操作</th></tr>
          </thead>
          <tbody>
            {pending.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.username}</strong></td>
                <td>{s.plan_name}</td>
                <td>{yuan(s.price_cents)}</td>
                <td className="td-dim">{fmtUtc(s.created_at)}</td>
                <td className="td-dim">{s.note || '—'}</td>
                <td className="td-actions">
                  <button className="link-btn" onClick={() => approve(s)} disabled={busy}>开通</button>
                  <button className="link-btn danger" onClick={() => reject(s)} disabled={busy}>驳回</button>
                </td>
              </tr>
            ))}
            {pending.length === 0 && <tr><td colSpan={6} className="td-empty">暂无待审批申请</td></tr>}
          </tbody>
        </table>
      </section>

      {/* ---------- 生效订阅 ---------- */}
      <section className="admin-section">
        <h3>生效中的订阅（{active.length}）</h3>
        <table className="admin-table">
          <thead>
            <tr><th>用户</th><th>套餐</th><th>每日上限</th><th>开通时间</th><th>到期</th><th>剩余</th><th>操作</th></tr>
          </thead>
          <tbody>
            {active.map((s) => {
              const left = daysLeft(s.expires_at);
              return (
                <tr key={s.id}>
                  <td><strong>{s.username}</strong></td>
                  <td>{s.plan_name}</td>
                  <td>{s.daily_chat_limit > 0 ? `${s.daily_chat_limit} 次` : '不限'}</td>
                  <td className="td-dim">{fmtUtc(s.started_at)}</td>
                  <td className="td-dim">{fmtUtc(s.expires_at)}</td>
                  <td className={left != null && left <= 3 ? 'qty-down' : ''}>{left != null ? `${left} 天` : '—'}</td>
                  <td className="td-actions">
                    <button className="link-btn danger" onClick={() => cancelSub(s)}>撤销</button>
                  </td>
                </tr>
              );
            })}
            {active.length === 0 && <tr><td colSpan={7} className="td-empty">暂无生效订阅</td></tr>}
          </tbody>
        </table>
      </section>

      {/* ---------- 套餐 ---------- */}
      <section className="admin-section">
        <h3>套餐（{plans.length}）</h3>
        <table className="admin-table">
          <thead>
            <tr><th>名称</th><th>价格</th><th>周期</th><th>额度</th><th>每日上限</th><th>排序</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id} className={p.active ? '' : 'row-disabled'}>
                <td>
                  <strong>{p.name}</strong>
                  {p.description && <div className="td-dim td-note">{p.description}</div>}
                </td>
                <td>{yuan(p.price_cents)}</td>
                <td>{p.period_days} 天</td>
                <td>{p.credits > 0 ? `${p.credits} 次` : '—'}</td>
                <td>{p.daily_chat_limit > 0 ? `${p.daily_chat_limit} 次` : '不限'}</td>
                <td className="td-dim">{p.sort}</td>
                <td>
                  <span className={`badge ${p.active ? 'badge-on' : 'badge-off'}`}>{p.active ? '上架' : '下架'}</span>
                </td>
                <td className="td-actions">
                  <button className="link-btn" onClick={() => setPlanForm({ ...p })}>编辑</button>
                  <button className="link-btn" onClick={() => togglePlan(p)}>{p.active ? '下架' : '上架'}</button>
                  <button className="link-btn danger" onClick={() => removePlan(p)}>删除</button>
                </td>
              </tr>
            ))}
            {plans.length === 0 && <tr><td colSpan={8} className="td-empty">还没有套餐，点右上角「新建套餐」</td></tr>}
          </tbody>
        </table>
      </section>

      {/* ---------- 签到概况 ---------- */}
      <section className="admin-section">
        <h3>签到概况</h3>
        <div className="checkin-stats">
          <span className="stat-chip">今日签到 <strong>{checkins?.summary?.today ?? 0}</strong> 人次</span>
          <span className="stat-chip">累计 <strong>{checkins?.summary?.total ?? 0}</strong> 人次</span>
          <span className="stat-chip">参与用户 <strong>{checkins?.summary?.users ?? 0}</strong> 人</span>
          <span className="stat-chip">
            人机校验
            <strong>{checkins?.settings?.captcha_enabled ? '已开启' : '未开启'}</strong>
          </span>
        </div>
        <div className="checkin-bars">
          {(checkins?.daily || []).map((d) => (
            <div key={d.day} className="checkin-bar" title={`${d.day}：${d.checkins} 人次，发放 ${d.reward} 次额度`}>
              <div className="checkin-bar-fill" style={{ height: `${Math.max(4, (d.checkins / checkinMax) * 100)}%` }} />
              <span>{d.day.slice(5)}</span>
            </div>
          ))}
          {(checkins?.daily || []).length === 0 && <p className="setting-desc">最近 {checkins?.days || 14} 天还没有签到记录。</p>}
        </div>
        {!checkins?.settings?.captcha_enabled && (
          <p className="admin-hint">
            <Icon name="alert" size={14} /> 尚未开启人机校验：签到接口只靠「每自然日一次」+ 限流防刷。
            建议在「站点设置 → 每日签到」中填入 Cloudflare Turnstile 的 Site Key 与 Secret Key。
          </p>
        )}
      </section>

      {/* ---------- 历史记录 ---------- */}
      {others.length > 0 && (
        <section className="admin-section">
          <h3>历史记录（最近 {Math.min(others.length, 30)} 条）</h3>
          <table className="admin-table">
            <thead>
              <tr><th>用户</th><th>套餐</th><th>状态</th><th>到期</th><th>备注</th></tr>
            </thead>
            <tbody>
              {others.slice(0, 30).map((s) => (
                <tr key={s.id}>
                  <td>{s.username}</td>
                  <td>{s.plan_name}</td>
                  <td><span className={`badge ${s.status === 'active' ? 'badge-on' : 'badge-off'}`}>{{
                    rejected: '已驳回', expired: '已过期', canceled: '已撤销', active: '生效中',
                  }[s.status] || s.status}</span></td>
                  <td className="td-dim">{fmtUtc(s.expires_at)}</td>
                  <td className="td-dim">{s.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* ---------- 套餐编辑弹窗 ---------- */}
      {planForm && (
        <div className="admin-modal-mask" onClick={() => setPlanForm(null)}>
          <form className="admin-modal" onClick={(e) => e.stopPropagation()} onSubmit={savePlan}>
            <h3>{planForm.id ? `编辑套餐 · ${planForm.name}` : '新建套餐'}</h3>
            <label className="field">
              <span>套餐名称</span>
              <input value={planForm.name} onChange={(e) => setPlanForm((f) => ({ ...f, name: e.target.value }))} placeholder="如：月度会员" autoFocus />
            </label>
            <label className="field">
              <span>简介（用户端展示）</span>
              <input value={planForm.description || ''} onChange={(e) => setPlanForm((f) => ({ ...f, description: e.target.value }))} placeholder="如：每月 100 次问诊，适合家庭常备" />
            </label>
            <div className="field-row">
              <label className="field">
                <span>价格（元）</span>
                <input
                  type="number" min="0" step="1"
                  value={(Number(planForm.price_cents) || 0) / 100}
                  onChange={(e) => setPlanForm((f) => ({ ...f, price_cents: Math.round(Number(e.target.value) * 100) || 0 }))}
                />
              </label>
              <label className="field">
                <span>周期（天）</span>
                <input type="number" min="1" step="1" value={planForm.period_days} onChange={(e) => setPlanForm((f) => ({ ...f, period_days: e.target.value }))} />
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>每期发放额度（次）</span>
                <input type="number" min="0" step="1" value={planForm.credits} onChange={(e) => setPlanForm((f) => ({ ...f, credits: e.target.value }))} />
              </label>
              <label className="field">
                <span>每日上限（0 = 不限）</span>
                <input type="number" min="0" step="1" value={planForm.daily_chat_limit} onChange={(e) => setPlanForm((f) => ({ ...f, daily_chat_limit: e.target.value }))} />
              </label>
            </div>
            <label className="field">
              <span>排序（小的靠前）</span>
              <input type="number" step="1" value={planForm.sort} onChange={(e) => setPlanForm((f) => ({ ...f, sort: e.target.value }))} />
            </label>
            <p className="admin-hint">
              开通时会把本套餐的额度与每日上限「快照」到该用户的订阅上；之后再改套餐不影响已开通的用户。
              额度只对「额度制」账号入账，不限次账号不受影响。
            </p>
            <div className="sheet-actions">
              <button type="button" className="btn-ghost" onClick={() => setPlanForm(null)}>取消</button>
              <button type="submit" className="btn-primary" disabled={busy || !String(planForm.name).trim()}>
                {planForm.id ? '保存' : '创建'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ---------- 手动开通弹窗 ---------- */}
      {grant && (
        <div className="admin-modal-mask" onClick={() => setGrant(null)}>
          <form className="admin-modal" onClick={(e) => e.stopPropagation()} onSubmit={submitGrant}>
            <h3>手动开通订阅</h3>
            <label className="field">
              <span>用户</span>
              <select className="admin-input admin-select" value={grant.userId} onChange={(e) => setGrant((g) => ({ ...g, userId: e.target.value }))} autoFocus>
                <option value="">请选择用户</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.username}{u.plan_name ? `（当前：${u.plan_name}）` : ''}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>套餐</span>
              <select className="admin-input admin-select" value={grant.planId} onChange={(e) => setGrant((g) => ({ ...g, planId: e.target.value }))}>
                <option value="">请选择套餐</option>
                {plans.filter((p) => p.active).map((p) => (
                  <option key={p.id} value={p.id}>{p.name} · {p.period_days} 天 · {p.credits} 次额度</option>
                ))}
              </select>
            </label>
            <p className="admin-hint">
              用于线下收款后手工开通：立即生效并提供套餐额度；该用户原有的待审批申请会被自动处理。
            </p>
            <div className="sheet-actions">
              <button type="button" className="btn-ghost" onClick={() => setGrant(null)}>取消</button>
              <button type="submit" className="btn-primary" disabled={busy || !grant.userId || !grant.planId}>确认开通</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
