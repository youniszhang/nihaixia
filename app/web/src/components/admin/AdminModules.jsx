import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import Icon from '../Icon.jsx';

// 管理后台 · 模块管理
// 每个功能模块 = 一位独立角色 + 专属知识库。三个控制面：
//   1) 站点开关（上线/下线，下线后全站暂不可用）
//   2) 开通方式（自助即开 / 申请审批）
//   3) 用户开通（逐个发牌 / 撤销 / 批量开通）
// 另有用户提交的开通申请审批流。

function fmtTime(t) {
  return t ? String(t).replace('T', ' ').slice(0, 16) : '—';
}

export default function AdminModules({ onOpenUserPicker }) {
  const [modules, setModules] = useState([]);
  const [requests, setRequests] = useState([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(null);   // 展开的模块（用户列表）
  const [moduleUsers, setModuleUsers] = useState({});
  const [bulkFor, setBulkFor] = useState(null);     // 批量开通弹窗的模块
  const [bulkIds, setBulkIds] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [defaultModules, setDefaultModules] = useState([]);

  async function load() {
    try {
      const d = await api.adminModules();
      setModules(d.modules || []);
      setRequests(d.requests || []);
      setDefaultModules(d.default_modules || []);
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  function flash(t) { setMsg(t); setTimeout(() => setMsg(''), 3500); }

  async function patch(id, patchBody, okText) {
    setBusy(true); setErr('');
    try {
      const r = await api.adminPatchModule(id, patchBody);
      flash(okText || `已保存：${(r.changes || []).join('；')}`);
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  // 保存新用户默认模块（选项即改即存）
  async function saveDefaultModules(ids) {
    setBusy(true); setErr('');
    try {
      const r = await api.adminDefaultModules(ids);
      setDefaultModules(r.default_modules || []);
      flash(`默认模块已更新：${(r.default_modules || []).map((id) => modules.find((m) => m.id === id)?.name || id).join('、') || '（无）'}`);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function toggleUsers(id) {
    if (expanded === id) { setExpanded(null); return; }
    try {
      const d = await api.adminModuleUsers(id);
      setModuleUsers((m) => ({ ...m, [id]: d.users || [] }));
      setExpanded(id);
    } catch (e) { setErr(e.message); }
  }

  async function revoke(modId, userId) {
    if (!confirm(`确定撤销该用户的模块权限？该用户将立即无法继续使用。`)) return;
    setBusy(true);
    try {
      await api.adminRevokeModule(modId, userId);
      flash('已撤销');
      await toggleUsers(modId); await toggleUsers(modId); // 重新加载
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function review(reqId, decision) {
    setBusy(true); setErr('');
    try {
      await api.adminReviewModuleRequest(reqId, decision);
      flash(decision === 'approve' ? '已批准并开通' : '已驳回');
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function submitBulk() {
    if (!bulkFor) return;
    const ids = bulkIds.split(/[,，\s]+/).map((x) => Number(x.trim())).filter(Number.isInteger);
    if (!ids.length) { setErr('请输入用户 ID（数字，多个用逗号分隔）'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.adminGrantModuleBulk(bulkFor.id, ids);
      flash(`已为 ${r.affected} 个账号开通「${bulkFor.name}」`);
      setBulkFor(null); setBulkIds('');
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  const pendingCount = requests.length;

  return (
    <div className="admin-section">
      <div className="admin-toolbar">
        <p className="admin-hint">
          模块 = 一位独立角色 + 专属知识库 + 计算脚本。站点开关控制模块整体上下线；
          用户开通决定谁能用（默认模块「岐黄问诊」站点开启即全员可用）。
        </p>
        <button className="text-btn" onClick={() => setShowHistory((v) => !v)}>
          历史申请 {showHistory ? '收起' : '展开'}
        </button>
      </div>

      {msg && <p className="admin-msg ok">{msg}</p>}
      {err && <p className="admin-msg err">{err}</p>}

      {/* 待审批申请 */}
      <div className="card">
        <div className="card-head">
          <h3><Icon name="bell" size={16} /> 开通申请</h3>
          <span className={`chip ${pendingCount ? 'chip-warn' : ''}`}>{pendingCount} 条待审</span>
        </div>
        {requests.length === 0 ? (
          <p className="empty-hint">暂无待审批的开通申请。</p>
        ) : (
          <table className="admin-table module-table">
            <thead><tr><th>用户</th><th>模块</th><th>留言</th><th>时间</th><th></th></tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>{r.username}</td>
                  <td>{modules.find((m) => m.id === r.module_id)?.name || r.module_id}</td>
                  <td className="td-note">{r.note || '—'}</td>
                  <td>{fmtTime(r.created_at)}</td>
                  <td className="td-actions">
                    <button className="text-btn btn-sm" disabled={busy} onClick={() => review(r.id, 'approve')}>批准</button>
                    <button className="text-btn btn-sm danger" disabled={busy} onClick={() => review(r.id, 'reject')}>驳回</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 新用户默认模块：注册/建号时自动开通哪些（默认只有中医） */}
      <div className="card">
        <div className="card-head">
          <h3><Icon name="user-plus" size={16} /> 新用户默认模块</h3>
          <span className="chip">{(defaultModules || []).length} 个</span>
        </div>
        <p className="card-sub">
          新建用户（注册或后台建号）自动开通这些模块。默认只开「岐黄问诊」；改动只影响之后新建的账号，
          已存在的账号请在下方逐个/批量开通。
        </p>
        <div className="module-picker">
          {modules.map((m) => {
            const on = (defaultModules || []).includes(m.id);
            return (
              <label key={m.id} className={`module-pick ${on ? 'on' : ''}`} style={{ '--mc': m.color }}>
                <input type="checkbox" checked={on} disabled={busy}
                  onChange={(e) => saveDefaultModules(
                    e.target.checked ? [...(defaultModules || []), m.id] : (defaultModules || []).filter((x) => x !== m.id),
                  )} />
                <Icon name={m.icon} size={13} /> {m.name}
              </label>
            );
          })}
        </div>
      </div>

      {/* 模块列表 */}
      {modules.map((m) => (
        <div className="card" key={m.id}>
          <div className="card-head">
            <h3>
              <span className="module-dot" style={{ background: m.color }}><Icon name={m.icon} size={15} /></span>
              {m.name}
              {m.has_tool && <span className="chip" title="该模块配有计算脚本（排盘/抽牌由脚本完成）"><Icon name="zap" size={12} /> {m.tool_name}</span>}
              {m.id === 'tcm' && <span className="chip">默认模块</span>}
            </h3>
            <div className="module-head-toggle">
              <button
                className={`switch ${m.site_enabled ? 'on' : ''}`}
                disabled={busy}
                title={m.site_enabled ? '点击下线' : '点击上线'}
                onClick={() => patch(m.id, { site_enabled: !m.site_enabled }, !m.site_enabled ? `「${m.name}」已上线` : `「${m.name}」已下线`)}
              >
                <span className="switch-knob" />
              </button>
              <span className="switch-label">{m.site_enabled ? '已上线' : '已下线'}</span>
            </div>
          </div>

          <p className="card-sub">{m.tagline}</p>

          <div className="module-meta">
            <span className="chip">已开通 {m.granted_count} 人</span>
            {m.site_enabled && m.id !== 'tcm' && (
              <label className="inline-select">
                开通方式：
                <select value={m.open_mode} disabled={busy}
                  onChange={(e) => patch(m.id, { open_mode: e.target.value }, e.target.value === 'auto' ? '自助即开' : '申请审批')}>
                  <option value="apply">申请审批</option>
                  <option value="auto">自助即开</option>
                </select>
              </label>
            )}
            {m.site_enabled && (
              <>
                <button className="text-btn btn-sm" onClick={() => toggleUsers(m.id)}>
                  {expanded === m.id ? '收起名单' : '查看名单'}
                </button>
                <button className="text-btn btn-sm" onClick={() => { setBulkFor(m); setBulkIds(''); }}>批量开通</button>
              </>
            )}
          </div>

          {expanded === m.id && (
            <div className="module-users">
              {(moduleUsers[m.id] || []).length === 0 ? (
                <p className="empty-hint">还没有用户开通此模块。</p>
              ) : (
                <table className="admin-table module-table">
                  <thead><tr><th>用户 ID</th><th>用户名</th><th>来源</th><th>到期</th><th>开通时间</th><th>操作人</th><th></th></tr></thead>
                  <tbody>
                    {(moduleUsers[m.id] || []).map((u) => (
                      <tr key={u.id}>
                        <td>#{u.id}</td>
                        <td>{u.username}</td>
                        <td>
                          <span className={`chip ${u.source === 'plan' ? 'chip-warn' : ''}`}>
                            {u.source === 'plan' ? '订阅' : u.source === 'default' ? '默认' : '手动'}
                          </span>
                        </td>
                        <td className="td-dim">{u.expires_at ? String(u.expires_at).slice(0, 10) : '永久'}</td>
                        <td>{fmtTime(u.granted_at)}</td>
                        <td>{u.granted_by || '—'}</td>
                        <td className="td-actions">
                          <button className="text-btn btn-sm danger" disabled={busy} onClick={() => revoke(m.id, u.id)}>撤销</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      ))}

      {/* 历史申请（已处理） */}
      {showHistory && <AdminRequestHistory />}

      {/* 批量开通弹窗 */}
      {bulkFor && (
        <div className="overlay" onClick={() => setBulkFor(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <h2>批量开通 · {bulkFor.name}</h2>
              <button className="icon-btn" onClick={() => setBulkFor(null)} aria-label="关闭"><Icon name="close" size={18} /></button>
            </div>
            <div className="intake-form">
              <label className="field">
                <span>用户 ID 列表 <small>（在「用户管理」查看；多个用逗号或空格分隔）</small></span>
                <textarea rows={3} value={bulkIds} onChange={(e) => setBulkIds(e.target.value)} placeholder="如：2, 5, 12" />
              </label>
              <div className="sheet-actions">
                <button className="btn-ghost" onClick={() => setBulkFor(null)}>取消</button>
                <button className="btn-primary" disabled={busy} onClick={submitBulk}>确认开通</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AdminRequestHistory() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    // 历史走审计日志：按 action 前缀过滤
    api.adminAudit(200).then((d) => {
      setItems((d.logs || []).filter((l) => l.action?.startsWith('module.')));
    }).catch(() => {});
  }, []);
  if (!items.length) return <p className="empty-hint">暂无模块操作记录。</p>;
  return (
    <div className="card">
      <div className="card-head"><h3><Icon name="clock" size={16} /> 模块操作记录</h3></div>
      <table className="admin-table module-table">
        <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th></tr></thead>
        <tbody>
          {items.map((l) => (
            <tr key={l.id}>
              <td>{fmtTime(l.created_at)}</td>
              <td>{l.actor_username || '—'}</td>
              <td>{l.action}</td>
              <td>{l.target}</td>
              <td className="td-note">{l.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
