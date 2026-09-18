import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import Icon from './Icon.jsx';

// 玄枢 · 模块门户：登录后的首屏。
// 每个模块 = 一位角色（人设+知识库+脚本）。点击可用模块进入聊天；不可用模块走开通流程。
//
// props:
//   user        — 当前用户
//   catalog     — 模块目录（App 预取；为空数组时组件内自行加载兜底）
//   onEnter     — (module) => void  进入某模块（ChatPage 用它预创建/绑定会话）
//   onMembership — 额度入口
//   onAdminConsole / onLogout — 侧边入口透传

export default function ModulePortal({ user, catalog, onEnter, onMembership, onAdminConsole, onLogout }) {
  const [modules, setModules] = useState(catalog && catalog.length ? catalog : null);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [applyNote, setApplyNote] = useState('');     // 申请留言（当前仅单模块申请用）
  const [applyFor, setApplyFor] = useState(null);     // 弹窗模块
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
      if (r.granted) {
        setNotice(r.message);
        await enter(m); // 开通即入
      } else {
        setNotice(r.message);
        setApplyFor(null); setApplyNote('');
        load();
      }
    } catch (e) { setErr(e.message); }
    finally { setBusyId(null); }
  }

  // 视角：管理员是普通用户的超集 —— 所有模块都进「可进入」区（服务端 available=true），
  // 未上线的只是多一个「仅管理员可见」标记；普通用户看到上线且已开通的，其余进待开通/下线区。
  const isAdmin = Boolean(user?.is_admin);
  const available = (modules || []).filter((m) => m.available);
  const locked = (modules || []).filter((m) => !m.available && m.site_enabled);
  const offline = (modules || []).filter((m) => !m.site_enabled && !m.available);

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
          <p>八位先生，各守一艺。命理排盘交给脚本，解读归于角色——过程透明，口径可查。</p>
        </div>

        {err && <p className="portal-error" role="alert">{err}</p>}
        {notice && <p className="portal-notice">{notice}</p>}

        {!modules ? (
          <div className="chat-loading"><div className="loading-spinner" /><p>正在加载模块…</p></div>
        ) : (
          <>
            <section className="module-grid">
              {available.map((m) => (
                <button key={m.id} className="module-card" style={{ '--mc': m.color }} onClick={() => enter(m)} disabled={busyId === m.id}>
                  <span className="module-icon" style={{ background: m.color }}><Icon name={m.icon} size={26} /></span>
                  <span className="module-name">
                    {m.name}
                    {m.admin_preview && <span className="module-admin-flag" title="该模块尚未对普通用户上线，仅管理员可见">未上线</span>}
                  </span>
                  <span className="module-tagline">{m.tagline}</span>
                  {m.has_tool && <span className="module-tool"><Icon name="zap" size={12} /> {m.tool_name}</span>}
                  <span className="module-enter">进入 <Icon name="arrow-right" size={14} /></span>
                </button>
              ))}
            </section>

            {isAdmin && (
              <p className="portal-offline-hint">
                管理员视角：全部 {available.length} 个模块均可进入；标「未上线」的尚未对普通用户开放，可在「管理后台 → 模块管理」中上线。
              </p>
            )}

            {locked.length > 0 && (
              <>
                <h2 className="portal-subtitle">待开通模块</h2>
                <section className="module-grid">
                  {locked.map((m) => (
                    <div key={m.id} className="module-card locked" style={{ '--mc': m.color }}>
                      <span className="module-icon" style={{ background: m.color, filter: 'grayscale(0.7)', opacity: 0.55 }}>
                        <Icon name={m.icon} size={26} />
                      </span>
                      <span className="module-name">{m.name}</span>
                      <span className="module-tagline">{m.tagline}</span>
                      <span className="module-lock"><Icon name="lock" size={13} /> {m.default_grant ? '' : '未开通'}</span>
                      <button className="module-apply" disabled={busyId === m.id} onClick={() => (m.open_mode === 'auto' ? authorize(m) : setApplyFor(m))}>
                        {m.open_mode === 'auto' ? '一键开通' : '申请开通'}
                      </button>
                    </div>
                  ))}
                </section>
              </>
            )}

            {offline.length > 0 && (
              <p className="portal-offline-hint">
                另有 {offline.length} 个模块（{offline.map((m) => m.name).join('、')}）暂未上线，敬请期待。
              </p>
            )}
          </>
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
