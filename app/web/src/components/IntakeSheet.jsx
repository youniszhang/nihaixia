import { useState } from 'react';

const TEN_ASK = [
  { key: 'chill_fever', label: '寒热', desc: '怕冷？发热？怕冷重还是发热重？有无寒热往来？', type: 'textarea' },
  { key: 'sweat', label: '汗', desc: '有汗无汗？何时出汗？汗出后怕不怕风？', type: 'textarea' },
  { key: 'head_body', label: '头身', desc: '头痛？身痛？关节痛？沉重感？', type: 'textarea' },
  { key: 'stool_urine', label: '二便', desc: '大便几天一次/一天几次？干结还是稀溏？小便色？次数？', type: 'textarea' },
  { key: 'appetite', label: '饮食', desc: '胃口如何？饥不饿？喜冷饮还是热饮？口干？', type: 'textarea' },
  { key: 'chest', label: '胸腹', desc: '胸闷？胁痛？心下痞满？腹胀？', type: 'textarea' },
  { key: 'sleep', label: '睡眠', desc: '失眠？易醒？多梦？一觉到天亮？', type: 'textarea' },
  { key: 'thirst_taste', label: '口渴/口味', desc: '口渴？想喝水？口中感觉？味觉？', type: 'textarea' },
  { key: 'gynecology', label: '妇科（女）', desc: '月经周期？经量色质？带下？', type: 'textarea' },
  { key: 'skin', label: '皮肤', desc: '皮肤干燥？疹子？水肿？瘀斑？', type: 'textarea' },
];

const TONGUE_OPTIONS = [
  { key: 'tongue_body', label: '舌质', options: ['淡红', '淡白', '红绛', '紫暗', '胖大', '瘦薄', '有齿痕', '有裂纹'] },
  { key: 'tongue_coat', label: '舌苔', options: ['薄白', '白厚', '薄黄', '黄厚', '黄腻', '白腻', '少苔', '无苔', '剥苔'] },
  { key: 'pulse', label: '脉象（选填）', options: ['浮', '沉', '迟', '数', '弦', '滑', '细', '弱', '涩', '结代', '洪', '紧', '不知道自己摸一下'] },
];

export default function IntakeSheet({ onApply, onClose }) {
  const [data, setData] = useState({});
  const [customPulse, setCustomPulse] = useState('');
  const [tongueOther, setTongueOther] = useState('');

  function set(key, value) { setData((d) => ({ ...d, [key]: value })); }

  function generateSummary() {
    const lines = [];
    const hasTen = TEN_ASK.some((q) => data[q.key]?.trim());
    const hasTongue = TONGUE_OPTIONS.some((t) => {
      if (t.key === 'pulse') return data[t.key]?.length || customPulse;
      return data[t.key]?.length;
    }) || tongueOther;
    if (hasTen) {
      lines.push('— 十问摘要 —');
      for (const q of TEN_ASK) {
        const v = data[q.key]?.trim();
        if (v) lines.push(`${q.label}：${v}`);
      }
    }
    if (hasTongue) {
      lines.push('\n— 舌象/脉象 —');
      for (const t of TONGUE_OPTIONS) {
        const vals = data[t.key] || [];
        if (t.key === 'pulse') {
          const all = [...vals, customPulse].filter(Boolean);
          if (all.length) lines.push(`${t.label}：${all.join('、')}`);
        } else {
          if (vals.length) lines.push(`${t.label}：${vals.join('、')}`);
        }
      }
      if (tongueOther) lines.push('舌象补充：' + tongueOther);
    }
    const main = (data.main_complaint || '').trim();
    if (main) lines.unshift('主诉：' + main);
    return lines.join('\n');
  }

  return (
    <div className="intake-form">
      <label className="field">
        <span>主诉 <small>（必填，描述你最不舒服的症状）</small></span>
        <textarea rows={2} value={data.main_complaint || ''} onChange={(e) => set('main_complaint', e.target.value)} placeholder="如：感冒三天，怕冷没汗，后脖子僵硬，体温38.5°C" />
      </label>

      <details open>
        <summary>十问（逐项填写，越详细越好）</summary>
        <div className="intake-grid">
          {TEN_ASK.map((q) => (
            <label key={q.key} className="field">
              <span>{q.label}</span>
              <small>{q.desc}</small>
              <textarea rows={2} value={data[q.key] || ''} onChange={(e) => set(q.key, e.target.value)} placeholder={q.desc} />
            </label>
          ))}
        </div>
      </details>

      <details open>
        <summary>舌象 / 脉象</summary>
        <div className="intake-tongue">
          {TONGUE_OPTIONS.map((t) => (
            <fieldset key={t.key}>
              <legend>{t.label}</legend>
              <div className="pill-group">
                {t.options.map((o) => (
                  <label key={o} className={`pill ${(data[t.key] || []).includes(o) ? 'active' : ''}`}>
                    <input
                      type="checkbox"
                      checked={(data[t.key] || []).includes(o)}
                      onChange={(e) => {
                        const cur = data[t.key] || [];
                        set(t.key, e.target.checked ? [...cur, o] : cur.filter((x) => x !== o));
                      }}
                    />
                    {o}
                  </label>
                ))}
                {t.key === 'pulse' && (
                  <input type="text" className="pill-input" value={customPulse} onChange={(e) => setCustomPulse(e.target.value)} placeholder="其他脉象" />
                )}
              </div>
            </fieldset>
          ))}
          <label className="field">
            <span>舌象补充（其他所见）</span>
            <textarea rows={2} value={tongueOther} onChange={(e) => setTongueOther(e.target.value)} placeholder="如：舌下静脉曲张、舌面有瘀点、舌尖红等" />
          </label>
        </div>
      </details>

      <div className="intake-preview">
        <strong>问诊单预览：</strong>
        <pre>{generateSummary() || '（填写后自动生成摘要，将作为问诊背景信息发送给倪师 AI）'}</pre>
      </div>

      <div className="sheet-actions">
        <button type="button" className="btn-ghost" onClick={onClose}>取消</button>
        <button
          type="button"
          className="btn-primary"
          disabled={!data.main_complaint?.trim()}
          onClick={() => {
            if (!data.main_complaint?.trim()) return;
            onApply(generateSummary());
          }}
        >
          ✅ 确认并问诊
        </button>
      </div>
    </div>
  );
}