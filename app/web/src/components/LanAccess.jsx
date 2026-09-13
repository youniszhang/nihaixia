import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../lib/api.js';

// 手机 / iPad 访问：局域网地址 + 二维码 + PWA 安装指引
export default function LanAccess({ onClose }) {
  const [urls, setUrls] = useState([]);
  const [qr, setQr] = useState('');
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.lanInfo().then(async (d) => {
      setUrls(d.urls || []);
      if (d.urls?.length) {
        try {
          setQr(await QRCode.toDataURL(d.urls[0], { width: 320, margin: 1, color: { dark: '#2c2c2c', light: '#ffffff' } }));
        } catch { /* ignore */ }
      }
    }).catch((e) => setErr(e.message || '获取失败'));
  }, []);

  async function copy() {
    if (!urls.length) return;
    try {
      await navigator.clipboard.writeText(urls[0]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }

  return (
    <div className="lan-wrap">
      <ol className="lan-steps">
        <li>确保手机与这台电脑连的是<strong>同一个 Wi-Fi</strong></li>
        <li>手机 Safari 扫描下方二维码（或手动输入地址）</li>
        <li>打开后点 Safari 底部<strong>「分享」→「添加到主屏幕」</strong>，即得到独立 App 图标，无需 App Store</li>
      </ol>

      {err && <p className="auth-error">{err}</p>}

      {urls.length > 0 && (
        <div className="lan-body">
          <div className="lan-qr">
            {qr ? <img src={qr} alt="二维码" width={220} height={220} /> : <div className="lan-qr-placeholder" />}
          </div>
          <div className="lan-urls">
            {urls.map((u) => (
              <div key={u} className="lan-url" onClick={copy} title="点击复制">{u}</div>
            ))}
            {copied && <p className="sheet-msg">已复制</p>}
          </div>
        </div>
      )}

      <p className="admin-hint">
        说明：手机端走的是这台电脑上的服务，问诊记录与电脑端完全一致。
        网页版 DeepSeek（0 Token）的浏览器在电脑上运行，手机端同样可用；
        若在手机上使用更稳定，可在「模型设置」切到 API Key 模式。
        请勿在公共 Wi-Fi 下开放访问。
      </p>

      <div className="sheet-actions">
        <button type="button" className="btn-primary" onClick={onClose}>完成</button>
      </div>
    </div>
  );
}
