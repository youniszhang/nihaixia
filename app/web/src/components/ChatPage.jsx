import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/store.jsx';
import MarkdownMessage from './MarkdownMessage.jsx';
import ProfileForm from './ProfileForm.jsx';
import IntakeSheet from './IntakeSheet.jsx';
import Sidebar from './Sidebar.jsx';
import AdminConsole from './AdminConsole.jsx';
import DisclaimerModal from './DisclaimerModal.jsx';
import MembershipPanel from './MembershipPanel.jsx';
import Icon from './Icon.jsx';

const DISCLAIMER_SEEN_KEY = 'nhx_disclaimer_accepted_v1';

export default function ChatPage() {
  const { user, logout } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showIntake, setShowIntake] = useState(false);
  const [showAdminConsole, setShowAdminConsole] = useState(false);
  const [showMembership, setShowMembership] = useState(false);
  const [showDisclaimer, setShowDisclaimer] = useState(
    typeof localStorage !== 'undefined' && !localStorage.getItem(DISCLAIMER_SEEN_KEY)
  );
  const [intakeNote, setIntakeNote] = useState(''); // pinned summary (十问/舌象) for active session
  const [sessionTitle, setSessionTitle] = useState('');
  const [errNote, setErrNote] = useState(''); // 最近一次生成失败的原因（常驻到下次发送）
  const [quota, setQuota] = useState(null);   // 剩余额度 / 今日用量
  const [checkedInToday, setCheckedInToday] = useState(false);
  // 历史加载：默认只取最近一页；向上滚动再按需加载更早的（长会话全量渲染会明显卡顿）
  const PAGE_SIZE = 40;
  const RENDER_WINDOW = 60; // 同时渲染的消息上限（更早的折叠为「显示更早」）
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [renderAll, setRenderAll] = useState(false);
  const oldestIdRef = useRef(null);

  function acceptDisclaimer() {
    try { localStorage.setItem(DISCLAIMER_SEEN_KEY, '1'); } catch { /* private mode */ }
    setShowDisclaimer(false);
  }

  const scrollRef = useRef(null);
  const abortRef = useRef(null);
  const scrollHostRef = useRef(null);
  const listRef = useRef(sessions);
  listRef.current = sessions;
  // 会话消息缓存：点历史先出内容再静默刷新，避免闪空状态（"看起来像弹回新问诊"）
  const messageCacheRef = useRef(new Map());
  const activeIdRef = useRef(null);
  activeIdRef.current = activeId;

  const refreshSessions = useCallback(async () => {
    try {
      const { sessions: s } = await api.listSessions();
      setSessions(s);
    } catch { /* ignore */ }
  }, []);

  // 额度与签到状态：进入页面、每次签到/问诊后刷新（侧边栏与顶部徽标都用它）
  const refreshQuota = useCallback(async () => {
    try {
      const d = await api.checkin();
      setQuota(d.quota);
      setCheckedInToday(Boolean(d.checkin?.checked_in));
    } catch { /* 接口异常时保持上一次的值 */ }
  }, []);

  useEffect(() => { refreshSessions(); }, [refreshSessions]);
  useEffect(() => { refreshQuota(); }, [refreshQuota]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming]);

  // ---- session selection ----
  async function openSession(id) {
    if (streaming) { abortRef.current?.abort(); setStreaming(false); }
    // 已缓存则立即渲染，避免"点历史先闪一下空状态、看起来像弹回新问诊"
    const cached = messageCacheRef.current.get(id);
    setActiveId(id);
    setRenderAll(false);
    setHasMore(false);
    if (cached) {
      setMessages(cached.messages);
      setHasMore(cached.hasMore);
      oldestIdRef.current = cached.messages[0]?.id ?? null;
      setIntakeNote(cached.pin || '');
      setSessionTitle(cached.title);
      setLoadingSession(false);
      setSidebarOpen(false);
      // 后台静默刷新（拿到最新消息后替换），不阻塞、不闪屏
      api.getSession(id, { limit: PAGE_SIZE }).then((d) => {
        const list = d.messages || [];
        messageCacheRef.current.set(id, {
          messages: list, hasMore: Boolean(d.has_more), pin: d.session.pin || '', title: d.session.title,
        });
        if (activeIdRef.current === id) {
          setMessages(list);
          setHasMore(Boolean(d.has_more));
          oldestIdRef.current = list[0]?.id ?? null;
          setSessionTitle(d.session.title);
        }
      }).catch(() => {});
      return;
    }
    setMessages([]);
    setLoadingSession(true);
    try {
      // 只取最近一页：长会话（几百条 × 每条数 KB）全量返回 + 全量渲染是「点开历史很慢」的主因
      const data = await api.getSession(id, { limit: PAGE_SIZE });
      const list = data.messages || [];
      messageCacheRef.current.set(id, {
        messages: list, hasMore: Boolean(data.has_more), pin: data.session.pin || '', title: data.session.title,
      });
      setMessages(list);
      setHasMore(Boolean(data.has_more));
      oldestIdRef.current = list[0]?.id ?? null;
      setIntakeNote(data.session.pin || '');
      setSessionTitle(data.session.title);
    } catch { /* ignore */ }
    setLoadingSession(false);
    setSidebarOpen(false);
  }

  // 向上翻页：加载更早的一页并插到列表头部（保持滚动位置不跳）
  async function loadEarlier() {
    if (!activeId || loadingMore || !hasMore) return;
    setLoadingMore(true);
    const scrollEl = scrollHostRef.current;
    const prevHeight = scrollEl ? scrollEl.scrollHeight : 0;
    try {
      const data = await api.getSession(activeId, { limit: PAGE_SIZE, beforeId: oldestIdRef.current });
      const earlier = data.messages || [];
      if (earlier.length) {
        oldestIdRef.current = earlier[0].id;
        setMessages((m) => [...earlier, ...m]);
        // 插入后把视口钉回原来的位置，避免"跳到顶部"
        requestAnimationFrame(() => {
          if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight - prevHeight;
        });
      }
      setHasMore(Boolean(data.has_more));
    } catch { /* ignore */ }
    setLoadingMore(false);
  }

  async function newSession() {
    if (streaming) { abortRef.current?.abort(); setStreaming(false); }
    const { session } = await api.createSession('新问诊');
    await refreshSessions();
    setActiveId(session.id);
    setMessages([]);
    setIntakeNote('');
    setSessionTitle('新问诊');
    setSidebarOpen(false);
  }

  async function deleteSession(id) {
    if (!confirm('确定删除该问诊记录？此操作不可恢复。')) return;
    await api.deleteSession(id).catch(() => {});
    await refreshSessions();
    if (id === activeId) { setActiveId(null); setMessages([]); setIntakeNote(''); }
  }

  // ---- intake pin (十问/舌象) ----
  function applyIntake(summary) {
    setIntakeNote(summary);
    setShowIntake(false);
  }
  function removeIntake() { setIntakeNote(''); }

  // ---- send ----
  async function send() {
    const content = input.trim();
    if (!content || streaming) return;
    let sid = activeId;
    if (!sid) {
      const { session } = await api.createSession('新问诊');
      sid = session.id;
      setActiveId(sid);
    }

    // Optimistic local message
    const userMsg = { id: `tmp-${Date.now()}`, role: 'user', content };
    setMessages((m) => [...m, userMsg]);
    setInput('');
    setStreaming(true);
    setErrNote('');

    const asstMsg = { id: `tmp-${Date.now()}-a`, role: 'assistant', content: '' };
    setMessages((m) => [...m, asstMsg]);

    const controller = new AbortController();
    abortRef.current = controller;
    let acc = '';
    try {
      for await (const ev of api.streamChat(sid, content, controller.signal, intakeNote)) {
        if (ev.type === 'delta') {
          acc += ev.text;
          setMessages((m) => m.map((x) => (x.id === asstMsg.id ? { ...x, content: acc } : x)));
        } else if (ev.type === 'done') {
          setMessages((m) => m.map((x) => (x.id === asstMsg.id ? { ...x, id: ev.message_id, content: acc } : x)));
          // 服务端在 done 事件里带回最新额度，免去再发一次请求
          if (ev.quota) setQuota(ev.quota);
          break;
        } else if (ev.type === 'notice') {
          // 中间提示（如自动重启浏览器重试）：临时显示在占位气泡里
          setMessages((m) => m.map((x) => (x.id === asstMsg.id ? { ...x, content: acc || `> 提示：${ev.text}` } : x)));
        } else if (ev.type === 'error') {
          // 失败原因单独保存：finally 里会用服务端持久化的消息覆盖气泡，
          // 只写进气泡的话错误会在刷新后消失，用户完全看不到发生了什么
          setErrNote(ev.message);
          break;
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') setErrNote(e.message || String(e));
    } finally {
      setStreaming(false);
      abortRef.current = null;
      refreshSessions();
      refreshQuota();
      // Refresh active session's persisted messages to reconcile ids
      // 只回填最近一页（刚发完的消息一定在这页里），避免长会话重新拉全量
      api.getSession(sid, { limit: PAGE_SIZE }).then((d) => {
        const list = d.messages || [];
        setMessages(list);
        setHasMore(Boolean(d.has_more));
        oldestIdRef.current = list[0]?.id ?? null;
        setSessionTitle(d.session.title);
        messageCacheRef.current.set(sid, {
          messages: list, hasMore: Boolean(d.has_more), pin: d.session.pin || '', title: d.session.title,
        });
      }).catch(() => {});
    }
  }

  function stop() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  const activeSession = sessions.find((s) => s.id === activeId);
  // 额度/上限类错误 → 直接把用户引到「我的额度」面板（签到或订阅）
  const quotaBlocked = /额度|上限/.test(errNote);

  return (
    <div className={`app-shell ${sidebarOpen ? 'sidebar-visible' : ''}`}>
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        onSelect={openSession}
        onNew={newSession}
        onDelete={deleteSession}
        onProfile={() => setShowProfile(true)}
        user={user}
        onLogout={logout}
        onAdminConsole={() => setShowAdminConsole(true)}
        onMembership={() => setShowMembership(true)}
        onClose={() => setSidebarOpen(false)}
        quota={quota}
        checkedInToday={checkedInToday}
      />

      <main className="main">
        <header className="main-header">
          <button className="icon-btn menu-btn" onClick={() => setSidebarOpen(true)} aria-label="菜单">
            <Icon name="menu" size={20} />
          </button>
          <div className="header-title">
            <h1>{activeSession?.title || '新问诊'}</h1>
            {intakeNote && (
              <button className="pin-chip" onClick={removeIntake} title="移除问诊摘要">
                <Icon name="clipboard" size={13} /> 已附问诊摘要 <Icon name="close" size={12} />
              </button>
            )}
          </div>
          {quota && (
            <button
              className={`quota-badge ${!quota.unlimited && quota.credits <= 3 ? 'low' : ''}`}
              onClick={() => setShowMembership(true)}
              title="查看额度、签到与订阅"
            >
              <Icon name="coins" size={15} />
              {quota.unlimited ? '不限次' : `剩余 ${quota.credits}`}
            </button>
          )}
          <button className="icon-btn" onClick={() => setShowIntake(true)} title="十问 / 舌象 快速问诊单" aria-label="问诊单">
            <Icon name="stethoscope" size={20} />
          </button>
        </header>

        <div className="chat-scroll" ref={scrollHostRef}>
          {loadingSession && messages.length === 0 ? (
            <div className="chat-loading">
              <div className="loading-spinner" />
              <p>正在加载问诊记录…</p>
            </div>
          ) : messages.length === 0 && !streaming ? (
            <EmptyState onIntake={() => setShowIntake(true)} onNew={newSession} />
          ) : (
            <div className="msg-list">
              {(hasMore || (!renderAll && messages.length > RENDER_WINDOW)) && (
                <div className="load-earlier">
                  {hasMore ? (
                    <button className="text-btn" onClick={loadEarlier} disabled={loadingMore}>
                      {loadingMore ? '加载中…' : '加载更早的记录'}
                    </button>
                  ) : (
                    <button className="text-btn" onClick={() => setRenderAll(true)}>
                      显示更早的 {messages.length - RENDER_WINDOW} 条
                    </button>
                  )}
                </div>
              )}
              {(renderAll || messages.length <= RENDER_WINDOW
                ? messages
                : messages.slice(-RENDER_WINDOW)
              ).map((m) => {
                // 回复占位（还没收到第一个字）：只渲染一个带打字动画的气泡
                if (m.role === 'assistant' && !m.content) {
                  if (streaming && m.id === messages[messages.length - 1]?.id) {
                    return (
                      <div key={m.id} className="msg assistant">
                        <div className="msg-avatar">倪</div>
                        <div className="msg-body typing-dots"><span /><span /><span /></div>
                      </div>
                    );
                  }
                  return null; // 非流式状态下的空泡不渲染
                }
                return (
                  <div key={m.id} className={`msg ${m.role}`}>
                    <div className="msg-avatar">{m.role === 'user' ? '你' : '倪'}</div>
                    <div className="msg-body">
                      {m.role === 'assistant' ? <MarkdownMessage content={m.content} /> : <div className="msg-plain">{m.content}</div>}
                      {m.role === 'assistant' && m.content && (
                        <p className="msg-tag">
                          <Icon name="alert" size={13} /> 以上内容由 AI 生成，仅供中医学习参考，不构成医疗建议
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div ref={scrollRef} />
        </div>

        <div className="composer-wrap">
          {errNote && (
            <div className="chat-error" role="alert">
              <span><Icon name="alert" size={15} /> {errNote}</span>
              <span className="chat-error-actions">
                {quotaBlocked && (
                  <button type="button" className="text-btn" onClick={() => { setShowMembership(true); setErrNote(''); }}>
                    去签到 / 订阅
                  </button>
                )}
                <button type="button" className="text-btn" onClick={() => setErrNote('')}>知道了</button>
              </span>
            </div>
          )}
          <div className="composer">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              placeholder={activeId ? '描述你的症状，或按倪师的思路问诊…' : '点击右上方问诊单，或直接描述症状…'}
              rows={1}
            />
            <div className="composer-actions">
              <div className="composer-notes">
                <button className="text-btn" onClick={() => setShowIntake(true)}>
                  <Icon name="clipboard" size={14} /> 十问 / 舌象
                </button>
              </div>
              {streaming ? (
                <button className="stop-btn" onClick={stop} title="停止生成" aria-label="停止生成">
                  <Icon name="stop" size={16} />
                </button>
              ) : (
                <button className="send-btn" onClick={send} disabled={!input.trim()} title="发送" aria-label="发送">
                  <Icon name="send" size={17} />
                </button>
              )}
            </div>
          </div>
          <p className="disclaimer">
            本服务由 AI 生成，仅供中医学习与学术研究，不构成医疗诊断或治疗建议，请以执业医师意见为准。<br />
            急危重症（胸痛、呼吸困难、大出血、昏迷、高热不退等）请立即拨打 120 或前往急诊。
          </p>
        </div>
      </main>

      {showProfile && (
        <div className="overlay" onClick={() => setShowProfile(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <h2>体质档案</h2>
              <button className="icon-btn" onClick={() => setShowProfile(false)} aria-label="关闭">
                <Icon name="close" size={18} />
              </button>
            </div>
            <ProfileForm onClose={() => setShowProfile(false)} />
          </div>
        </div>
      )}

      {showIntake && (
        <div className="overlay" onClick={() => setShowIntake(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <h2>问诊单 · 十问 / 舌象</h2>
              <button className="icon-btn" onClick={() => setShowIntake(false)} aria-label="关闭">
                <Icon name="close" size={18} />
              </button>
            </div>
            <IntakeSheet onApply={applyIntake} onClose={() => setShowIntake(false)} />
          </div>
        </div>
      )}

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
              onQuotaChange={(q) => { if (q) setQuota(q); }}
            />
          </div>
        </div>
      )}

      {showAdminConsole && (
        <AdminConsole user={user} onClose={() => setShowAdminConsole(false)} />
      )}

      {showDisclaimer && (
        <DisclaimerModal onAccept={acceptDisclaimer} />
      )}
    </div>
  );
}

function EmptyState({ onIntake, onNew }) {
  return (
    <div className="empty">
      <div className="empty-logo">医</div>
      <h2>倪海厦中医问诊</h2>
      <p className="empty-quote">「中医很简单，就是阴阳气血。你搞懂了，一通百通。」</p>
      <div className="empty-actions">
        <button className="btn-primary" onClick={onIntake}>
          <Icon name="stethoscope" size={17} /> 填写问诊单
        </button>
        <button className="btn-ghost" onClick={onNew}>
          <Icon name="plus" size={16} /> 新问诊
        </button>
      </div>
      <div className="suggestions">
        <button onClick={() => onIntake()}>我感冒了，怕冷没汗</button>
        <button onClick={() => onIntake()}>总是失眠，心慌</button>
        <button onClick={() => onIntake()}>胃口不好，肚子胀</button>
        <button onClick={() => onIntake()}>手脚冰凉，腰酸</button>
      </div>
    </div>
  );
}
