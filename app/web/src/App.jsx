import { useEffect, useState } from 'react';
import { api } from './lib/api.js';
import { useAuth } from './lib/store.jsx';
import AuthPage from './components/AuthPage.jsx';
import ModulePortal from './components/ModulePortal.jsx';
import ChatPage from './components/ChatPage.jsx';
import StudyPage from './components/StudyPage.jsx';
import AdminConsole from './components/AdminConsole.jsx';
import MembershipPanel from './components/MembershipPanel.jsx';
import Icon from './components/Icon.jsx';

// 玄枢 · 应用外壳
//   登录前 → AuthPage
//   登录后 → ModulePortal（模块门户，选择一位「先生」）
//   选定模块 → ChatPage（问诊/咨询）或 StudyPage（学习中心）
//   activeView: 'chat' | 'study' —— 同一模块下两个工作台
export default function App() {
  const { user, loading, logout } = useAuth();
  // 当前进入的模块（null = 停留在门户）
  const [activeModule, setActiveModule] = useState(null);
  // 模块内工作台：chat（默认，问诊/咨询）| study（学习中心）
  const [activeView, setActiveView] = useState('chat');
  // 门户拉到的模块目录（含服务端返回的全部展示字段）
  const [catalog, setCatalog] = useState([]);
  // 从门户直接打开管理后台
  const [showAdmin, setShowAdmin] = useState(false);
  // 门户的额度面板（与 ChatPage 内的是同一个组件）
  const [showMembership, setShowMembership] = useState(false);

  useEffect(() => {
    if (!user) { setActiveModule(null); return; }
    api.listModules().then((d) => setCatalog(d.modules || [])).catch(() => {});
  }, [user]);

  // 与浏览器历史联动：进入模块压一条记录，返回键/手势可回到门户。
  // （PWA 独立窗口没有浏览器返回键，所以聊天页顶栏另有常驻返回入口）
  useEffect(() => {
    if (window.history.state?.xuanshu === undefined) {
      window.history.replaceState({ xuanshu: 'portal' }, '');
    }
    function onPop(e) {
      const s = e.state;
      setActiveModule(s && s.xuanshu === 'module' && s.module ? s.module : null);
      // 视图也要跟着历史记录恢复（聊天 ↔ 学习中心的切换也压了历史）
      setActiveView(s && s.view === 'study' ? 'study' : 'chat');
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // 刷新 / PWA 重开时按 URL hash 恢复到所在模块（否则刷新会掉回门户）
  // 形态：#tcm（聊天）或 #tcm/study（学习中心）
  useEffect(() => {
    if (!user || activeModule || !catalog.length) return;
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const [id, view] = hash.split('/');
    const m = catalog.find((x) => x.id === id);
    if (!m) return;
    setActiveModule(m);
    setActiveView(view === 'study' ? 'study' : 'chat');
    window.history.replaceState({ xuanshu: 'module', module: m, view: view === 'study' ? 'study' : 'chat' }, '', `#${hash}`);
  }, [user, catalog, activeModule]);

  const enterModule = (m, view = 'chat') => {
    setActiveModule(m);
    setActiveView(view);
    window.history.pushState({ xuanshu: 'module', module: m, view }, '', `#${m.id}${view === 'study' ? '/study' : ''}`);
  };
  const backToPortal = () => {
    setActiveModule(null);
    setActiveView('chat');
    // 历史栈里可能有 [门户, 聊天, 学习中心] 多级记录。
    // 直接按「最近的 portal 记录」回退步数：数一下栈顶到 portal 之间压了几条 module 记录。
    const stack = [];
    // history 无法直接读全栈，但我们在 pushState 时维护了自己的视图路径：
    // 用 hash 判断——门户 hash 为空，模块 hash 非空。安全做法：直接替换当前状态为门户，
    // 不再依赖 back（避免「点两次才回得去」）。
    window.history.replaceState({ xuanshu: 'portal' }, '', '#');
  };

  if (loading) {
    return (
      <div className="app-loading">
        <div className="loading-spinner" />
        <p>加载中…</p>
      </div>
    );
  }
  if (!user) {
    return <AuthPage />;
  }
  const adminOverlay = showAdmin ? (
    <AdminConsole user={user} onClose={() => setShowAdmin(false)} />
  ) : null;
  if (!activeModule) {
    return (
      <>
        <ModulePortal
          user={user}
          catalog={catalog}
          onEnter={enterModule}
          onMembership={() => setShowMembership(true)}
          onAdminConsole={() => setShowAdmin(true)}
          onLogout={logout}
        />
        {showMembership && (
          <div className="overlay" onClick={() => setShowMembership(false)}>
            <div className="sheet sheet-wide" onClick={(e) => e.stopPropagation()}>
              <div className="sheet-head">
                <h2><Icon name="coins" size={18} /> 我的额度</h2>
                <button className="icon-btn" onClick={() => setShowMembership(false)} aria-label="关闭">
                  <Icon name="close" size={18} />
                </button>
              </div>
              <MembershipPanel
                onClose={() => setShowMembership(false)}
                onQuotaChange={() => { /* 门户不缓存额度；进入模块后由 ChatPage 拉取 */ }}
              />
            </div>
          </div>
        )}
        {adminOverlay}
      </>
    );
  }
  return (
    <>
      {activeView === 'study' ? (
        <StudyPage module={activeModule} onBackToPortal={backToPortal} />
      ) : (
        <ChatPage
          module={activeModule}
          onBackToPortal={backToPortal}
          onEnterStudy={() => enterModule(activeModule, 'study')}
        />
      )}
      {adminOverlay}
    </>
  );
}
