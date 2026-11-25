const POLL_DELAY = 4000;
const WAIT_LIMIT = 10 * 60 * 1000;

// A failed status request is never evidence that a deployment has finished.
export function isSystemStatus(value) {
  return Boolean(value && !value.error && (value.enabled === false || typeof value.running === 'boolean'));
}

export function canDeploy(status) {
  return Boolean(isSystemStatus(status) && status.enabled && !status.running &&
    status.workspaceOk !== false && !status.checkError && status.updateAvailable === true);
}

// Kept outside React so the same serial polling loop survives a closed panel.
export function createSystemUpdater({ api, onChange, schedule = setTimeout, cancel = clearTimeout, now = Date.now }) {
  let view = {
    status: null, loading: true, checking: false, pending: null,
    connectionError: '', actionError: '', unconfirmed: false,
  };
  let disposed = false;
  let timer = null;
  let request = null;
  let job = null;

  function emit(patch) {
    if (disposed) return;
    view = { ...view, ...patch };
    onChange(view);
  }

  function poll() {
    cancel(timer);
    if (!disposed) timer = schedule(() => refresh(false), POLL_DELAY);
  }

  function finishUnconfirmed() {
    job = null;
    emit({ pending: null, unconfirmed: true });
  }

  function applyStatus(status) {
    emit({ status, connectionError: '' });
    if (status.running) {
      job ||= { kind: 'maintenance', baseline: null, since: now(), seenRunning: false, disconnected: false };
      job.seenRunning = true;
      emit({ pending: job.kind, unconfirmed: false, actionError: '' });
    } else if (job) {
      // Ignore a previous task's terminal record while the new task starts.
      const fresh = status.startedAt && status.startedAt !== job.baseline;
      if (fresh && status.finishedAt && ['done', 'failed'].includes(status.stage) && typeof status.ok === 'boolean') {
        job = null;
        emit({ pending: null, unconfirmed: false });
      } else if (status.enabled === false ||
        (status.stage === 'idle' && (job.seenRunning || job.disconnected))) {
        // The updater can rebuild itself and lose its in-memory task record.
        // Reconnected + matching commits does not prove a successful deployment.
        finishUnconfirmed();
      }
    }
    if (job) {
      if (now() - job.since >= WAIT_LIMIT) finishUnconfirmed();
      else poll();
    }
  }

  function refresh(check = false) {
    if (disposed) return Promise.resolve();
    if (request) return request;
    cancel(timer);
    emit({ checking: check, ...(check ? { actionError: '' } : {}) });
    request = (async () => {
      try {
        const status = await api.systemStatus(check);
        if (disposed) return;
        if (!isSystemStatus(status)) throw new Error(status?.error || '暂时无法读取更新状态，请稍后重试。');
        applyStatus(status);
      } catch (error) {
        if (disposed) return;
        emit({ connectionError: error.message || '暂时无法连接更新服务。' });
        if (job) {
          job.disconnected = true;
          if (now() - job.since >= WAIT_LIMIT) finishUnconfirmed();
          else poll();
        }
      } finally {
        request = null;
        emit({ loading: false, checking: false });
      }
    })();
    return request;
  }

  async function run(kind) {
    if (disposed || request || view.pending || view.status?.running || view.loading || view.connectionError) return;
    if (kind === 'update' ? !canDeploy(view.status) :
      !view.status?.enabled || view.status.workspaceOk === false) return;
    cancel(timer);
    job = { kind, baseline: view.status?.startedAt, since: now(), seenRunning: false, disconnected: false };
    emit({ pending: kind, actionError: '', unconfirmed: false });
    try {
      const result = await (kind === 'update' ? api.systemUpdate() : api.systemRestart());
      if (disposed) return;
      if (result?.accepted !== true) {
        job = null;
        emit({ pending: null, actionError: result?.message || '操作未被接受，请重新检查状态。' });
      }
    } catch (error) {
      if (disposed) return;
      if (error.status && error.status < 500) {
        job = null;
        emit({ pending: null, actionError: error.message || '操作未被接受。' });
      } else {
        // The command may have reached the server before its response was lost.
        job.disconnected = true;
        emit({ connectionError: '启动响应暂未收到，正在核对服务器状态。' });
      }
    }
    // Also recover a task started from another browser after a 409 rejection.
    if (!disposed) await refresh(false);
  }

  return {
    getSnapshot: () => view,
    async start() {
      await refresh(false);
      if (!disposed && view.status?.enabled && !view.pending && !view.connectionError) await refresh(true);
    },
    check: () => refresh(!view.pending),
    run,
    dispose() { disposed = true; cancel(timer); },
  };
}
