import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

function fmtChars(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

// 纯 CSS 柱状图：按天展示调用量（无图表依赖）
function BarChart({ data, metric = 'calls' }) {
  const max = Math.max(1, ...data.map((d) => d[metric] || 0));
  return (
    <div className="bar-chart">
      {data.map((d) => (
        <div className="bar-col" key={d.day} title={`${d.day}\n调用 ${d.calls} 次 · ${d.users} 人`}>
          <div className="bar-fill" style={{ height: `${Math.max((d[metric] || 0) / max * 100, 2)}%` }} />
          <span className="bar-x">{d.day.slice(5)}</span>
        </div>
      ))}
      {data.length === 0 && <p className="td-empty">暂无数据</p>}
    </div>
  );
}

export default function AdminReports() {
  const [days, setDays] = useState(14);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setErr('');
    api.adminReports(days).then(setData).catch((e) => setErr(e.message));
  }, [days]);

  if (err) return <p className="auth-error">{err}</p>;
  if (!data) return <p className="admin-loading">加载中…</p>;

  const { summary, daily, by_user: byUser, by_provider: byProvider } = data;

  return (
    <div className="admin-reports">
      <div className="admin-toolbar">
        <span className="admin-count">统计区间</span>
        <div className="range-btns">
          {[7, 14, 30, 90].map((d) => (
            <button key={d} className={`range-btn ${days === d ? 'active' : ''}`} onClick={() => setDays(d)}>
              近 {d} 天
            </button>
          ))}
        </div>
      </div>

      <div className="stat-cards">
        <div className="stat-card">
          <span className="stat-label">总调用次数</span>
          <strong className="stat-value">{summary.calls}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">累计活跃用户</span>
          <strong className="stat-value">{summary.active_users}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">输入字符</span>
          <strong className="stat-value">{fmtChars(summary.prompt_chars)}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">输出字符</span>
          <strong className="stat-value">{fmtChars(summary.completion_chars)}</strong>
        </div>
      </div>

      <section className="admin-section">
        <h3>每日调用量</h3>
        <BarChart data={daily} />
      </section>

      <section className="admin-section">
        <h3>按用户</h3>
        <table className="admin-table">
          <thead>
            <tr>
              <th>用户</th>
              <th>状态</th>
              <th>调用数</th>
              <th>问诊数</th>
              <th>输入字符</th>
              <th>输出字符</th>
              <th>最近调用</th>
            </tr>
          </thead>
          <tbody>
            {byUser.map((u) => (
              <tr key={u.id}>
                <td><strong>{u.username}</strong></td>
                <td>{u.status === 'disabled' ? <span className="badge badge-off">已禁用</span> : <span className="badge badge-on">正常</span>}</td>
                <td>{u.calls}</td>
                <td>{u.session_count}</td>
                <td>{fmtChars(u.prompt_chars)}</td>
                <td>{fmtChars(u.completion_chars)}</td>
                <td className="td-dim">{u.last_call_at ? u.last_call_at.replace('T', ' ').slice(0, 16) : '—'}</td>
              </tr>
            ))}
            {byUser.length === 0 && <tr><td colSpan={7} className="td-empty">暂无数据</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="admin-section">
        <h3>按通道</h3>
        <table className="admin-table">
          <thead>
            <tr><th>通道</th><th>调用数</th><th>输入字符</th><th>输出字符</th></tr>
          </thead>
          <tbody>
            {byProvider.map((p) => (
              <tr key={p.provider}>
                <td>{p.provider === 'dsweb' ? '网页版 DeepSeek（0 Token）' : 'API Key 模式'}</td>
                <td>{p.calls}</td>
                <td>{fmtChars(p.prompt_chars)}</td>
                <td>{fmtChars(p.completion_chars)}</td>
              </tr>
            ))}
            {byProvider.length === 0 && <tr><td colSpan={4} className="td-empty">暂无数据</td></tr>}
          </tbody>
        </table>
      </section>

      <p className="admin-hint">
        说明：Token 未直接暴露给服务端统一记账（API 与网页版混用），因此以「调用次数 + 字符量」作为用量指标；
        90 天前的历史数据不在区间内。
      </p>
    </div>
  );
}
