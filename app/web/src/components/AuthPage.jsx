import { useState } from 'react';
import { useAuth } from '../lib/store.jsx';

export default function AuthPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setErr('');
    if (mode === 'register') {
      if (password.length < 6) return setErr('密码至少 6 位');
      if (password !== confirm) return setErr('两次输入的密码不一致');
    }
    setBusy(true);
    try {
      if (mode === 'login') await login(username.trim(), password);
      else await register(username.trim(), password);
    } catch (e2) {
      setErr(e2.message || '操作失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-hero" aria-hidden>
        <div className="auth-hero-inner">
          <div className="auth-seal">医</div>
          <h1>倪海厦中医问诊</h1>
          <p className="auth-quote">「中医很简单，就是阴阳气血。你搞懂了，一通百通。」</p>
          <p className="auth-sub">经方派问诊 · 六经辨证 · 深入浅出</p>
        </div>
      </div>

      <div className="auth-panel">
        <form className="auth-card" onSubmit={onSubmit}>
          <div className="auth-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setErr(''); }}>登录</button>
            <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setErr(''); }}>注册</button>
          </div>

          <label className="field">
            <span>用户名</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="2-24 位，中英文、数字、下划线" autoComplete="username" required />
          </label>
          <label className="field">
            <span>密码</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 6 位" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required />
          </label>
          {mode === 'register' && (
            <label className="field">
              <span>确认密码</span>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
            </label>
          )}

          {err && <p className="auth-error" role="alert">{err}</p>}

          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? '请稍候…' : mode === 'login' ? '登 录' : '注 册'}
          </button>

          <p className="auth-foot">
            问诊记录会自动保存在你的账户下。<br />登录即代表你理解：本应用内容为中医学习研究之用，不构成医疗诊断。
          </p>
        </form>
      </div>
    </div>
  );
}
