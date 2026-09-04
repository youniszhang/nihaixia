import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

export default function AdminSettings({ onClose }) {
  const [cfg, setCfg] = useState({ base_url: '', model: '', api_key: '' });
  const [info, setInfo] = useState({ has_key: false, api_key_masked: '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    api.getLlmConfig().then((d) => {
      setInfo({ has_key: d.has_key, api_key_masked: d.api_key_masked });
      setCfg((c) => ({ ...c, base_url: d.base_url || '', model: d.model || '' }));
    }).catch((e) => setErr(e.message));
  }, []);

  const set = (k) => (e) => setCfg((c) => ({ ...c, [k]: e.target.value }));

  async function onSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setMsg('');
    setErr('');
    try {
      const d = await api.saveLlmConfig({
        base_url: cfg.base_url.trim(),
        model: cfg.model.trim(),
        api_key: cfg.api_key.trim(), // empty = keep existing
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

  return (
    <form className="sheet-form" onSubmit={onSubmit}>
      <p className="admin-hint">
        配置任意 OpenAI 兼容服务（DeepSeek / Kimi / 通义 / vLLM 等）。密钥仅保存在服务器数据库中，
        浏览器与前端代码永远接触不到完整 Key。
      </p>
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
      {msg && <p className="sheet-msg">{msg}</p>}
      {err && <p className="auth-error">{err}</p>}
      <div className="sheet-actions">
        <button type="button" className="btn-ghost" onClick={onClose}>关闭</button>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? '保存中…' : '保存配置'}</button>
      </div>
    </form>
  );
}
