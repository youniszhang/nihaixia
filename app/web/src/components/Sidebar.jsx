import { useEffect, useRef } from 'react';
import Icon from './Icon.jsx';

// 侧边栏：当前模块的会话历史 + 用户入口。图标统一用 Icon（SVG），不再用 emoji。
export default function Sidebar({
  module, onBackToPortal, sessions, activeId, onSelect, onNew, onDelete, onProfile, onAdminConsole,
  user, onLogout, onClose, quota, checkedInToday, onMembership, onCollapse, collapsed, collapseButtonRef, mobileOpen,
}) {
  const sidebarRef = useRef(null);
  const closeButtonRef = useRef(null);
  const unlimited = quota?.unlimited;
  const credits = quota?.credits;
  const limitText = quota
    ? (quota.daily_limit > 0 ? `${quota.used_today}/${quota.daily_limit}` : '不限')
    : null;
  const isTcm = module?.id === 'tcm';

  useEffect(() => {
    if (!mobileOpen) return;
    const trigger = document.activeElement;
    closeButtonRef.current?.focus();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, [mobileOpen]);

  function handleKeyDown(e) {
    if (!mobileOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
    if (e.key === 'Tab') {
      const buttons = [...sidebarRef.current.querySelectorAll('button:not(:disabled)')]
        .filter((button) => button.getClientRects().length > 0);
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  }

  return (
    <>
      <div className="sidebar-mask" onClick={onClose} />
      <aside id="chat-sidebar" className="sidebar" ref={sidebarRef} onKeyDown={handleKeyDown}
        role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen || undefined} aria-label="对话侧栏">
        <div className="sidebar-top">
          <div className="brand">
            <span className="brand-seal" style={isTcm ? undefined : { background: module?.color }}>{module?.name?.slice(0, 1) || '玄'}</span>
            <div>
              <strong>{module?.name || '玄枢'}</strong>
              <small>{module?.tagline || '传统智慧 AI 工作台'}</small>
            </div>
          </div>
          <button className="icon-btn sidebar-close-btn" ref={closeButtonRef} onClick={onClose} title="收起侧栏" aria-label="收起侧栏" aria-expanded={true} aria-controls="chat-sidebar">
            <Icon name="panel-left-close" size={18} /><span>收起</span>
          </button>
          <div className="sidebar-top-actions">
            <button className="btn-primary new-chat" onClick={onNew}>
              <Icon name="plus" size={17} /> 新对话
            </button>
            {onCollapse && (
              <button
                className="icon-btn sidebar-collapse-btn"
                ref={collapseButtonRef}
                onClick={onCollapse}
                title="收起侧栏"
                aria-label="收起侧栏"
                aria-expanded={!collapsed}
                aria-controls="chat-sidebar"
              >
                <Icon name="panel-left-close" size={18} /><span>收起</span>
              </button>
            )}
          </div>
        </div>

        <button className="back-portal" onClick={onBackToPortal} title="返回首页，查看全部模块">
          <Icon name="home" size={15} /> 首页 · 全部模块
        </button>

        <div className="session-list">
          <p className="session-label">最近对话</p>
          {sessions.length === 0 && <p className="session-empty">还没有对话记录，点击上方开始。</p>}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item ${s.id === activeId ? 'active' : ''}`}
            >
              <button className="session-select" onClick={() => onSelect(s.id)} aria-current={s.id === activeId ? 'page' : undefined}>
                <Icon name="message" size={15} className="session-icon" />
                <span className="session-title">{s.title}</span>
              </button>
              <button
                className="session-del"
                title="删除"
                aria-label={`删除会话 ${s.title}`}
                onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </div>

        <div className="sidebar-bottom">
          <button className="side-link quota-link" onClick={onMembership}>
            <Icon name="coins" size={16} />
            <span>我的额度</span>
            <span className="quota-chip">
              {quota
                ? (unlimited ? '不限次' : `${credits} 次`)
                : '—'}
            </span>
          </button>
          {quota && (
            <div className="side-quota-hint">
              今日 {limitText}
              {!unlimited && !checkedInToday && <span className="quota-dot" title="今日还没签到">未签到</span>}
            </div>
          )}
          <button className="side-link" onClick={onProfile}>
            <Icon name="user" size={16} /> 体质档案
          </button>
          {user?.is_admin && (
            <button className="side-link" onClick={onAdminConsole}>
              <Icon name="shield" size={16} /> 管理后台
            </button>
          )}
          <div className="side-user">
            <span className="side-avatar">{user?.username?.slice(0, 1)?.toUpperCase() || 'U'}</span>
            <span className="side-username">{user?.username}</span>
            <button className="side-logout" onClick={onLogout} title="退出登录" aria-label="退出登录">
              <Icon name="logout" size={15} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
