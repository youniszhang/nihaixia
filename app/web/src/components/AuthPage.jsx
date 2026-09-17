import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/store.jsx';

export default function AuthPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // 注册开关：服务端公开配置决定（bootstrap = 空库首次部署，必须允许建管理员）
  // 默认关闭：配置还没到达或读取失败时不露出注册入口，宁可不显示也不要误开
  const [regOpen, setRegOpen] = useState(false);
  const [bootstrap, setBootstrap] = useState(false);
  // 邀请制：需邀请码才能注册（由 registration_enabled=false 推导）
  const [inviteRequired, setInviteRequired] = useState(false);

  useEffect(() => {
    api.authConfig()
      .then((c) => {
        setRegOpen(Boolean(c.registration_enabled));
        setBootstrap(Boolean(c.bootstrap));
        setInviteRequired(Boolean(c.invite_required));
        if (c.bootstrap) setMode('register');
      })
      .catch(() => { /* 配置读取失败时保持默认（不显示注册入口） */ });
  }, []);

  // 邀请制下注册入口需保留（否则拿到邀请码的人找不到地方注册）；
  // 仅当既不开放注册、又不需邀请码（不可能的组合）时才把注册页切回登录。
  const canRegister = regOpen || inviteRequired || bootstrap;

  useEffect(() => {
    if (!canRegister && mode === 'register') {
      setMode('login');
      setErr('');
    }
  }, [canRegister, mode]);

  // 什么时候需要填邀请码：注册且未开放自助注册（空库首启除外）
  const needInvite = mode === 'register' && !regOpen && !bootstrap;

  async function onSubmit(e) {
    e.preventDefault();
    setErr('');
    if (mode === 'register') {
      if (password.length < 6) return setErr('密码至少 6 位');
      if (password !== confirm) return setErr('两次输入的密码不一致');
      if (needInvite && !inviteCode.trim()) return setErr('请填写邀请码');
    }
    setBusy(true);
    try {
      if (mode === 'login') await login(username.trim(), password);
      else await register(username.trim(), password, inviteCode.trim());
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
          <h1>中医问诊</h1>
          <p className="auth-quote">「中医很简单，就是阴阳气血。你搞懂了，一通百通。」</p>
          <p className="auth-sub">经方派问诊 · 六经辨证 · 深入浅出</p>
        </div>
      </div>

      <div className="auth-panel">
        <form className="auth-card" onSubmit={onSubmit}>
          {/* 关闭注册后只剩一个页签，用 single 收窄，避免红色下划线被拉满整行 */}
          <div className={`auth-tabs ${canRegister ? '' : 'single'}`} role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setErr(''); }}>登录</button>
            {canRegister && (
              <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setErr(''); }}>注册</button>
            )}
          </div>

          {bootstrap && mode === 'register' && (
            <p className="auth-notice">
              首次部署：请创建管理员账号。管理员身份也可在服务器 <code>.env</code> 中用
              <code> ADMIN_USERNAME </code>指定。
            </p>
          )}
          {needInvite && (
            <p className="auth-notice">
              本站为邀请制：请填写管理员发放的邀请码，每个邀请码仅可使用一次。
            </p>
          )}

          <label className="field">
            <span>用户名</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={mode === 'login' ? '用户名或邮箱' : '2-24 位中英文、数字或下划线，或邮箱'}
              autoComplete="username"
              required
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'login' ? '请输入密码' : '6-72 位'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
            />
          </label>
          {needInvite && (
            <label className="field">
              <span>邀请码</span>
              <input
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                placeholder="请输入管理员发放的邀请码"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </label>
          )}
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
            {regOpen
              ? <>问诊记录会自动保存在你的账户下。<br /></>
              : <>本站为邀请制，账号需管理员发放邀请码。<br /></>}
            登录即代表你理解：本应用内容为中医学习研究之用，不构成医疗诊断。
          </p>
        </form>
      </div>
    </div>
  );
}
