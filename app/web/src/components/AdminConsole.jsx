import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import AdminDashboard from './admin/AdminDashboard.jsx';
import AdminUsers from './admin/AdminUsers.jsx';
import AdminConversations from './admin/AdminConversations.jsx';
import AdminReports from './admin/AdminReports.jsx';
import AdminSettings from './AdminSettings.jsx';
import SystemUpdate from './SystemUpdate.jsx';

// 管理员独立后台：与用户问诊界面完全分离的全屏控制台。
// 入口在侧边栏（仅管理员可见）。标签页：概览 / 用户 / 对话记录 / 报表 / 模型 / 系统。
const TABS = [
  { key: 'dashboard', label: '📊 概览' },
  { key: 'users', label: '👥 用户管理' },
  { key: 'conversations', label: '💬 对话记录' },
  { key: 'reports', label: '📈 使用报表' },
  { key: 'model', label: '⚙️ 模型设置' },
  { key: 'system', label: '🔄 系统更新' },
];

export default function AdminConsole({ onClose, user }) {
  const [tab, setTab] = useState('dashboard');
  // 用户管理需要跳到对话页并带过滤，用这个状态传递
  const [convFilter, setConvFilter] = useState(null);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function viewUserConversations(u) {
    setConvFilter({ userId: u.id, username: u.username });
    setTab('conversations');
  }

  return (
    <div className="admin-console">
      <aside className="admin-nav">
        <div className="admin-brand">
          <span className="brand-seal">管</span>
          <div>
            <strong>管理后台</strong>
            <small>{user?.username || 'admin'}</small>
          </div>
        </div>
        <nav>
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`admin-nav-item ${tab === t.key ? 'active' : ''}`}
              onClick={() => { setTab(t.key); if (t.key !== 'conversations') setConvFilter(null); }}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="admin-nav-foot">
          <button className="admin-nav-back" onClick={onClose}>← 返回问诊</button>
        </div>
      </aside>

      <main className="admin-main">
        <header className="admin-header">
          <h1>{TABS.find((t) => t.key === tab)?.label}</h1>
          <button className="icon-btn" onClick={onClose} title="关闭后台">✕</button>
        </header>
        <div className="admin-body">
          {tab === 'dashboard' && <AdminDashboard onGoTab={setTab} />}
          {tab === 'users' && <AdminUsers onViewConversations={viewUserConversations} />}
          {tab === 'conversations' && <AdminConversations filter={convFilter} onClearFilter={() => setConvFilter(null)} />}
          {tab === 'reports' && <AdminReports />}
          {tab === 'model' && <AdminSettings onClose={onClose} />}
          {tab === 'system' && <SystemUpdate onClose={onClose} />}
        </div>
      </main>
    </div>
  );
}
