import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import Icon from './Icon.jsx';

// 玄枢 · 模块门户：登录后的首屏。
//
// 展示策略（2026-09-18 起）：**所有模块都渲染成卡片**，无权限的卡片灰化并标明「无权限」，
// 而不是把卡片藏起来——用户能看到"这里还有别的先生"，也才知道该开通/订阅什么。
//   可用     → 点击进入
//   无权限   → 显示锁 + 「无权限」，按开通方式给出「申请开通」/「一键开通」，含该模块的套餐则引导「去订阅」
//   未上线   → 灰化 + 「暂未开放」（站点级开关关闭，连申请都无意义）
//
// props:
//   user          — 当前用户
//   catalog       — 模块目录（App 预取；为空时组件内自行加载兜底）
//   onEnter       — (module) => void
//   onMembership  — 打开「我的额度 / 订阅」面板
//   onAdminConsole / onLogout

export default function ModulePortal({ user, catalog, onEnter, onMembership, onAdminConsole, onLogout }) {
  const [modules, setModules] = useState(catalog && catalog.length ? catalog : null);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [applyNote, setApplyNote] = useState('');
  const [applyFor, setApplyFor] = useState(null);
  const [notice, setNotice] = useState('');

  function load() {
    api.listModules().then((d) => setModules(d.modules || [])).catch((e) => setErr(e.message));
  }
  useEffect(() => { if (!modules) load(); }, []);

  async function enter(m) {
    setErr(''); setNotice('');
    setBusyId(m.id);
    try { await onEnter(m); } catch (e) { setErr(e.message); }
    finally { setBusyId(null); }
  }

  async function authorize(m) {
    setErr(''); setNotice('');
    setBusyId(m.id);
    try {
      const r = await api.authorizeModule(m.id, applyNote);
      setNotice(r.message);
      setApplyFor(null); setApplyNote('');
      if (r.granted) {
        // 开通成功 → 直接进入（同时刷新目录，卡片状态同步）
        await load();
        await enter(m);
      } else {
        load();
      }
    } catch (e) { setErr(e.message); }
    finally { setBusyId(null); }
  }

  const isAdmin = Boolean(user?.is_admin);
  const list = modules || [];
  const myCount = list.filter((m) => m.available).length;

  // 权限来源标签（可用卡片上的一条小提示）
  function sourceLabel(m) {
    if (m.admin_preview) return { text: '未上线（仅管理员可见）', cls: 'src-admin' };
    if (m.grant_source === 'default') return { text: '默认开通', cls: 'src-default' };
    if (m.grant_source === 'plan') return { text: `订阅中${m.grant_expires_at ? ' · 至 ' + String(m.grant_expires_at).slice(0, 10) : ''}`, cls: 'src-plan' };
    if (m.grant_source === 'manual' || m.grant_source === 'auto') return { text: '已开通', cls: 'src-manual' };
    return null;
  }

  return (
    <div className="portal-shell">
      <header className="portal-header">
        <div className="portal-brand">
          <span className="portal-seal">玄</span>
          <div>
            <strong>玄枢</strong>
            <small>XuanShu · 传统智慧 AI 工作台</small>
          </div>
        </div>
        <div className="portal-header-actions">
          {onMembership && (
            <button className="portal-link" onClick={onMembership}><Icon name="coins" size={16} /> 我的额度</button>
          )}
          {user?.is_admin && onAdminConsole && (
            <button className="portal-link portal-link-admin" onClick={onAdminConsole}><Icon name="shield" size={16} /> 管理后台</button>
          )}
          <span className="portal-user">
            <span className="side-avatar">{user?.username?.slice(0, 1)?.toUpperCase() || 'U'}</span>
            <span>{user?.username}</span>
          </span>
          <button className="icon-btn" onClick={onLogout} title="退出登录" aria-label="退出登录">
            <Icon name="logout" size={17} />
          </button>
        </div>
      </header>

      <main className="portal-main">
        <div className="portal-hero">
          <h1>玄枢 · 传统智慧 AI 工作台</h1>
          <p>
            八位先生，各守一艺。命理排盘交给脚本，解读归于角色——过程透明，口径可查。
            {!isAdmin && <span className="portal-hero-hint">　你已开通 {myCount} / {list.length} 个模块，其余可按需开通或订阅。</span>}
          </p>
        </div>

        {err && <p className="portal-error" role="alert">{err}</p>}
        {notice && <p className="portal-notice">{notice}</p>}

        {!modules ? (
          <div className="chat-loading"><div className="loading-spinner" /><p>正在加载模块…</p></div>
        ) : (
          <section className="module-grid">
            {list.map((m) => {
              const locked = !m.available;
              const offline = !m.site_enabled;
              const src = m.available ? sourceLabel(m) : null;
              const subPlan = (m.plans_with_module || [])[0];
              return (
                <div
                  key={m.id}
                  className={`module-card ${locked ? 'locked' : ''} ${offline && !isAdmin ? 'offline' : ''}`}
                  style={{ '--mc': m.color }}
                >
                  <span className="module-icon" style={{ background: m.color, ...(locked ? { filter: 'grayscale(0.55)', opacity: 0.6 } : {}) }}>
                    <Icon name={m.icon} size={26} />
                  </span>
                  <span className="module-name">
                    {m.name}
                    {locked && <span className="module-admin-flag module-lock-flag"><Icon name="lock" size={11} /> {offline ? '暂未开放' : '无权限'}</span>}
                  </span>
                  <span className="module-tagline">{m.tagline}</span>

                  {m.has_tool && <span className="module-tool"><Icon name="zap" size={12} /> {m.tool_name}</span>}
                  {src && <span className={`module-src ${src.cls}`}>{src.text}</span>}

                  {!locked ? (
                    <button className="module-enter-btn" onClick={() => enter(m)} disabled={busyId === m.id}>
                      进入 <Icon name="arrow-right" size={14} />
                    </button>
                  ) : offline ? (
                    <span className="module-lock-note">该模块尚未上线，敬请期待</span>
                  ) : (
                    <div className="module-lock-actions">
                      <button
                        className="module-apply"
                        disabled={busyId === m.id}
                        onClick={() => (m.open_mode === 'auto' ? authorize(m) : setApplyFor(m))}
                      >
                        {m.open_mode === 'auto' ? '一键开通' : '申请开通'}
                      </button>
                      {subPlan && onMembership && (
                        <button className="module-apply ghost" onClick={onMembership} title={`套餐「${subPlan}」包含此模块`}>
                          订阅开通
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {isAdmin && (
          <p className="portal-offline-hint">
            管理员视角：全部 {list.length} 个模块均可进入；标「未上线」的尚未对普通用户开放，可在「管理后台 → 模块管理」中上线。
          </p>
        )}
      </main>

      {applyFor && (
        <div className="overlay" onClick={() => setApplyFor(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <h2><Icon name={applyFor.icon} size={18} /> 申请开通 · {applyFor.name}</h2>
              <button className="icon-btn" onClick={() => setApplyFor(null)} aria-label="关闭"><Icon name="close" size={18} /></button>
            </div>
            <div className="intake-form">
              <p className="auth-notice">「{applyFor.name}」需要管理员开通。提交申请后请等待审核，通过后即可使用。</p>
              <label className="field">
                <span>给管理员的留言 <small>（选填）</small></span>
                <textarea rows={3} value={applyNote} onChange={(e) => setApplyNote(e.target.value)} placeholder={`如：想请${applyFor.name}看一件事`} />
              </label>
              <div className="sheet-actions">
                <button className="btn-ghost" onClick={() => setApplyFor(null)}>取消</button>
                <button className="btn-primary" disabled={busyId === applyFor.id} onClick={() => authorize(applyFor)}>提交申请</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
