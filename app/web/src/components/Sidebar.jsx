import Icon from './Icon.jsx';

// 侧边栏：问诊历史 + 用户入口。图标统一用 Icon（SVG），不再用 emoji。
export default function Sidebar({
  sessions, activeId, onSelect, onNew, onDelete, onProfile, onAdminConsole,
  user, onLogout, onClose, quota, checkedInToday, onMembership,
}) {
  const unlimited = quota?.unlimited;
  const credits = quota?.credits;
  const limitText = quota
    ? (quota.daily_limit > 0 ? `${quota.used_today}/${quota.daily_limit}` : '不限')
    : null;

  return (
    <>
      <div className="sidebar-mask" onClick={onClose} />
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand">
            <span className="brand-seal">医</span>
            <div>
              <strong>倪海厦问诊</strong>
              <small>经方派 AI 助手</small>
            </div>
          </div>
          <button className="btn-primary new-chat" onClick={onNew}>
            <Icon name="plus" size={17} /> 新问诊
          </button>
        </div>

        <div className="session-list">
          {sessions.length === 0 && <p className="session-empty">还没有问诊记录，点击上方开始。</p>}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item ${s.id === activeId ? 'active' : ''}`}
              onClick={() => onSelect(s.id)}
            >
              <Icon name="message" size={15} className="session-icon" />
              <span className="session-title">{s.title}</span>
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
            <button className="side-logout" onClick={onLogout} title="退出登录">
              <Icon name="logout" size={15} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
