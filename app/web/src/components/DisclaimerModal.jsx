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
            <li>本应用（<strong>玄枢</strong>）由 AI 生成内容，各模块角色设定仅供<strong>传统文化学习与学术研究</strong>。</li>
            <li>中医模块内容<strong>不构成医疗诊断、处方或治疗建议</strong>，不能替代执业医师的面对面诊疗；请勿仅依据 AI 建议自行抓药服用。</li>
            <li>命理、风水、塔罗等模块内容展示的是倾向与可能，<strong>不是绝对定论</strong>；不构成对健康、财务、法律与现实决策的指导。</li>
            <li>如出现<strong>胸痛、呼吸困难、大出血、昏迷、高热不退</strong>等急危重症，请<strong>立即拨打 120 或前往急诊</strong>，切勿延误。</li>
            <li>你的对话记录保存在本服务器数据库中，请勿输入无关个人隐私。</li>
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
