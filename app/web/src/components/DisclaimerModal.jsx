import { useState } from 'react';
import Icon from './Icon.jsx';

export default function DisclaimerModal({ onAccept }) {
  const [agreed, setAgreed] = useState(false);

  return (
    <div className="overlay disclaimer-overlay">
      <div className="sheet disclaimer-sheet">
        <div className="disclaimer-body">
          <div className="disclaimer-icon"><Icon name="alert" size={36} strokeWidth={1.6} /></div>
          <h2>使用须知</h2>
          <ul className="disclaimer-list">
            <li>本应用由 <strong>AI 生成</strong>内容，角色设定为倪海厦学术视角，仅供<strong>中医学习与学术研究</strong>。</li>
            <li>AI 内容<strong>不构成医疗诊断、处方或治疗建议</strong>，不能替代执业医师的面对面诊疗。</li>
            <li>请勿仅依据 AI 建议自行抓药服用；中药需辨证使用，<strong>误用可能有害</strong>。</li>
            <li>如出现<strong>胸痛、呼吸困难、大出血、昏迷、高热不退</strong>等急危重症，请<strong>立即拨打 120 或前往急诊</strong>，切勿延误。</li>
            <li>你的问诊记录保存在本服务器数据库中，请勿输入无关个人隐私。</li>
          </ul>
          <label className="disclaimer-agree">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            我已阅读并理解以上内容，同意承担因不当使用产生的风险
          </label>
        </div>
        <div className="sheet-actions">
          <button className="btn-primary" onClick={onAccept} disabled={!agreed}>
            {agreed ? '开始使用' : '请先勾选同意'}
          </button>
        </div>
      </div>
    </div>
  );
}
