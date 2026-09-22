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
import { compressImage, IMAGE_LIMITS } from '../lib/imageCompress.js';
import { newImageId, putImage, getImageMap, extractImageIds } from '../lib/imageStore.js';

const DISCLAIMER_SEEN_KEY = 'xuanshu_disclaimer_accepted_v1';

export default function ChatPage({ module, onBackToPortal }) {
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
  const [intakeNote, setIntakeNote] = useState(''); // pinned summary (问诊单/咨询背景) for active session
  const [sessionTitle, setSessionTitle] = useState('');
  const [errNote, setErrNote] = useState(''); // 最近一次生成失败的原因（常驻到下次发送）
  const [quota, setQuota] = useState(null);   // 剩余额度 / 今日用量
  const [checkedInToday, setCheckedInToday] = useState(false);
  // 待发送的图片：[{ id, uri, preview, size, width, height }]
  //   uri    = 给服务端的 data URI（仅当轮投喂，服务端不留存）
  //   preview= 本机预览用的 objectURL
  const [pendingImages, setPendingImages] = useState([]);
  const [imgBusy, setImgBusy] = useState(false);
  const [imgErr, setImgErr] = useState('');
  // 已发消息里的图片：{ [imgId]: objectURL }，从 IndexedDB 取；取不到就只渲染标识
  const [localImages, setLocalImages] = useState({});
  const fileRef = useRef(null);
  // 历史加载：默认只取最近一页；向上滚动再按需加载更早的（长会话全量渲染会明显卡顿）
  const PAGE_SIZE = 40;
  const RENDER_WINDOW = 60; // 同时渲染的消息上限（更早的折叠为「显示更早」）
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [renderAll, setRenderAll] = useState(false);
  const oldestIdRef = useRef(null);

  const mod = module;

  function acceptDisclaimer() {
    try { localStorage.setItem(DISCLAIMER_SEEN_KEY, '1'); } catch { /* private mode */ }
    setShowDisclaimer(false);
  }

  const scrollRef = useRef(null);
  const abortRef = useRef(null);
  const scrollHostRef = useRef(null);
  const inputRef = useRef(null);
  const inputPastedRef = useRef(false);

  // 输入框自适应高度（对齐 DeepSeek 官网手感）：
  //   - 随内容长高，超过上限（200px）后转为内部滚动；
  //   - 粘贴大段文字时视图锚到末尾（光标处），避免内容在 1 行小框里乱跳、首行被截一半。
  const resizeInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const MAX = 200;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX)}px`;
    const overflow = el.scrollHeight > MAX + 1;
    el.style.overflowY = overflow ? 'auto' : 'hidden';
    if (overflow && inputPastedRef.current) {
      el.scrollTop = el.scrollHeight; // 粘贴后光标在末尾，让用户看到刚贴进去的部分
      inputPastedRef.current = false;
    }
  }, []);
  useEffect(() => { resizeInput(); }, [input, resizeInput]);

  // 移动端键盘抬升（iOS 专用兜底，Android 走 viewport 的 interactive-widget=resizes-content）：
  // iOS PWA/Safari 弹键盘时布局视口不变、可视视口缩小，固定在底部的输入框会被键盘盖住。
  // 这里把「键盘高度」算出来写进 CSS 变量，输入框所在容器用它抬高自己。
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const apply = () => {
      const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb-inset', `${Math.round(overlap)}px`);
    };
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    apply();
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      document.documentElement.style.setProperty('--kb-inset', '0px');
    };
  }, []);
  const listRef = useRef(sessions);
  listRef.current = sessions;
  // 会话消息缓存：点历史先出内容再静默刷新，避免闪空状态（"看起来像弹回新问诊"）
  const messageCacheRef = useRef(new Map());
  const activeIdRef = useRef(null);
  activeIdRef.current = activeId;

  const refreshSessions = useCallback(async () => {
    try {
      // 只列当前模块的会话（module 过滤在前端做；服务端会话已带 module 字段）
      const { sessions: s } = await api.listSessions();
      setSessions(s.filter((x) => (x.module || 'tcm') === mod.id));
    } catch { /* ignore */ }
  }, [mod.id]);

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
    const { session } = await api.createSession(mod.name, mod.id);
    await refreshSessions();
    setActiveId(session.id);
    setMessages([]);
    setIntakeNote('');
    setSessionTitle(session.title || mod.name);
    setSidebarOpen(false);
  }

  async function deleteSession(id) {
    if (!confirm('确定删除该记录？此操作不可恢复。')) return;
    await api.deleteSession(id).catch(() => {});
    await refreshSessions();
    if (id === activeId) { setActiveId(null); setMessages([]); setIntakeNote(''); }
  }

  // ---- intake pin (问诊单/咨询背景) ----
  function applyIntake(summary) {
    setIntakeNote(summary);
    setShowIntake(false);
  }
  function removeIntake() { setIntakeNote(''); }

  // 点建议词：把问题填进输入框并聚焦，让用户能直接改词后回车发送
  // （旧实现只调 newSession()，界面上看不出任何变化，等于点了没反应）
  function pickSuggestion(text) {
    setInput(text);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // ---- 图片：选择 / 粘贴 / 压缩 ----
  // 服务端不存图，这里是唯一副本（存 IndexedDB），UI 必须让用户知道这点。
  const addFiles = useCallback(async (files) => {
    const list = Array.from(files || []).filter((f) => /^image\//.test(f.type || ''));
    if (!list.length) return;
    setImgErr('');
    setImgBusy(true);
    try {
      const room = IMAGE_LIMITS.MAX_COUNT - pendingImages.length;
      if (room <= 0) { setImgErr(`单轮最多 ${IMAGE_LIMITS.MAX_COUNT} 张图片`); return; }
      const picked = list.slice(0, room);
      if (list.length > room) setImgErr(`单轮最多 ${IMAGE_LIMITS.MAX_COUNT} 张，已取前 ${room} 张`);
      const added = [];
      for (const f of picked) {
        try {
          const { blob, uri, mime, width, height } = await compressImage(f);
          const id = newImageId();
          // 先存本地（失败也不阻断本轮发送：图仍能投喂，只是回看时只剩标识）
          await putImage({ id, blob, uri, mime, width, height });
          added.push({ id, uri, preview: URL.createObjectURL(blob), size: blob.size, width, height });
        } catch (e) {
          setImgErr(e.message || '图片处理失败');
        }
      }
      if (added.length) setPendingImages((p) => [...p, ...added]);
    } finally {
      setImgBusy(false);
    }
  }, [pendingImages.length]);

  function removePendingImage(id) {
    setPendingImages((p) => {
      const t = p.find((x) => x.id === id);
      if (t?.preview) URL.revokeObjectURL(t.preview);
      return p.filter((x) => x.id !== id);
    });
  }

  // 消息里出现图片标记时，从本地 IndexedDB 取图（取不到就只剩标识，说明是换设备/清缓存了）
  useEffect(() => {
    const ids = new Set();
    for (const m of messages) {
      for (const id of extractImageIds(m.content)) {
        if (!localImages[id]) ids.add(id);
      }
    }
    if (!ids.size) return;
    let cancelled = false;
    getImageMap([...ids]).then((map) => {
      if (cancelled || !Object.keys(map).length) return;
      setLocalImages((prev) => ({ ...prev, ...map }));
    });
    return () => { cancelled = true; };
  }, [messages, localImages]);

  // ---- send ----
  async function send() {
    const content = input.trim();
    const imgs = pendingImages;
    if ((!content && !imgs.length) || streaming) return;
    let sid = activeId;
    if (!sid) {
      const { session } = await api.createSession(mod.name, mod.id);
      sid = session.id;
      setActiveId(sid);
    }

    // Optimistic local message
    // 乐观气泡带上图片标记，这样 UserMessage 能立刻用本机 preview 渲染出原图；
    // 生成结束回填服务端消息后，标记内容一致，图片无缝接续。
    const marker = imgs.map((i) => `[图片:${i.id}]`).join('');
    const userMsg = {
      id: `tmp-${Date.now()}`,
      role: 'user',
      content: marker ? (content ? `${content}\n${marker}` : marker) : content,
    };
    setMessages((m) => [...m, userMsg]);
    // 把 preview 登记进 localImages，供 UserMessage 按 id 取用（不 revoke，正在显示）
    setLocalImages((prev) => {
      const next = { ...prev };
      for (const i of imgs) next[i.id] = i.preview;
      return next;
    });
    setPendingImages([]);
    setInput('');
    setStreaming(true);
    setErrNote('');

    const asstMsg = { id: `tmp-${Date.now()}-a`, role: 'assistant', content: '' };
    setMessages((m) => [...m, asstMsg]);

    const controller = new AbortController();
    abortRef.current = controller;
    let acc = '';
    try {
      for await (const ev of api.streamChat(sid, content, controller.signal, intakeNote, imgs.map((i) => ({ id: i.id, uri: i.uri })))) {
        if (ev.type === 'delta') {
          acc += ev.text;
          setMessages((m) => m.map((x) => (x.id === asstMsg.id ? { ...x, content: acc } : x)));
        } else if (ev.type === 'done') {
          setMessages((m) => m.map((x) => (x.id === asstMsg.id ? { ...x, id: ev.message_id, content: acc } : x)));
          // 服务端在 done 事件里带回最新额度，免去再发一次请求
          if (ev.quota) setQuota(ev.quota);
          break;
        } else if (ev.type === 'queue') {
          // 容量保护排队：显示实时排位与预计等待（不扣额度，等到了就自动开始生成）
          setMessages((m) => m.map((x) => (x.id === asstMsg.id ? { ...x, content: acc || `⏳ 当前使用人数较多，排队中 第 ${ev.position} 位 · 预计约 ${ev.est_wait_s} 秒` } : x)));
        } else if (ev.type === 'tool') {
          // 脚本运行提示（排盘/抽牌）：显示在占位气泡里
          setMessages((m) => m.map((x) => (x.id === asstMsg.id ? { ...x, content: acc || `> ⚙️ ${ev.label}运行中…` } : x)));
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
  const isTcm = mod.id === 'tcm';
  const intakeLabel = isTcm ? '十问 / 舌象' : '咨询背景';

  return (
    <div className={`app-shell ${sidebarOpen ? 'sidebar-visible' : ''}`}>
      <Sidebar
        module={mod}
        onBackToPortal={onBackToPortal}
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
          {/* 常驻返回入口：PWA 独立窗口没有浏览器返回键，窄屏侧栏又是抽屉式，
              这里给一个所有尺寸都看得见的「回到模块门户」按钮 */}
          <button className="icon-btn back-btn" onClick={onBackToPortal} title="返回模块门户" aria-label="返回模块门户">
            <Icon name="arrow-left" size={20} />
          </button>
          <button className="icon-btn menu-btn" onClick={() => setSidebarOpen(true)} aria-label="菜单">
            <Icon name="menu" size={20} />
          </button>
          <div className="header-title">
            <h1>
              <span className="module-chip" style={{ background: mod.color }}><Icon name={mod.icon} size={13} /> {mod.name}</span>
              {activeSession?.title || mod.name}
            </h1>
            {intakeNote && (
              <button className="pin-chip" onClick={removeIntake} title={`移除${intakeLabel}摘要`}>
                <Icon name="clipboard" size={13} /> 已附{intakeLabel}摘要 <Icon name="close" size={12} />
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
          {isTcm && (
            <button className="icon-btn" onClick={() => setShowIntake(true)} title="十问 / 舌象 快速问诊单" aria-label="问诊单">
              <Icon name="stethoscope" size={20} />
            </button>
          )}
        </header>

        <div className="chat-scroll" ref={scrollHostRef}>
          {loadingSession && messages.length === 0 ? (
            <div className="chat-loading">
              <div className="loading-spinner" />
              <p>正在加载记录…</p>
            </div>
          ) : messages.length === 0 && !streaming ? (
            <EmptyState mod={mod} onIntake={isTcm ? () => setShowIntake(true) : null} onNew={newSession} onPick={pickSuggestion} />
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
                        <div className="msg-avatar" style={isTcm ? undefined : { background: mod.color }}>{mod.name.slice(0, 1)}</div>
                        <div className="msg-body typing-dots"><span /><span /><span /></div>
                      </div>
                    );
                  }
                  return null; // 非流式状态下的空泡不渲染
                }
                return (
                  <div key={m.id} className={`msg ${m.role}`}>
                    <div className="msg-avatar" style={isTcm || m.role === 'user' ? undefined : { background: mod.color }}>
                      {m.role === 'user' ? '你' : mod.name.slice(0, 1)}
                    </div>
                    <div className="msg-body">
                      {m.role === 'assistant' ? <MarkdownMessage content={m.content} /> : <UserMessage content={m.content} localImages={localImages} />}
                      {m.role === 'assistant' && m.content && (
                        <p className="msg-tag">
                          <Icon name="alert" size={13} /> {mod.disclaimer}
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
            {pendingImages.length > 0 && (
              <div className="composer-imgs">
                {pendingImages.map((im) => (
                  <div key={im.id} className="composer-img">
                    <img src={im.preview} alt="待发送图片" />
                    <button
                      type="button"
                      className="composer-img-remove"
                      onClick={() => removePendingImage(im.id)}
                      title="移除这张图片"
                      aria-label="移除图片"
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                ))}
                {imgBusy && <span className="composer-img-loading">处理中…</span>}
              </div>
            )}
            {(imgErr || pendingImages.length > 0) && (
              <p className={imgErr ? 'composer-img-note err' : 'composer-img-note'}>
                <Icon name="info" size={12} />{' '}
                {imgErr || '图片只在本机浏览器保存，服务器不存储：换设备或清除浏览器数据后，历史记录里将看不到这张图。'}
              </p>
            )}
            <textarea
              ref={inputRef}
              onPaste={(e) => {
                // 粘贴图片（截图、复制的图）直接进待发队列；纯文本仍走原来的高度重算
                const items = e.clipboardData?.items || [];
                const files = [];
                for (const it of items) {
                  if (it.kind === 'file' && /^image\//.test(it.type || '')) {
                    const f = it.getAsFile();
                    if (f) files.push(f);
                  }
                }
                if (files.length) {
                  e.preventDefault();
                  addFiles(files);
                  return;
                }
                inputPastedRef.current = true;
                requestAnimationFrame(resizeInput);
              }}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              placeholder={activeId ? mod.placeholder || `向「${mod.name}」提问…` : mod.emptyHint || `开始你的「${mod.name}」对话…`}
              rows={1}
            />
            <div className="composer-actions">
              <div className="composer-notes">
                <button
                  className="text-btn"
                  onClick={() => fileRef.current?.click()}
                  disabled={imgBusy || pendingImages.length >= IMAGE_LIMITS.MAX_COUNT}
                  title={`添加图片（最多 ${IMAGE_LIMITS.MAX_COUNT} 张）`}
                >
                  <Icon name="image" size={14} /> 图片
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  multiple
                  hidden
                  onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
                />
                {isTcm && (
                  <button className="text-btn" onClick={() => setShowIntake(true)}>
                    <Icon name="clipboard" size={14} /> 十问 / 舌象
                  </button>
                )}
              </div>
              {streaming ? (
                <button className="stop-btn" onClick={stop} title="停止生成" aria-label="停止生成">
                  <Icon name="stop" size={16} />
                </button>
              ) : (
                <button
                  className="send-btn"
                  onClick={send}
                  disabled={(!input.trim() && !pendingImages.length) || imgBusy}
                  title="发送"
                  aria-label="发送"
                >
                  <Icon name="send" size={17} />
                </button>
              )}
            </div>
          </div>
          <p className="disclaimer">
            {mod.disclaimer}<br />
            本服务由 AI 生成，仅供学习与学术研究；请以现实专业人士意见为准。
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

// 用户消息渲染：把「[图片:xxx]」标记换成真实图片。
//
// 关键：服务端不存图，图片来自本机 IndexedDB。取不到时**不能静默变成空白**——
// 要明确告诉用户「图片只存本机，当前设备上看不到」，否则用户会以为是系统把图删了。
function UserMessage({ content, localImages }) {
  const ids = extractImageIds(content);
  // 去掉标记后的纯文字（标记由图片区单独呈现，避免重复展示原始 id）
  const text = content.replace(/\[图片:[A-Za-z0-9_-]{1,40}\]/g, '').trim();
  if (!ids.length) return <div className="msg-plain">{content}</div>;
  return (
    <div className="msg-plain">
      <div className="msg-imgs">
        {ids.map((id) => (localImages[id]
          ? <img key={id} src={localImages[id]} alt="上传的图片" className="msg-img" />
          : (
            <span key={id} className="msg-img-missing" title="图片只保存在本机浏览器；换设备或清除浏览器数据后无法查看">
              <Icon name="alert" size={13} /> 图片未在本机保存
            </span>
          )))}
      </div>
      {text && <span className="msg-imgs-text">{text}</span>}
    </div>
  );
}

function EmptyState({ mod, onIntake, onNew, onPick }) {
  const isTcm = mod.id === 'tcm';
  return (
    <div className="empty">
      <div className="empty-logo" style={isTcm ? undefined : { background: mod.color }}>{mod.name.slice(0, 1)}</div>
      <h2>{mod.name}</h2>
      <p className="empty-quote">{mod.emptyQuote}</p>
      <div className="empty-actions">
        {isTcm && onIntake && (
          <button className="btn-primary" onClick={onIntake}>
            <Icon name="stethoscope" size={17} /> 填写问诊单
          </button>
        )}
        <button className="btn-ghost" onClick={onNew}>
          <Icon name="plus" size={16} /> 新对话
        </button>
      </div>
      <div className="suggestions">
        {mod.suggestions.map((s) => (
          <button key={s} type="button" onClick={() => onPick?.(s)} title="点击填入输入框">{s}</button>
        ))}
      </div>
    </div>
  );
}
