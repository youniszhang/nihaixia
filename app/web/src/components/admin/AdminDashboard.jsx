import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

function fmtChars(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

export default function AdminDashboard({ onGoTab }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.adminOverview().then(setData).catch((e) => setErr(e.message));
  }, []);

  if (err) return <p className="auth-error">{err}</p>;
  if (!data) return <p className="admin-loading">加载中…</p>;

  const { users, sessions, usage } = data;

  return (
    <div className="admin-dash">
      <div className="stat-cards">
        <div className="stat-card">
          <span className="stat-label">用户总数</span>
          <strong className="stat-value">{users.total}</strong>
          <span className="stat-sub">启用 {users.active} · 禁用 {users.disabled}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">问诊会话</span>
          <strong className="stat-value">{sessions.total}</strong>
          <span className="stat-sub">全站累计</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">模型调用</span>
          <strong className="stat-value">{usage.calls}</strong>
          <span className="stat-sub">今日 {usage.today_calls} 次</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">活跃用户</span>
          <strong className="stat-value">{usage.active_users}</strong>
          <span className="stat-sub">今日 {usage.today_users} 人</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">输入字符</span>
          <strong className="stat-value">{fmtChars(usage.prompt_chars)}</strong>
          <span className="stat-sub">含系统提示与知识库</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">输出字符</span>
          <strong className="stat-value">{fmtChars(usage.completion_chars)}</strong>
          <span className="stat-sub">模型生成总量</span>
        </div>
      </div>

      <div className="admin-quick">
        <div className="quick-row">
          <span>当前通道</span>
          <strong>{data.provider === 'dsweb' ? '网页版 DeepSeek（0 Token）' : 'API Key 模式'}</strong>
        </div>
        <div className="quick-row">
          <span>当前模型</span>
          <strong>{data.model || (data.provider === 'dsweb' ? 'deepseek-web' : '未配置')}</strong>
        </div>
      </div>

      <div className="admin-quick-actions">
        <button className="btn-ghost" onClick={() => onGoTab('users')}>👥 用户管理</button>
        <button className="btn-ghost" onClick={() => onGoTab('conversations')}>💬 查看对话记录</button>
        <button className="btn-ghost" onClick={() => onGoTab('reports')}>📈 使用报表</button>
        <button className="btn-ghost" onClick={() => onGoTab('model')}>⚙️ 模型设置</button>
      </div>
    </div>
  );
}
