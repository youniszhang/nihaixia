import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import Icon from './Icon.jsx';

// 「我的额度」面板：额度概览 + 每日签到（可选 Cloudflare Turnstile 人机校验）+ 订阅套餐。
// 额度制账号才有余额；不限次账号这里显示「不限次」，签到只累计连签天数。

// 数据库里的时间戳是 UTC 文本（datetime('now')），展示时统一转成本地时间
function fmtUtc(t) {
  if (!t) return '—';
  const d = new Date(String(t).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return String(t).slice(0, 16);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDay(t) { return t ? String(t).slice(0, 10) : '—'; }
const yuan = (cents) => `¥${(Number(cents || 0) / 100).toFixed(2).replace(/\.00$/, '')}`;

export default function MembershipPanel({ onClose, onQuotaChange }) {
  const [data, setData] = useState(null);      // /api/checkin 的结果
  const [subs, setSubs] = useState(null);      // /api/subscription 的结果
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [cfToken, setCfToken] = useState('');
  const tsBoxRef = useRef(null);
  const tsWidgetRef = useRef(null);

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 4000); };

  const load = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([api.checkin(), api.subscriptions()]);
      setData(c);
      setSubs(s);
      onQuotaChange?.(c.quota);
    } catch (e) { setErr(e.message); }
  }, [onQuotaChange]);

  useEffect(() => { load(); }, [load]);

  // ---- Cloudflare Turnstile（只有站点配了 site key 才加载）----
  const siteKey = data?.checkin?.captcha_site_key || '';
  useEffect(() => {
    if (!siteKey) return undefined;
    let timer = null;
    const render = () => {
      if (!window.turnstile || !tsBoxRef.current) return;
      tsBoxRef.current.innerHTML = '';
      try {
        tsWidgetRef.current = window.turnstile.render(tsBoxRef.current, {
          sitekey: siteKey,
          theme: 'auto',
          callback: (t) => setCfToken(t),
          'expired-callback': () => setCfToken(''),
          'error-callback': () => setCfToken(''),
        });
      } catch { /* 重复渲染时忽略 */ }
    };
    const SCRIPT_ID = 'cf-turnstile-script';
    if (window.turnstile) render();
    else if (!document.getElementById(SCRIPT_ID)) {
      const s = document.createElement('script');
      s.id = SCRIPT_ID;
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.defer = true;
      s.onload = render;
      document.head.appendChild(s);
    } else {
      timer = setInterval(() => { if (window.turnstile) { clearInterval(timer); render(); } }, 200);
    }
    return () => { if (timer) clearInterval(timer); };
  }, [siteKey]);

  async function submitCheckin() {
    if (siteKey && !cfToken) { setErr('请先完成人机校验'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.doCheckin(cfToken);
      setData({ checkin: r.checkin, quota: r.quota, ledger: data?.ledger || [] });
      onQuotaChange?.(r.quota);
      flash(r.credited
        ? `签到成功：连续 ${r.streak} 天，+${r.reward} 次额度（余额 ${r.balance}）`
        : `签到成功：连续 ${r.streak} 天（当前账号不限次，额度无需累计）`);
      setCfToken('');
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function applyPlan(plan) {
    setBusy(true); setErr('');
    try {
      await api.applySubscription(plan.id);
      flash(`已提交「${plan.name}」开通申请，等待管理员确认`);
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function cancelApply() {
    setBusy(true); setErr('');
    try {
      await api.cancelSubscriptionRequest();
      flash('已撤回申请');
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  if (!data || !subs) return err ? <p className="auth-error">{err}</p> : <p className="admin-loading">加载中…</p>;

  const q = data.quota || {};
  const ck = data.checkin || {};
  const plan = q.subscription;
  const limitText = q.daily_limit > 0
    ? `${q.used_today} / ${q.daily_limit}`
    : `${q.used_today} / 不限`;
  const sourceText = q.daily_limit_source === 'user' ? '管理员为该账号设置'
    : q.daily_limit_source === 'plan' ? `套餐「${plan?.plan_name || ''}」`
    : '站点默认';

  return (
    <div className="membership">
      {/* ---------- 额度概览 ---------- */}
      <section className="mb-cards">
        <div className="mb-card">
          <span className="mb-card-label"><Icon name="coins" size={16} /> 剩余额度</span>
          <strong className="mb-card-value">
            {q.unlimited ? '不限次' : `${q.credits} 次`}
          </strong>
          <small>{q.unlimited ? '当前账号不消耗额度' : '每成功问诊扣 1 次'}</small>
        </div>
        <div className="mb-card">
          <span className="mb-card-label"><Icon name="credit-limit" size={16} /> 今日已用</span>
          <strong className="mb-card-value">{limitText}</strong>
          <small>上限来源：{sourceText}</small>
        </div>
        <div className="mb-card">
          <span className="mb-card-label"><Icon name="crown" size={16} /> 当前订阅</span>
          <strong className="mb-card-value">{plan ? plan.plan_name : '无'}</strong>
          <small>{plan ? `${fmtDay(plan.expires_at)} 到期` : '可在下方申请开通'}</small>
        </div>
      </section>

      {/* ---------- 每日签到 ---------- */}
      <section className="admin-section">
        <h3><Icon name="calendar-check" size={16} /> 每日签到</h3>
        {!ck.enabled ? (
          <p className="setting-desc">管理员已关闭签到功能。</p>
        ) : (
          <>
            <div className="checkin-row">
              <div className="checkin-info">
                <div className="checkin-streak">
                  <Icon name="flame" size={20} />
                  <strong>{ck.streak}</strong> 天连签
                </div>
                <p className="setting-desc">
                  今日（{ck.day}）{ck.checked_in ? `已签到，获得 ${ck.reward_today} 次额度` : `签到可得 ${ck.reward_next} 次额度`}。
                  连续签到每天多加一点，断签重新从 1 开始。
                </p>
              </div>
              <button
                className={`btn-primary checkin-btn ${ck.checked_in ? 'done' : ''}`}
                onClick={submitCheckin}
                disabled={busy || ck.checked_in || (siteKey && !cfToken)}
              >
                <Icon name={ck.checked_in ? 'check' : 'gift'} size={16} />
                {ck.checked_in ? '今日已签' : `签到 +${ck.reward_next}`}
              </button>
            </div>

            {siteKey && !ck.checked_in && (
              <div className="turnstile-box">
                <span className="setting-desc">
                  <Icon name="shield" size={14} /> 人机校验（Cloudflare Turnstile）
                </span>
                <div ref={tsBoxRef} />
              </div>
            )}

            {(ck.history || []).length > 0 && (
              <div className="checkin-days-wrap">
                <span className="checkin-days-label">最近 {Math.min(ck.history.length, 14)} 天</span>
                <div className="checkin-days">
                  {(ck.history || []).slice(0, 14).reverse().map((h) => (
                    <span key={h.day} className="checkin-day" title={`${h.day} 连签 ${h.streak} 天，+${h.reward}`}>
                      {fmtDay(h.day).slice(8)}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* ---------- 订阅套餐 ---------- */}
      <section className="admin-section">
        <h3><Icon name="card" size={16} /> 订阅套餐</h3>
        {subs.pending && (
          <div className="pending-banner">
            <span>
              <Icon name="clock" size={15} /> 「{subs.pending.plan_name}」申请待管理员确认
            </span>
            <button className="text-btn" onClick={cancelApply} disabled={busy}>撤回申请</button>
          </div>
        )}
        {subs.plans.length === 0 ? (
          <p className="setting-desc">管理员还没有配置套餐。</p>
        ) : (
          <div className="plan-grid">
            {subs.plans.map((p) => {
              const isCurrent = plan && plan.plan_id === p.id;
              return (
                <div key={p.id} className={`plan-card ${isCurrent ? 'current' : ''}`}>
                  {isCurrent && <span className="plan-badge">当前套餐</span>}
                  <h4>{p.name}</h4>
                  <div className="plan-price">{yuan(p.price_cents)}<small> / {p.period_days} 天</small></div>
                  {p.description && <p className="plan-desc">{p.description}</p>}
                  <ul className="plan-feats">
                    <li><Icon name="coins" size={14} /> {p.credits > 0 ? `每期 ${p.credits} 次额度` : '不额外发放额度'}</li>
                    <li><Icon name="credit-limit" size={14} /> 每日上限 {p.daily_chat_limit > 0 ? `${p.daily_chat_limit} 次` : '不限'}</li>
                    <li><Icon name="clock" size={14} /> 有效期 {p.period_days} 天</li>
                  </ul>
                  <button
                    className={isCurrent ? 'btn-ghost' : 'btn-primary'}
                    onClick={() => applyPlan(p)}
                    disabled={busy || Boolean(subs.pending) || isCurrent}
                  >
                    {isCurrent ? '使用中' : subs.pending ? '有待审批申请' : '申请开通'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <p className="setting-desc plan-note">
          本站暂不支持在线支付：提交申请后由管理员确认收款并开通，开通后立即生效。
        </p>
      </section>

      {/* ---------- 额度流水 ---------- */}
      {(data.ledger || []).length > 0 && (
        <section className="admin-section">
          <h3><Icon name="file-text" size={16} /> 额度流水（最近 20 条）</h3>
          <table className="admin-table">
            <thead>
              <tr><th>时间</th><th>变动</th><th>余额</th><th>说明</th></tr>
            </thead>
            <tbody>
              {data.ledger.map((l, i) => (
                <tr key={i}>
                  <td className="td-dim">{fmtUtc(l.created_at)}</td>
                  <td className={l.delta > 0 ? 'qty-up' : l.delta < 0 ? 'qty-down' : 'td-dim'}>
                    {l.delta > 0 ? `+${l.delta}` : l.delta}
                  </td>
                  <td>{l.balance_after == null ? '不限' : l.balance_after}</td>
                  <td className="td-dim">{l.detail || l.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {msg && <p className="sheet-msg">{msg}</p>}
      {err && <p className="auth-error">{err}</p>}
    </div>
  );
}
