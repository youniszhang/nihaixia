import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

export default function AdminSettings({ onClose }) {
  const [cfg, setCfg] = useState({
    provider: 'api',
    base_url: '', model: '', api_key: '',
    dsweb_port: 9223, dsweb_expert: true,
    system_mode: 'auto',
  });
  const [info, setInfo] = useState({ has_key: false, api_key_masked: '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [dsStatus, setDsStatus] = useState('');   // 网页版登录状态文案
  const [dsBusy, setDsBusy] = useState(false);
  const isTauri = typeof window !== 'undefined' && !!window.__TAURI__;

  useEffect(() => {
    api.getLlmConfig().then((d) => {
      setInfo({ has_key: d.has_key, api_key_masked: d.api_key_masked });
      setCfg((c) => ({
        ...c,
        provider: d.provider || 'api',
        base_url: d.base_url || '',
        model: d.model || '',
        dsweb_port: d.dsweb_port || 9223,
        dsweb_expert: d.dsweb_expert !== false,
        system_mode: d.system_mode || 'auto',
      }));
    }).catch((e) => setErr(e.message));
  }, []);

  const set = (k) => (e) => setCfg((c) => ({ ...c, [k]: e.target.value }));

  async function onSubmit(e) {
    e.preventDefault();
    setSaving(true); setMsg(''); setErr('');
    try {
      const d = await api.saveLlmConfig({
        provider: cfg.provider,
        base_url: cfg.base_url.trim(),
        model: cfg.model.trim(),
        api_key: cfg.api_key.trim(),
        dsweb_port: Number(cfg.dsweb_port) || 9223,
        dsweb_expert: !!cfg.dsweb_expert,
        system_mode: cfg.system_mode,
      });
      setInfo({ has_key: d.has_key, api_key_masked: d.api_key_masked });
      setCfg((c) => ({ ...c, base_url: d.base_url || '', model: d.model || '', api_key: '' }));
      setMsg('已保存，立即生效（无需重启）。');
    } catch (e2) {
      setErr(e2.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function openLogin() {
    setDsBusy(true); setDsStatus(''); setErr('');
    try {
      // 先保存端口等设置，再用它打开登录窗口
      await api.saveLlmConfig({ provider: cfg.provider, dsweb_port: Number(cfg.dsweb_port) || 9223, dsweb_expert: !!cfg.dsweb_expert });
      await api.openDswebLogin();
      setDsStatus('已打开专用浏览器窗口：请在其中登录 chat.deepseek.com（登录一次即可，之后长期有效）。');
    } catch (e2) {
      setErr('打开浏览器失败：' + (e2.message || ''));
    } finally { setDsBusy(false); }
  }

  async function checkLogin() {
    setDsBusy(true); setDsStatus(''); setErr('');
    try {
      const r = await api.checkDswebLogin();
      setDsStatus(r.loggedIn
        ? '✅ 网页版已登录，可以开始 0 Token 问诊。'
        : '⚠️ 未检测到登录。请点击「打开浏览器登录」，在窗口内完成登录后重试。');
    } catch (e2) {
      setDsStatus('检测失败：' + (e2.message || ''));
    } finally { setDsBusy(false); }
  }

  async function killBrowser() {
    setDsBusy(true);
    try { await api.killDswebBrowser(); setDsStatus('已关闭专用浏览器。'); }
    catch (e2) { setDsStatus('操作失败：' + (e2.message || '')); }
    finally { setDsBusy(false); }
  }

  // 应用内登录：前端发起 → Tauri 事件开窗 → Rust 轮询 token → 内部通道注入 → 状态轮询
  async function inAppLogin() {
    const t = window.__TAURI__;
    if (!t?.event?.emit) { setErr('应用内登录仅桌面版可用'); return; }
    setDsBusy(true); setDsStatus(''); setErr('');
    try {
      await api.saveLlmConfig({
        provider: 'dsweb',
        dsweb_port: Number(cfg.dsweb_port) || 9223,
        dsweb_expert: !!cfg.dsweb_expert,
      });
      await api.startInAppLogin();
      await t.event.emit('ds-login-open', {});
      setDsStatus('已在应用内打开登录窗口，请完成登录（支持扫码/账号）。成功后自动生效…');
      for (let i = 0; i < 130; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = await api.inAppLoginStatus();
        if (st.state === 'success') {
          setDsStatus('✅ 登录成功！专用浏览器已就绪，0 Token 问诊可用。');
          return;
        }
        if (st.state === 'failed') {
          setDsStatus('⚠️ 登录未生效（校验失败），请重试一次。');
          return;
        }
        if (st.state === 'timeout') {
          setDsStatus('等待登录超时（4 分钟）。请重试，或用「打开浏览器登录」。');
          return;
        }
      }
    } catch (e2) {
      setErr('应用内登录失败：' + (e2.message || e2));
    } finally {
      setDsBusy(false);
    }
  }

  return (
    <form className="sheet-form" onSubmit={onSubmit}>
      <div className="field">
        <span>接入方式</span>
        <div className="provider-row">
          <label className={`provider-card ${cfg.provider === 'api' ? 'active' : ''}`}>
            <input type="radio" name="provider" checked={cfg.provider === 'api'} onChange={() => setCfg((c) => ({ ...c, provider: 'api' }))} />
            <div><strong>API Key 模式</strong><small>消耗 API 额度，服务器部署推荐</small></div>
          </label>
          <label className={`provider-card ${cfg.provider === 'dsweb' ? 'active' : ''}`}>
            <input type="radio" name="provider" checked={cfg.provider === 'dsweb'} onChange={() => setCfg((c) => ({ ...c, provider: 'dsweb' }))} />
            <div><strong>网页版 DeepSeek</strong><small>登录网页版即可问诊，0 API Token（本机使用推荐）</small></div>
          </label>
        </div>
      </div>

      {cfg.provider === 'api' ? (
        <>
          <label className="field">
            <span>接口地址 Base URL</span>
            <input value={cfg.base_url} onChange={set('base_url')} placeholder="https://api.deepseek.com" />
          </label>
          <label className="field">
            <span>模型名称</span>
            <input value={cfg.model} onChange={set('model')} placeholder="deepseek-chat" />
          </label>
          <label className="field">
            <span>API Key {info.has_key && <small className="key-mask">当前已保存：{info.api_key_masked}</small>}</span>
            <input
              type="password"
              value={cfg.api_key}
              onChange={set('api_key')}
              placeholder={info.has_key ? '留空则保持不变' : 'sk-...'}
              autoComplete="new-password"
            />
          </label>
          <label className="field">
            <span>人设下发方式 <small className="key-mask">中转网关若丢弃 system 会变"通用助手"，改 inline 可修复</small></span>
            <select value={cfg.system_mode} onChange={set('system_mode')}>
              <option value="auto">自动（推荐：官方 DeepSeek 用 system，中转用 inline）</option>
              <option value="system">system 角色（标准 OpenAI 协议）</option>
              <option value="inline">并入用户消息（兼容会丢 system 的中转）</option>
            </select>
          </label>
        </>
      ) : (
        <>
          <p className="admin-hint">
            走 DeepSeek 网页版的对话额度，不消耗 API Token。原理：驱动一个<strong>专用浏览器窗口</strong>（独立配置目录，
            不影响你的日常浏览器），登录一次 chat.deepseek.com 后，问诊请求自动注入网页版并发送、抓取回复。
            需要 Chrome/Edge；网页版有频率与风控限制，请适度使用。
          </p>
          <div className="sheet-grid">
            <label className="field">
              <span>调试端口</span>
              <input type="number" value={cfg.dsweb_port} onChange={set('dsweb_port')} placeholder="9223" />
            </label>
            <label className="field">
              <span>深度思考（专家模式）</span>
              <select value={cfg.dsweb_expert ? 'on' : 'off'} onChange={(e) => setCfg((c) => ({ ...c, dsweb_expert: e.target.value === 'on' }))}>
                <option value="on">开启（更慢更深入）</option>
                <option value="off">关闭（快速模式）</option>
              </select>
            </label>
          </div>
          <div className="dsweb-actions">
            {isTauri && (
              <button type="button" className="btn-primary dsweb-primary" onClick={inAppLogin} disabled={dsBusy}>🔑 应用内登录（推荐）</button>
            )}
            <button type="button" className="btn-ghost" onClick={openLogin} disabled={dsBusy}>🌐 打开浏览器登录</button>
            <button type="button" className="btn-ghost" onClick={checkLogin} disabled={dsBusy}>🔍 检测登录状态</button>
            <button type="button" className="btn-ghost" onClick={killBrowser} disabled={dsBusy}>✕ 关闭专用浏览器</button>
          </div>
          {!isTauri && <p className="sheet-msg">提示：当前是网页/服务器模式，「应用内登录」仅在桌面版可用。</p>}
          {dsStatus && <p className="sheet-msg">{dsStatus}</p>}
        </>
      )}

      {msg && <p className="sheet-msg">{msg}</p>}
      {err && <p className="auth-error">{err}</p>}
      <div className="sheet-actions">
        <button type="button" className="btn-ghost" onClick={onClose}>关闭</button>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? '保存中…' : '保存配置'}</button>
      </div>
    </form>
  );
}
