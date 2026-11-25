import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { canDeploy, createSystemUpdater } from '../lib/systemUpdate.js';
import Icon from './Icon.jsx';

const STAGES = [
  { key: 'git', label: '拉取代码' },
  { key: 'build', label: '构建服务' },
  { key: 'health', label: '检查服务' },
];

function localTime(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime())
    ? date.toLocaleString('zh-CN', { hour12: false }) : '尚未检查';
}

export default function SystemUpdate() {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [view, setView] = useState({ loading: true });
  const controller = useRef(null);
  const dialog = useRef(null);
  const trigger = useRef(null);

  useEffect(() => {
    const updater = createSystemUpdater({ api, onChange: setView });
    controller.current = updater;
    updater.start();
    return () => { updater.dispose(); controller.current = null; };
  }, []);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else if (dialog.current?.open) {
      dialog.current.close();
      trigger.current?.focus();
    }
  }, [open]);

  const s = view.status || {};
  const running = !view.unconfirmed && Boolean(view.pending || s.running);
  const unavailable = s.enabled === false;
  const problem = Boolean(view.connectionError || s.checkError || s.workspaceOk === false || view.unconfirmed || s.ok === false);
  const blocked = view.loading || view.checking || running || s.running || Boolean(view.connectionError) || unavailable;
  const deployable = !blocked && canDeploy(s);
  const tone = running ? 'working' : problem ? 'warning' : s.updateAvailable ? 'new' : 'ready';
  const label = running ? '维护进行中' : view.loading || view.checking ? '正在检查'
    : unavailable ? '未启用更新' : s.ok === false ? '上次维护失败' : problem ? '待检查'
    : s.updateAvailable === true ? '发现新版本' : s.updateAvailable === false ? '已是最新' : '待检查';
  const steps = view.pending === 'restart' ? STAGES.filter((step) => step.key === 'build') : STAGES;
  const stageIndex = steps.findIndex((step) => step.key === s.stage);
  const failed = !running && !view.unconfirmed && s.ok === false;
  const succeeded = !running && !view.unconfirmed && s.ok === true;

  function close() { setOpen(false); setConfirm(null); }

  function outsideClick(event) {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  }

  return (
    <div className="system-update-entry">
      <button
        ref={trigger}
        type="button"
        className={`system-version-trigger ${tone}`}
        aria-label={`系统更新与部署，${label}${s.localCommit ? `，版本 ${s.localCommit}` : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`系统更新与部署 · ${label}`}
        onClick={() => setOpen(true)}
      >
        <Icon name="refresh" size={15} />
        <span className="system-version-copy"><span className="system-version-desktop">更新与部署</span><span className="system-version-mobile">更新</span><code>{s.localCommit || label}</code></span>
        <span className={`system-version-dot ${tone}`} aria-hidden="true" />
        <Icon name="chevron-down" size={12} className="system-version-chevron" />
      </button>

      <dialog
        ref={dialog}
        className="system-update-dialog"
        aria-labelledby="system-update-title"
        onClick={outsideClick}
        onCancel={(event) => { event.preventDefault(); close(); }}
        onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation(); }}
      >
        <header className="system-update-head">
          <div><span className="system-update-kicker">玄枢 · 系统维护</span><h2 id="system-update-title">更新与部署</h2></div>
          <button type="button" className="icon-btn" onClick={close} aria-label="关闭更新面板" title="关闭更新面板" autoFocus><Icon name="close" size={18} /></button>
        </header>
        <div className="system-update-content">
          <div className="system-version-heading">
            <span className={`system-status-badge ${tone}`} role="status"><span className={`system-version-dot ${tone}`} />{label}</span>
            <button type="button" className="system-check-btn" onClick={() => { setConfirm(null); controller.current?.check(); }} disabled={view.loading || view.checking || running}>
              <Icon name="refresh" size={14} />{view.checking ? '检查中…' : '检查更新'}
            </button>
          </div>

          <div className="system-version-pair">
            <div><span>当前代码版本</span><code title={s.localCommit || ''}>{s.localCommit || '—'}</code></div>
            <Icon name="arrow-right" size={17} />
            <div><span>远端最新版本</span><code title={s.remoteCommit || ''}>{view.checking ? '检查中…' : s.remoteCommit || '—'}</code></div>
          </div>
          <p className="system-checked-at">{s.checkedAt ? `上次检查 ${localTime(s.checkedAt)} · 本地时间` : '检查更新后，将显示可部署的代码版本。'}</p>

          {unavailable ? (
            <div className="system-notice"><Icon name="info" size={18} /><div><strong>此环境尚未启用在线更新</strong><p>启用服务器更新服务后，即可在这里检查版本并部署。桌面版请使用安装包更新。</p></div></div>
          ) : (
            <>
              {view.connectionError && <div className="system-notice warning" role="status"><Icon name="alert" size={18} /><div><strong>{running ? '正在等待服务恢复' : '暂时无法连接更新服务'}</strong><p>{running ? '部署期间可能短暂断开连接，正在自动重试，请勿重复部署。' : view.connectionError}</p></div></div>}
              {s.workspaceOk === false && <div className="system-notice warning" role="alert"><Icon name="alert" size={18} /><div><strong>服务器更新目录需要修复</strong><p>请检查更新服务的仓库目录与挂载配置，修复后重新检查。</p><details><summary>查看原因</summary><p>{s.workspaceError}</p></details></div></div>}
              {s.checkError && s.workspaceOk !== false && <div className="system-notice warning" role="alert"><Icon name="alert" size={18} /><div><strong>本次版本检查未完成</strong><p>已保留上次版本信息。请重新检查成功后再部署。</p><details><summary>查看原因</summary><p>{s.checkError}</p></details></div></div>}
              {view.unconfirmed && <div className="system-notice warning" role="status"><Icon name="info" size={18} /><div><strong>本次维护结果尚未确认</strong><p>更新服务可能已重启或等待时间较长。请检查服务与部署日志，确认结果后再操作。</p></div></div>}

              {running && (
                <section className="system-deploy-progress" aria-label="维护进度">
                  <div className="system-progress-title" role="status"><Icon name="clock" size={16} /><strong>{view.pending === 'restart' ? '正在重启服务' : '正在更新服务'}</strong><span>请稍候</span></div>
                  <ol className="system-deploy-steps">{steps.map((step, index) => {
                    const done = stageIndex > index || s.stage === 'done';
                    const active = s.stage === step.key;
                    return <li key={step.key} className={done ? 'done' : active ? 'active' : ''} aria-current={active ? 'step' : undefined}><span>{done ? <Icon name="check" size={12} /> : index + 1}</span>{step.label}</li>;
                  })}</ol>
                  <p>{view.connectionError ? '保持此页面即可，连接恢复后会继续显示进度。' : s.running ? s.message : '任务已提交，正在确认服务器进度…'}</p>
                  {s.startedAt && <small>开始于 {localTime(s.startedAt)}</small>}
                </section>
              )}
              {(failed || succeeded) && <div className={`system-notice ${failed ? 'warning' : 'success'}`} role="status"><Icon name={failed ? 'alert' : 'check-circle'} size={18} /><div><strong>{failed ? '上次维护失败' : '上次维护已完成'}</strong><p>{s.message}</p>{s.finishedAt && <small>{localTime(s.finishedAt)}</small>}{succeeded && <button type="button" className="system-reload-btn" onClick={() => window.location.reload()}>刷新页面，载入当前界面<Icon name="arrow-right" size={13} /></button>}</div></div>}
              {view.actionError && <p className="system-action-error" role="alert">{view.actionError}</p>}

              {!running && !confirm && <div className="system-deploy-action"><p>{deployable ? '新版本已就绪，可更新到服务器。' : s.updateAvailable === false && s.ok === false ? '代码已同步，上次维护失败。可在维护选项中使用当前代码重建服务。' : s.updateAvailable === false && !problem ? '代码已与远端同步，无需重复部署。' : '完成版本检查后，即可部署新版本。'}</p><button type="button" className="btn-primary" disabled={!deployable} onClick={() => setConfirm('update')}><Icon name="download" size={16} />更新并部署</button></div>}
              {confirm && !running && <div className="system-confirm" role="group" aria-label="确认维护操作"><strong>{confirm === 'update' ? `部署新版本 ${s.remoteCommit || ''}？` : '确认重新构建并重启服务？'}</strong><p>{confirm === 'update' ? '将拉取最新代码并重建服务。' : '使用当前代码重建服务，不拉取远端更新。'}通常需要 1–3 分钟，期间访问可能短暂中断。</p><div><button type="button" className="btn-ghost" autoFocus onClick={() => setConfirm(null)}>取消</button><button type="button" className="btn-primary" disabled={confirm === 'update' ? !deployable : blocked || s.workspaceOk === false} onClick={() => { controller.current?.run(confirm); setConfirm(null); }}>{confirm === 'update' ? '确认部署' : '确认重启'}</button></div></div>}

              {s.log?.length > 0 && <details className="system-log-details" key={s.startedAt || 'logs'}><summary><Icon name="file-text" size={15} /><span>部署日志</span><small>最近 {s.log.length} 条</small><Icon name="chevron-down" size={13} /></summary><pre className="system-deploy-log" tabIndex={0} aria-label="部署日志">{s.log.join('\n')}</pre></details>}
              <details className="system-maintenance"><summary>更多维护选项<Icon name="chevron-down" size={13} /></summary><div><p>仅需重启时，使用当前代码重新构建服务，不会拉取远端更新。</p><button type="button" className="btn-ghost" disabled={blocked || s.workspaceOk === false} onClick={() => setConfirm('restart')}><Icon name="refresh" size={15} />仅重启服务</button></div></details>
            </>
          )}
          <p className="system-update-footnote"><Icon name="info" size={13} />部署通常需要 1–3 分钟。关闭面板后，任务仍会在后台继续。</p>
        </div>
      </dialog>
    </div>
  );
}
