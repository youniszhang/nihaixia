import { useEffect, useRef, useState } from 'react';
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

// 折线图配色（沿用主题色系：红/玉/琥珀/金 + 补充色）
const LINE_COLORS = ['#b03a2e', '#2d8a4e', '#b8860b', '#5b7fb4', '#8a5bb4', '#c9a84c', '#4aaaa0', '#b46a5b'];

// 容器宽度自适应（SVG 按真实像素绘制，文字才不会被拉伸）
function useElementWidth(ref) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setW(el.clientWidth);
    const ro = new ResizeObserver((entries) => setW(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

// 按用户每日调用量折线图（多序列，SVG 手绘，无第三方图表库）。
// 数据来自 /api/admin/reports 的 users_daily：{ days: ['YYYY-MM-DD'], series: [{ username, calls: [...] }] }
function UserLineChart({ data }) {
  const boxRef = useRef(null);
  const w = useElementWidth(boxRef);
  const H = 230;
  const PAD = { l: 46, r: 14, t: 12, b: 30 };
  const days = data?.days || [];
  const series = data?.series || [];
  const innerW = Math.max(w - PAD.l - PAD.r, 10);
  const innerH = H - PAD.t - PAD.b;

  if (!series.length) {
    return <div className="line-chart" ref={boxRef}><p className="td-empty">暂无数据</p></div>;
  }

  const rawMax = Math.max(1, ...series.flatMap((s) => s.calls));
  // Y 轴取整到好看的刻度（4 段）
  const step = Math.max(1, Math.ceil(rawMax / 4));
  const max = step * 4;
  const x = (i) => PAD.l + (days.length <= 1 ? innerW / 2 : (i * innerW) / (days.length - 1));
  const y = (v) => PAD.t + innerH - (v / max) * innerH;
  const labelEvery = Math.max(1, Math.ceil(days.length / 8));

  return (
    <div className="line-chart" ref={boxRef}>
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label="按用户每日调用量">
          {/* 横向网格 + Y 轴刻度 */}
          {Array.from({ length: 5 }, (_, k) => {
            const v = step * k;
            const yy = y(v);
            return (
              <g key={k}>
                <line x1={PAD.l} x2={PAD.l + innerW} y1={yy} y2={yy} className="line-grid" />
                <text x={PAD.l - 8} y={yy + 4} textAnchor="end" className="line-tick">{v}</text>
              </g>
            );
          })}
          {/* X 轴日期（过密时隔几个标一个） */}
          {days.map((d, i) => (
            (i % labelEvery === 0 || i === days.length - 1) && (
              <text key={d} x={x(i)} y={H - 10} textAnchor="middle" className="line-tick">{d.slice(5)}</text>
            )
          ))}
          {/* 每个用户的折线 + 数据点 */}
          {series.map((s, si) => {
            const color = LINE_COLORS[si % LINE_COLORS.length];
            const pts = s.calls.map((v, i) => `${x(i)},${y(v)}`).join(' ');
            return (
              <g key={s.user_id}>
                <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                {s.calls.map((v, i) => (
                  <circle key={i} cx={x(i)} cy={y(v)} r="3" fill={color} className="line-dot">
                    <title>{`${days[i]} · ${s.username}\n调用 ${v} 次 · 输入 ${fmtChars(s.prompt_chars[i])} · 输出 ${fmtChars(s.completion_chars[i])}`}</title>
                  </circle>
                ))}
              </g>
            );
          })}
        </svg>
      )}
      <div className="line-legend">
        {series.map((s, si) => (
          <span className="line-chip" key={s.user_id}>
            <i style={{ background: LINE_COLORS[si % LINE_COLORS.length] }} />
            {s.username}
          </span>
        ))}
      </div>
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

  const { summary, daily, by_user: byUser, by_provider: byProvider, users_daily: usersDaily } = data;

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
        <h3>按用户 · 每日调用量（区间内调用最多的前 8 位）</h3>
        <UserLineChart data={usersDaily} />
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
