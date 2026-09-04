import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/store.jsx';
import MarkdownMessage from './MarkdownMessage.jsx';
import ProfileForm from './ProfileForm.jsx';
import IntakeSheet from './IntakeSheet.jsx';
import Sidebar from './Sidebar.jsx';
import AdminSettings from './AdminSettings.jsx';
import DisclaimerModal from './DisclaimerModal.jsx';

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
  const [showAdmin, setShowAdmin] = useState(false);
  const [showDisclaimer, setShowDisclaimer] = useState(
    typeof localStorage !== 'undefined' && !localStorage.getItem(DISCLAIMER_SEEN_KEY)
  );
  const [intakeNote, setIntakeNote] = useState(''); // pinned summary (十问/舌象) for active session
  const [sessionTitle, setSessionTitle] = useState('');

  function acceptDisclaimer() {
    try { localStorage.setItem(DISCLAIMER_SEEN_KEY, '1'); } catch { /* private mode */ }
    setShowDisclaimer(false);
  }

  const scrollRef = useRef(null);
  const abortRef = useRef(null);
  const listRef = useRef(sessions);
  listRef.current = sessions;

  const refreshSessions = useCallback(async () => {
    try {
      const { sessions: s } = await api.listSessions();
      setSessions(s);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { refreshSessions(); }, [refreshSessions]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming]);

  // ---- session selection ----
  async function openSession(id) {
    if (streaming) { abortRef.current?.abort(); setStreaming(false); }
    setActiveId(id);
    setMessages([]);
    try {
      const data = await api.getSession(id);
      setMessages(data.messages || []);
      setIntakeNote(data.session.pin || '');
      setSessionTitle(data.session.title);
    } catch { /* ignore */ }
    setSidebarOpen(false);
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
          break;
        } else if (ev.type === 'error') {
          setMessages((m) => m.map((x) => (x.id === asstMsg.id ? { ...x, content: acc + (acc ? '\n\n' : '') + `> ⚠️ ${ev.message}` } : x)));
          break;
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        setMessages((m) => m.map((x) => (x.id === asstMsg.id ? { ...x, content: acc + `\n\n> ⚠️ ${e.message}` } : x)));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      refreshSessions();
      // Refresh active session's persisted messages to reconcile ids
      api.getSession(sid).then((d) => {
        setMessages(d.messages || []);
        setSessionTitle(d.session.title);
      }).catch(() => {});
    }
  }

  function stop() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  const activeSession = sessions.find((s) => s.id === activeId);

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
        onAdmin={() => setShowAdmin(true)}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="main">
        <header className="main-header">
          <button className="icon-btn menu-btn" onClick={() => setSidebarOpen(true)} aria-label="菜单">
            ☰
          </button>
          <div className="header-title">
            <h1>{activeSession?.title || '新问诊'}</h1>
            {intakeNote && (
              <button className="pin-chip" onClick={removeIntake} title="移除问诊摘要">
                📋 已附问诊摘要 ✕
              </button>
            )}
          </div>
          <button className="icon-btn" onClick={() => setShowIntake(true)} title="十问 / 舌象 快速问诊单" aria-label="问诊单">
            🩺
          </button>
        </header>

        <div className="chat-scroll">
          {messages.length === 0 && !streaming ? (
            <EmptyState onIntake={() => setShowIntake(true)} onNew={newSession} />
          ) : (
            <div className="msg-list">
              {messages.map((m) => (
                <div key={m.id} className={`msg ${m.role}`}>
                  <div className="msg-avatar">{m.role === 'user' ? '你' : '倪'}</div>
                  <div className="msg-body">
                    {m.role === 'assistant' ? <MarkdownMessage content={m.content} /> : <div className="msg-plain">{m.content}</div>}
                    {m.role === 'assistant' && m.content && (
                      <p className="msg-tag">⚠️ 以上内容由 AI 生成，仅供中医学习参考，不构成医疗建议</p>
                    )}
                  </div>
                </div>
              ))}
              {streaming && (
                <div className="msg assistant">
                  <div className="msg-avatar">倪</div>
                  <div className="msg-body typing-dots"><span /><span /><span /></div>
                </div>
              )}
            </div>
          )}
          <div ref={scrollRef} />
        </div>

        <div className="composer-wrap">
          <div className="composer">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              placeholder={activeId ? '描述你的症状，或按倪师的思路问诊…' : '点击上方 🩺 填写问诊单，或直接描述症状…'}
              rows={1}
            />
            <div className="composer-actions">
              <div className="composer-notes">
                <button className="text-btn" onClick={() => setShowIntake(true)}>📋 十问 / 舌象</button>
              </div>
              {streaming ? (
                <button className="stop-btn" onClick={stop} title="停止生成">⏹</button>
              ) : (
                <button className="send-btn" onClick={send} disabled={!input.trim()} title="发送">➤</button>
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
            <div className="sheet-head"><h2>体质档案</h2><button className="icon-btn" onClick={() => setShowProfile(false)}>✕</button></div>
            <ProfileForm onClose={() => setShowProfile(false)} />
          </div>
        </div>
      )}

      {showIntake && (
        <div className="overlay" onClick={() => setShowIntake(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head"><h2>问诊单 · 十问 / 舌象</h2><button className="icon-btn" onClick={() => setShowIntake(false)}>✕</button></div>
            <IntakeSheet onApply={applyIntake} onClose={() => setShowIntake(false)} />
          </div>
        </div>
      )}

      {showAdmin && (
        <div className="overlay" onClick={() => setShowAdmin(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head"><h2>模型设置（管理员）</h2><button className="icon-btn" onClick={() => setShowAdmin(false)}>✕</button></div>
            <AdminSettings onClose={() => setShowAdmin(false)} />
          </div>
        </div>
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
        <button className="btn-primary" onClick={onIntake}>🩺 填写问诊单</button>
        <button className="btn-ghost" onClick={onNew}>＋ 新问诊</button>
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
