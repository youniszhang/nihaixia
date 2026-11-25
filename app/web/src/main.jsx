import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { AuthProvider } from './lib/store.jsx';
import './styles.css';
import './themes/ink.css';

// 皮肤：服务端 settings.theme 经 /api/auth/config 下发（公开端点，登录前也要能切肤）。
// 先按 localStorage 快照即时应用（避免闪烁），随后 config 拉到权威值再校正。
try {
  const cached = localStorage.getItem('xuanshu_theme') || 'warm';
  document.documentElement.setAttribute('data-theme', cached);
} catch { /* private mode */ }
fetch('/api/auth/config')
  .then((r) => r.ok ? r.json() : null)
  .then((d) => {
    if (d && d.theme) {
      document.documentElement.setAttribute('data-theme', d.theme);
      try { localStorage.setItem('xuanshu_theme', d.theme); } catch {}
    }
  })
  .catch(() => {});

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
);
