import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import MarkdownMessage from '../MarkdownMessage.jsx';

function fmtTime(t) {
  return t ? t.replace('T', ' ').slice(0, 16) : '—';
}

const PAGE_SIZE = 50;

export default function AdminConversations({ filter, onClearFilter }) {
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  // 会话详情
  const [detail, setDetail] = useState(null);
  // 关键词全文搜索
  const [searchHits, setSearchHits] = useState(null);

  const userId = filter?.userId || null;

  async function load(nextOffset = 0) {
    setLoading(true); setErr('');
    try {
      const d = await api.adminConversations({ userId, q: q.trim() || undefined, limit: PAGE_SIZE, offset: nextOffset });
      setList(d.conversations || []);
      setTotal(d.total || 0);
      setOffset(nextOffset);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(0); /* eslint-disable-next-line */ }, [userId]);

  async function openDetail(id) {
    setErr('');
    try {
      setDetail(await api.adminConversation(id));
    } catch (e) { setErr(e.message); }
  }

  async function fullTextSearch(e) {
    e.preventDefault();
    const term = q.trim();
    if (term.length < 2) { setErr('请输入至少 2 个字符'); return; }
    setErr('');
    try {
      const d = await api.adminSearch(term);
      setSearchHits(d.results || []);
    } catch (e2) { setErr(e2.message); }
  }

  return (
    <div className="admin-conv">
      <div className="admin-toolbar">
        <div className="admin-filter">
          {filter && (
            <span className="filter-chip">
              用户：{filter.username}
              <button onClick={onClearFilter} title="清除过滤">✕</button>
            </span>
          )}
          <input
            className="admin-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="按标题搜索会话，或输入关键词全文搜索"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); fullTextSearch(e); } }}
          />
          <button className="btn-ghost" onClick={() => load(0)} disabled={loading}>筛选</button>
          <button className="btn-ghost" onClick={fullTextSearch} disabled={loading}>全文搜索</button>
          {searchHits && (
            <button className="btn-ghost" onClick={() => setSearchHits(null)}>退出搜索结果</button>
          )}
        </div>
        <span className="admin-count">{total} 个会话</span>
      </div>

      {err && <p className="auth-error">{err}</p>}

      {searchHits ? (
        <div className="admin-hits">
          <p className="admin-hint">在 {searchHits.length} 条消息中找到「{q}」</p>
          {searchHits.map((h) => (
            <button key={h.id} className="hit-item" onClick={() => openDetail(h.session_id)}>
              <span className={`hit-role ${h.role}`}>{h.role === 'user' ? '问' : '答'}</span>
              <span className="hit-text">{h.content.slice(0, 120)}</span>
              <span className="hit-meta">{h.username} · {h.session_title} · {fmtTime(h.created_at)}</span>
            </button>
          ))}
          {searchHits.length === 0 && <p className="td-empty">没有匹配的消息</p>}
        </div>
      ) : (
        <>
          <table className="admin-table">
            <thead>
              <tr>
                <th>标题</th>
                <th>用户</th>
                <th>提问数</th>
                <th>创建时间</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <td className="td-title">{c.title}</td>
                  <td>{c.username}</td>
                  <td>{c.msg_count}</td>
                  <td className="td-dim">{fmtTime(c.created_at)}</td>
                  <td className="td-dim">{fmtTime(c.updated_at)}</td>
                  <td className="td-actions">
                    <button className="link-btn" onClick={() => openDetail(c.id)}>查看</button>
                  </td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={6} className="td-empty">{loading ? '加载中…' : '暂无会话'}</td></tr>}
            </tbody>
          </table>

          {total > PAGE_SIZE && (
            <div className="admin-pager">
              <button className="btn-ghost" disabled={offset === 0} onClick={() => load(Math.max(offset - PAGE_SIZE, 0))}>上一页</button>
              <span>{Math.floor(offset / PAGE_SIZE) + 1} / {Math.ceil(total / PAGE_SIZE)}</span>
              <button className="btn-ghost" disabled={offset + PAGE_SIZE >= total} onClick={() => load(offset + PAGE_SIZE)}>下一页</button>
            </div>
          )}
        </>
      )}

      {detail && (
        <div className="admin-modal-mask" onClick={() => setDetail(null)}>
          <div className="admin-modal admin-modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h3>{detail.session.title}</h3>
                <p className="modal-sub">
                  用户 {detail.session.username} · 创建于 {fmtTime(detail.session.created_at)}
                </p>
              </div>
              <button className="icon-btn" onClick={() => setDetail(null)}>✕</button>
            </div>
            {detail.session.pin && (
              <div className="modal-pin">
                <strong>问诊摘要</strong>
                <p>{detail.session.pin}</p>
              </div>
            )}
            <div className="modal-msgs">
              {detail.messages.map((m) => (
                <div key={m.id} className={`modal-msg ${m.role}`}>
                  <span className="modal-role">{m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : '系统'}</span>
                  <div className="modal-content">
                    {m.role === 'assistant' ? <MarkdownMessage content={m.content} /> : m.content}
                  </div>
                  <span className="modal-time">{fmtTime(m.created_at)}</span>
                </div>
              ))}
              {detail.messages.length === 0 && <p className="td-empty">该会话还没有消息</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
