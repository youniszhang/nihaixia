export default function Sidebar({ sessions, activeId, onSelect, onNew, onDelete, onProfile, onAdmin, user, onLogout, onClose }) {
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
          <button className="btn-primary new-chat" onClick={onNew}>＋ 新问诊</button>
        </div>

        <div className="session-list">
          {sessions.length === 0 && <p className="session-empty">还没有问诊记录，点击上方开始。</p>}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item ${s.id === activeId ? 'active' : ''}`}
              onClick={() => onSelect(s.id)}
            >
              <span className="session-title">{s.title}</span>
              <button
                className="session-del"
                title="删除"
                onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
              >✕</button>
            </div>
          ))}
        </div>

        <div className="sidebar-bottom">
          <button className="side-link" onClick={onProfile}>👤 体质档案</button>
          {user?.is_admin && <button className="side-link" onClick={onAdmin}>⚙️ 模型设置</button>}
          <div className="side-user">
            <span className="side-avatar">{user?.username?.slice(0, 1)?.toUpperCase() || 'U'}</span>
            <span className="side-username">{user?.username}</span>
            <button className="side-logout" onClick={onLogout} title="退出登录">退出</button>
          </div>
        </div>
      </aside>
    </>
  );
}
