import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import Icon from '../Icon.jsx';

// 站点设置：注册开关 / 问诊上限与默认额度 / 每日签到（含 CF 人机校验）/ 管理员来源 / 操作审计
export default function AdminSite() {
  const [site, setSite] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // 表单态（与站点设置分离，保存后回填服务端值）
  const [limitInput, setLimitInput] = useState('');
  const [defaultCredits, setDefaultCredits] = useState('');
  const [reward, setReward] = useState('3');
  const [bonus, setBonus] = useState('2');
  const [bonusMax, setBonusMax] = useState('10');
  const [tsSiteKey, setTsSiteKey] = useState('');
  const [tsSecret, setTsSecret] = useState('');

  function hydrate(d) {
    setSite(d);
    setLimitInput(String(d.daily_chat_limit ?? 0));
    setDefaultCredits(d.default_credits == null ? '' : String(d.default_credits));
    setReward(String(d.checkin_reward ?? 3));
    setBonus(String(d.checkin_streak_bonus ?? 2));
    setBonusMax(String(d.checkin_streak_bonus_max ?? 10));
    setTsSiteKey(d.turnstile_site_key || '');
    setTsSecret('');
  }

  async function load() {
    try { hydrate(await api.adminGetSite()); } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  function flash(t) { setMsg(t); setTimeout(() => setMsg(''), 3000); }

  async function save(patch, okText) {
    setBusy(true); setErr('');
    try {
      hydrate(await api.adminSaveSite(patch));
      flash(okText);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function toggleRegistration() {
    const next = !site.registration_enabled;
    await save({ registration_enabled: next }, next ? '已开启注册' : '已关闭注册');
  }

  async function toggleCheckin() {
    const next = !site.checkin_enabled;
    await save({ checkin_enabled: next }, next ? '已开启每日签到' : '已关闭每日签到');
  }

  if (!site) return err ? <p className="auth-error">{err}</p> : <p className="admin-loading">加载中…</p>;

  return (
    <div className="admin-site">
      <section className="admin-section">
        <h3><Icon name="user" size={16} /> 用户注册</h3>
        <div className="setting-row">
          <div>
            <strong>允许新用户自行注册</strong>
            <p className="setting-desc">
              关闭后，登录页隐藏「注册」入口，注册接口也会拒绝请求；新账号只能由管理员在「用户管理」中创建。
              {!site.registration_explicit && site.registration_enabled && (
                <><br /><span className="setting-warn">当前为默认开放（兼容既有部署）。切换一次后会写入明确设置。</span></>
              )}
            </p>
          </div>
          <button
            className={`switch ${site.registration_enabled ? 'on' : ''}`}
            onClick={toggleRegistration}
            disabled={busy}
            role="switch"
            aria-checked={site.registration_enabled}
            aria-label="允许新用户自行注册"
          >
            <span className="switch-knob" />
          </button>
        </div>
      </section>

      <section className="admin-section">
        <h3><Icon name="credit-limit" size={16} /> 问诊次数与额度</h3>
        <div className="setting-row">
          <div>
            <strong>站点默认每日问诊上限（每用户）</strong>
            <p className="setting-desc">
              按每个用户当天<b>成功生成回复</b>的次数计数，0 = 不限。这是最低优先级：
              用户专属上限、生效套餐的上限都会覆盖它。达到上限后当天无法继续提问。
            </p>
          </div>
          <div className="setting-value site-limit-input">
            <input
              type="number" min="0" step="1"
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value)}
              disabled={busy}
              aria-label="站点默认每日问诊上限"
            />
            <button
              type="button" className="btn-primary" disabled={busy}
              onClick={() => save({ daily_chat_limit: Math.max(0, Math.floor(Number(limitInput) || 0)) },
                Number(limitInput) > 0 ? `每日上限已设为 ${limitInput} 次` : '每日上限已取消（不限）')}
            >
              保存
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>新用户默认额度（次）</strong>
            <p className="setting-desc">
              留空 = <b>不限次</b>（沿用既有部署，老账号与新账号都可无限问诊）。填 0 或正整数则启用「额度制」：
              新注册用户按该额度开工，每成功问诊扣 1 次，扣完需<b>每日签到</b>或<b>开通套餐</b>才能继续。
              <br />已有账号不受影响，可在「用户管理 → 额度」单独设置。
            </p>
          </div>
          <div className="setting-value site-limit-input">
            <input
              type="number" min="0" step="1"
              value={defaultCredits}
              placeholder="留空 = 不限次"
              onChange={(e) => setDefaultCredits(e.target.value)}
              disabled={busy}
              aria-label="新用户默认额度"
            />
            <button
              type="button" className="btn-primary" disabled={busy}
              onClick={() => save({ default_credits: defaultCredits.trim() },
                defaultCredits.trim() === '' ? '新用户改为不限次' : `新用户默认额度 ${defaultCredits} 次`)}
            >
              保存
            </button>
          </div>
        </div>
      </section>

      <section className="admin-section">
        <h3><Icon name="calendar-check" size={16} /> 每日签到</h3>
        <div className="setting-row">
          <div>
            <strong>开启每日签到</strong>
            <p className="setting-desc">
              用户每自然日（北京时区）可签到一次，额度制账号按「基础奖励 + 连签加成」发放额度；
              连续中断后连签天数从 1 重新计算。
            </p>
          </div>
          <button
            className={`switch ${site.checkin_enabled ? 'on' : ''}`}
            onClick={toggleCheckin}
            disabled={busy}
            role="switch"
            aria-checked={site.checkin_enabled}
            aria-label="开启每日签到"
          >
            <span className="switch-knob" />
          </button>
        </div>

        <div className="setting-row">
          <div>
            <strong>签到奖励</strong>
            <p className="setting-desc">
              基础奖励：每次签到发放的额度；连签加成：第 N 天额外加 (N−1)×加成，但不超过加成上限。
              例如基础 3、加成 2、上限 10：首日 +3，第 2 天 +5，第 3 天 +7 …
            </p>
          </div>
          <div className="setting-value checkin-inputs">
            <label>
              <span>基础奖励</span>
              <input type="number" min="0" step="1" value={reward} onChange={(e) => setReward(e.target.value)} disabled={busy} />
            </label>
            <label>
              <span>连签加成</span>
              <input type="number" min="0" step="1" value={bonus} onChange={(e) => setBonus(e.target.value)} disabled={busy} />
            </label>
            <label>
              <span>加成上限</span>
              <input type="number" min="0" step="1" value={bonusMax} onChange={(e) => setBonusMax(e.target.value)} disabled={busy} />
            </label>
            <button
              type="button" className="btn-primary" disabled={busy}
              onClick={() => save({
                checkin_reward: Number(reward) || 0,
                checkin_streak_bonus: Number(bonus) || 0,
                checkin_streak_bonus_max: Number(bonusMax) || 0,
              }, '签到奖励已保存')}
            >
              保存
            </button>
          </div>
        </div>

        <div className="setting-row">
          <div>
            <strong>人机校验（Cloudflare Turnstile）</strong>
            <p className="setting-desc">
              防止脚本刷签到：填入 Cloudflare Turnstile 的 <code>Site Key</code> 与 <code>Secret Key</code> 后，
              签到前必须通过校验。<b>两项都填齐才生效</b>（只填一项会被视为未启用，避免把用户挡在门外）。
              在 Cloudflare 控制台 → Turnstile 中添加站点即可获得密钥；本站按 IP 访问时，域名可填你的域名或服务器标识。
              <br />
              当前状态：
              {site.turnstile_active
                ? <span className="setting-ok"> 已启用（签到需通过人机校验）</span>
                : <span className="setting-warn"> 未启用（仅靠每自然日一次 + 接口限流防刷）</span>}
            </p>
          </div>
          <div className="setting-value turnstile-inputs">
            <label>
              <span>Site Key</span>
              <input
                value={tsSiteKey}
                onChange={(e) => setTsSiteKey(e.target.value)}
                placeholder="0x4AAAAAAA…"
                disabled={busy}
              />
            </label>
            <label>
              <span>Secret Key</span>
              <input
                type="password"
                value={tsSecret}
                onChange={(e) => setTsSecret(e.target.value)}
                placeholder={site.turnstile_secret_set ? '已配置（留空则不修改）' : '0x4AAAAAAA…'}
                disabled={busy}
              />
            </label>
            <div className="turnstile-actions">
              <button
                type="button" className="btn-primary" disabled={busy}
                onClick={() => save({
                  turnstile_site_key: tsSiteKey.trim(),
                  ...(tsSecret.trim() ? { turnstile_secret_key: tsSecret.trim() } : {}),
                }, '人机校验设置已保存')}
              >
                保存
              </button>
              <button
                type="button" className="btn-ghost" disabled={busy}
                onClick={() => { if (confirm('清除 Turnstile 配置？清除后签到不再要求人机校验。')) save({ turnstile_site_key: '', turnstile_secret_key: '' }, '已清除人机校验配置'); }}
              >
                清除
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="admin-section">
        <h3><Icon name="shield" size={16} /> 管理员</h3>
        <div className="setting-row">
          <div>
            <strong>管理员账号由配置文件指定</strong>
            <p className="setting-desc">
              在服务器 <code>.env</code> 中设置 <code>ADMIN_USERNAME=用户名</code>，重启后生效。
              该账号即唯一管理员（不再由「第一个注册的用户」自动担任）。
              {site.admin_source === 'legacy' && (
                <><br /><span className="setting-warn">当前未配置 ADMIN_USERNAME，正沿用老规则（第一个注册的用户）。建议尽快在 .env 中明确指定。</span></>
              )}
            </p>
          </div>
          <div className="setting-value">
            {site.admin_username
              ? <code>{site.admin_username}</code>
              : <span className="setting-warn">未配置</span>}
          </div>
        </div>
      </section>

      <AuditLog />

      {msg && <p className="sheet-msg">{msg}</p>}
      {err && <p className="auth-error">{err}</p>}
    </div>
  );
}

function AuditLog() {
  const [logs, setLogs] = useState([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.adminAudit(100).then((d) => setLogs(d.logs || [])).catch((e) => setErr(e.message));
  }, []);

  const LABELS = {
    'user.create': '创建用户',
    'user.update': '修改用户',
    'user.delete': '删除用户',
    'user.bulk_disable': '批量禁用',
    'user.bulk_enable': '批量启用',
    'user.bulk_delete': '批量删除',
    'site.registration': '注册开关',
    'site.daily_limit': '每日问诊上限',
    'site.checkin': '签到设置',
    'site.turnstile': '人机校验设置',
    'site.default_credits': '新用户默认额度',
    'plan.create': '新建套餐',
    'plan.update': '修改套餐',
    'plan.delete': '删除套餐',
    'subscription.grant': '开通订阅',
    'subscription.approve': '审批通过',
    'subscription.reject': '驳回申请',
    'subscription.cancel': '撤销订阅',
  };

  return (
    <section className="admin-section">
      <h3><Icon name="file-text" size={16} /> 操作审计（最近 100 条）</h3>
      {err && <p className="auth-error">{err}</p>}
      <table className="admin-table">
        <thead>
          <tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>详情</th></tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id}>
              <td className="td-dim">{l.created_at}</td>
              <td>{l.actor_username || '—'}</td>
              <td>{LABELS[l.action] || l.action}</td>
              <td>{l.target || '—'}</td>
              <td className="td-dim">{l.detail || '—'}</td>
            </tr>
          ))}
          {logs.length === 0 && <tr><td colSpan={5} className="td-empty">暂无记录</td></tr>}
        </tbody>
      </table>
    </section>
  );
}