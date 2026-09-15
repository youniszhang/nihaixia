import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../lib/api.js';

// 手机 / iPad 访问：地址 + 二维码 + PWA 安装指引
// - 服务器部署：显示站点公网地址（PUBLIC_URL / 当前网址）
// - 桌面版：显示局域网地址（手机需与电脑同一 Wi-Fi）
export default function LanAccess({ onClose }) {
  const [data, setData] = useState({ urls: [], mode: 'desktop' });
  const [qr, setQr] = useState('');
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.lanInfo().then(async (d) => {
      let urls = d.urls || [];
      // 服务器模式且未配置 PUBLIC_URL 时，用当前浏览器地址兜底
      if (!urls.length && d.mode === 'server') urls = [location.origin];
      setData({ urls, mode: d.mode, hint: d.hint });
      if (urls.length) {
        try {
          setQr(await QRCode.toDataURL(urls[0], { width: 320, margin: 1, color: { dark: '#2c2c2c', light: '#ffffff' } }));
        } catch { /* ignore */ }
      }
    }).catch((e) => setErr(e.message || '获取失败'));
  }, []);

  async function copy() {
    if (!data.urls.length) return;
    try {
      await navigator.clipboard.writeText(data.urls[0]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }

  const isServer = data.mode === 'server';

  return (
    <div className="lan-wrap">
      <ol className="lan-steps">
        {isServer ? (
          <>
            <li>手机扫描下方二维码（或直接访问该网址）</li>
            <li>登录你的账号即可问诊，记录与电脑端实时同步</li>
            <li>点 Safari/浏览器底部<strong>「分享」→「添加到主屏幕」</strong>，得到独立 App 图标，无需 App Store</li>
          </>
        ) : (
          <>
            <li>确保手机与这台电脑连的是<strong>同一个 Wi-Fi</strong></li>
            <li>手机扫描下方二维码（或手动输入地址）</li>
            <li>打开后点<strong>「分享」→「添加到主屏幕」</strong>，即得到独立 App 图标，无需 App Store</li>
          </>
        )}
      </ol>

      {err && <p className="auth-error">{err}</p>}
      {data.hint && <p className="admin-hint">{data.hint}</p>}

      {data.urls.length > 0 && (
        <div className="lan-body">
          <div className="lan-qr">
            {qr ? <img src={qr} alt="二维码" width={220} height={220} /> : <div className="lan-qr-placeholder" />}
          </div>
          <div className="lan-urls">
            {data.urls.map((u) => (
              <div key={u} className="lan-url" onClick={copy} title="点击复制">{u}</div>
            ))}
            {copied && <p className="sheet-msg">已复制</p>}
          </div>
        </div>
      )}

      <p className="admin-hint">
        {isServer
          ? '手机端与电脑端共用同一账号与问诊记录。网页版 DeepSeek（0 Token）的浏览器运行在服务器上，因此该模式需要服务器装有 Chrome；若未装，可在「模型设置」使用 API Key 模式。'
          : '说明：手机端走的是这台电脑上的服务，问诊记录与电脑端完全一致。网页版 DeepSeek（0 Token）的浏览器在电脑上运行，手机端同样可用；若在手机上使用更稳定，可在「模型设置」切到 API Key 模式。请勿在公共 Wi-Fi 下开放访问。'}
      </p>

      <div className="sheet-actions">
        <button type="button" className="btn-primary" onClick={onClose}>完成</button>
      </div>
    </div>
  );
}
