import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

const EMPTY = { nickname: '', gender: '', age: '', height_cm: '', weight_kg: '', body_notes: '' };

export default function ProfileForm({ onClose }) {
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.getProfile().then(({ profile }) => {
      if (profile) {
        setForm({
          nickname: profile.nickname || '',
          gender: profile.gender || '',
          age: profile.age ?? '',
          height_cm: profile.height_cm ?? '',
          weight_kg: profile.weight_kg ?? '',
          body_notes: profile.body_notes || '',
        });
      }
    }).catch(() => {});
  }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setMsg('');
    try {
      await api.saveProfile({
        nickname: form.nickname.trim(),
        gender: form.gender,
        age: form.age === '' ? null : Number(form.age),
        height_cm: form.height_cm === '' ? null : Number(form.height_cm),
        weight_kg: form.weight_kg === '' ? null : Number(form.weight_kg),
        body_notes: form.body_notes.trim(),
      });
      setMsg('已保存，之后每次问诊都会参考这些体质信息。');
    } catch (e2) {
      setMsg(e2.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="sheet-form" onSubmit={onSubmit}>
      <div className="sheet-grid">
        <label className="field"><span>称呼</span>
          <input value={form.nickname} onChange={set('nickname')} placeholder="怎么称呼你" maxLength={20} />
        </label>
        <label className="field"><span>性别</span>
          <select value={form.gender} onChange={set('gender')}>
            <option value="">未填写</option>
            <option value="男">男</option>
            <option value="女">女</option>
          </select>
        </label>
        <label className="field"><span>年龄</span>
          <input type="number" min="1" max="120" value={form.age} onChange={set('age')} placeholder="岁" />
        </label>
        <label className="field"><span>身高</span>
          <input type="number" min="50" max="250" step="0.1" value={form.height_cm} onChange={set('height_cm')} placeholder="cm" />
        </label>
        <label className="field"><span>体重</span>
          <input type="number" min="2" max="300" step="0.1" value={form.weight_kg} onChange={set('weight_kg')} placeholder="kg" />
        </label>
      </div>
      <label className="field">
        <span>基础疾病 / 用药情况（选填）</span>
        <textarea rows={3} maxLength={500} value={form.body_notes} onChange={set('body_notes')} placeholder="如：高血压服用降压药中、糖尿病史、对某药物过敏等" />
      </label>
      {msg && <p className="sheet-msg">{msg}</p>}
      <div className="sheet-actions">
        <button type="button" className="btn-ghost" onClick={onClose}>关闭</button>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? '保存中…' : '保存体质档案'}</button>
      </div>
    </form>
  );
}
