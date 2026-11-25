import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/store.jsx';
import InkLandscape from './InkLandscape.jsx';

export default function AuthPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [confirmTouched, setConfirmTouched] = useState(false);
  const confirmRef = useRef(null);
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
  const confirmMismatch = confirmTouched && confirm.length > 0 && password !== confirm;

  function switchMode(nextMode) {
    setMode(nextMode);
    setErr('');
    setConfirmTouched(false);
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setErr('');
    if (mode === 'register') {
      if (password.length < 6 || password.length > 72) return setErr('密码长度需 6-72 位');
      if (password !== confirm) {
        setConfirmTouched(true);
        confirmRef.current?.focus();
        return;
      }
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
        <div className="auth-brand"><span className="portal-seal">玄</span><span>玄枢<small>问道 · 修心 · 求真</small></span></div>
        <div className="auth-hero-inner">
          <p className="eyebrow">云山有径 · 问学无涯</p>
          <h2>一卷入玄，<br />问道山河。</h2>
          <p className="auth-quote">以经典为引，与智慧对话。<br />在一问一答间，让传统的学问走近日常。</p>
          <div className="auth-disciplines"><span>岐黄</span><span>命理</span><span>易学</span><span>禅思</span></div>
        </div>
        <InkLandscape />
        <p className="auth-colophon">一卷藏天地 · 八门见真知</p>
      </div>

      <div className="auth-panel">
        <form className="auth-card" onSubmit={onSubmit} aria-busy={busy}>
          <div className="auth-intro">
            <span className="eyebrow">欢迎来到玄枢</span>
            <h1>{mode === 'login' ? '别来无恙' : '开启问学之旅'}</h1>
            <p>{mode === 'login' ? '登录账号，继续你的探索与研习。' : '创建账号，遇见属于你的传统智慧。'}</p>
          </div>
          {/* 关闭注册后只剩一个页签，用 single 收窄，避免红色下划线被拉满整行 */}
          <div className={`auth-tabs ${canRegister ? '' : 'single'}`} role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => switchMode('login')}>登录</button>
            {canRegister && (
              <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'active' : ''} onClick={() => switchMode('register')}>注册</button>
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
              name="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
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
              name="password"
              minLength={mode === 'register' ? 6 : undefined}
              maxLength={mode === 'register' ? 72 : undefined}
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
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                required
              />
            </label>
          )}
          {mode === 'register' && (
            <label className="field">
              <span id="confirm-password-label">确认密码</span>
              <input
                ref={confirmRef}
                type="password"
                name="confirm-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onBlur={() => setConfirmTouched(true)}
                placeholder="请再次输入上方密码"
                autoComplete="new-password"
                aria-labelledby="confirm-password-label"
                aria-describedby="confirm-password-hint"
                aria-invalid={confirmMismatch || undefined}
                required
              />
              <small id="confirm-password-hint" className={`field-hint${confirmMismatch ? ' field-hint-error' : ''}`} aria-live="polite">
                {confirmMismatch ? '两次密码不一致，请检查后重试。' : '再次输入密码，确保两次填写一致。'}
              </small>
            </label>
          )}

          {err && <p className="auth-error" role="alert">{err}</p>}

          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? '请稍候…' : mode === 'login' ? '登录，进入玄枢' : '创建账号'}
          </button>

          <p className="auth-foot">
            {regOpen
              ? <>你的对话记录会自动保存在你的账户下。<br /></>
              : <>本站为邀请制，账号需管理员发放邀请码。<br /></>}
            登录即代表你理解：本应用各模块内容为传统文化学习研究之用，不构成医疗诊断或现实决策建议。
          </p>
        </form>
      </div>
    </div>
  );
}
