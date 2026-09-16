import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import AdminDashboard from './admin/AdminDashboard.jsx';
import AdminUsers from './admin/AdminUsers.jsx';
import AdminConversations from './admin/AdminConversations.jsx';
import AdminReports from './admin/AdminReports.jsx';
import AdminPlans from './admin/AdminPlans.jsx';
import AdminSite from './admin/AdminSite.jsx';
import AdminSettings from './AdminSettings.jsx';
import SystemUpdate from './SystemUpdate.jsx';
import Icon from './Icon.jsx';

// 管理员独立后台：与用户问诊界面完全分离的全屏控制台。
// 入口在侧边栏（仅管理员可见）。标签页：概览 / 用户 / 对话 / 报表 / 订阅与额度 / 模型 / 站点 / 系统。
const TABS = [
  { key: 'dashboard', label: '概览', icon: 'chart' },
  { key: 'users', label: '用户管理', icon: 'users' },
  { key: 'conversations', label: '对话记录', icon: 'message' },
  { key: 'reports', label: '使用报表', icon: 'trending' },
  { key: 'plans', label: '订阅与额度', icon: 'crown' },
  { key: 'model', label: '模型设置', icon: 'settings' },
  { key: 'site', label: '站点设置', icon: 'wrench' },
  { key: 'system', label: '系统更新', icon: 'refresh' },
];

export default function AdminConsole({ onClose, user }) {
  const [tab, setTab] = useState('dashboard');
  // 用户管理需要跳到对话页并带过滤，用这个状态传递
  const [convFilter, setConvFilter] = useState(null);
  // 用户管理 → 订阅与额度：带用户跳过去并直接打开开通弹窗
  const [grantFor, setGrantFor] = useState(null);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function viewUserConversations(u) {
    setConvFilter({ userId: u.id, username: u.username });
    setTab('conversations');
  }

  function grantForUser(u) {
    setGrantFor({ userId: u.id, username: u.username });
    setTab('plans');
  }

  const active = TABS.find((t) => t.key === tab);

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
              onClick={() => { setTab(t.key); if (t.key !== 'conversations') setConvFilter(null); if (t.key !== 'plans') setGrantFor(null); }}
            >
              <Icon name={t.icon} size={17} />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="admin-nav-foot">
          <button className="admin-nav-back" onClick={onClose}>
            <Icon name="arrow-left" size={16} /> 返回问诊
          </button>
        </div>
      </aside>

      <main className="admin-main">
        <header className="admin-header">
          <h1><Icon name={active?.icon} size={20} /> {active?.label}</h1>
          <button className="icon-btn" onClick={onClose} title="关闭后台" aria-label="关闭后台">
            <Icon name="close" size={19} />
          </button>
        </header>
        <div className="admin-body">
          {tab === 'dashboard' && <AdminDashboard onGoTab={setTab} />}
          {tab === 'users' && <AdminUsers onViewConversations={viewUserConversations} onGrantSubscription={grantForUser} />}
          {tab === 'conversations' && <AdminConversations filter={convFilter} onClearFilter={() => setConvFilter(null)} />}
          {tab === 'reports' && <AdminReports />}
          {tab === 'plans' && <AdminPlans initialGrantFor={grantFor} onClearGrantFor={() => setGrantFor(null)} />}
          {tab === 'model' && <AdminSettings onClose={onClose} />}
          {tab === 'site' && <AdminSite />}
          {tab === 'system' && <SystemUpdate onClose={onClose} />}
        </div>
      </main>
    </div>
  );
}
