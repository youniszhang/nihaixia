import test from 'node:test';
import assert from 'node:assert/strict';
import { canDeploy, createSystemUpdater, isSystemStatus } from './systemUpdate.js';

const idle = { enabled: true, running: false, stage: 'idle', ok: null, workspaceOk: true, localCommit: 'aaa1111', remoteCommit: 'bbb2222', updateAvailable: true };
const active = { ...idle, running: true, stage: 'build', startedAt: '2026-11-25T01:00:00Z' };
const done = { ...active, running: false, stage: 'done', ok: true, finishedAt: '2026-11-25T01:01:00Z', localCommit: 'bbb2222', updateAvailable: false };

function fixture(initial = [idle, idle], command = { accepted: true }) {
  const queue = [...initial];
  const timers = new Map();
  const calls = { statuses: [], updates: 0, restarts: 0, changes: 0 };
  let clock = 0;
  let id = 0;
  const updater = createSystemUpdater({
    api: {
      async systemStatus(check) {
        calls.statuses.push(check);
        assert.ok(queue.length, 'unexpected status request');
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      async systemUpdate() { calls.updates++; if (command instanceof Error) throw command; return command; },
      async systemRestart() { calls.restarts++; if (command instanceof Error) throw command; return command; },
    },
    onChange() { calls.changes++; },
    now: () => clock,
    schedule(fn) { timers.set(++id, fn); return id; },
    cancel(key) { timers.delete(key); },
  });
  return {
    updater, calls, queue, timers,
    view: () => updater.getSnapshot(),
    async tick(ms = 4000) {
      clock += ms;
      const entry = timers.entries().next().value;
      assert.ok(entry, 'expected a scheduled status retry');
      timers.delete(entry[0]);
      await entry[1]();
    },
  };
}

test('only a fresh successful version check enables deployment', () => {
  assert.equal(canDeploy(idle), true);
  for (const change of [{ running: true }, { enabled: false }, { workspaceOk: false }, { checkError: 'fetch failed' }, { error: 'offline' }, { updateAvailable: null }, { updateAvailable: false }]) {
    assert.equal(canDeploy({ ...idle, ...change }), false);
  }
  assert.equal(isSystemStatus({ enabled: true, error: 'updater offline' }), false);
  assert.equal(isSystemStatus({ enabled: true }), false);
});

test('loads local state first, then checks the remote once', async () => {
  const f = fixture();
  await f.updater.start();
  assert.deepEqual(f.calls.statuses, [false, true]);
  assert.equal(f.view().loading, false);
  assert.equal(f.timers.size, 0);
});

test('does not try to check a disabled updater', async () => {
  const f = fixture([{ enabled: false }]);
  await f.updater.start();
  assert.deepEqual(f.calls.statuses, [false]);
  await f.updater.run('restart');
  assert.equal(f.calls.restarts, 0);
});

test('resumes an existing deployment without triggering git fetch', async () => {
  const f = fixture([active]);
  await f.updater.start();
  assert.deepEqual(f.calls.statuses, [false]);
  assert.equal(f.view().pending, 'maintenance');
  assert.equal(f.timers.size, 1);
});

test('network errors and HTTP 200 error payloads keep polling until a terminal result', async () => {
  const f = fixture();
  await f.updater.start();
  f.queue.push(active, new Error('offline'), { enabled: true, error: 'updater rebuilding' }, done);
  await f.updater.run('update');
  await f.tick();
  assert.equal(f.view().pending, 'update');
  assert.equal(f.view().status, active);
  await f.tick();
  assert.equal(f.view().pending, 'update');
  assert.equal(f.timers.size, 1);
  await f.tick();
  assert.equal(f.view().pending, null);
  assert.equal(f.view().status.ok, true);
  assert.equal(f.view().connectionError, '');
  assert.equal(f.timers.size, 0);
});

test('locks actions immediately, even before the command responds', async () => {
  const f = fixture();
  await f.updater.start();
  f.queue.push(active);
  const first = f.updater.run('update');
  await f.updater.run('update');
  await f.updater.run('restart');
  await first;
  assert.equal(f.calls.updates, 1);
  assert.equal(f.calls.restarts, 0);
});

test('ignores an old completed task while a new deployment starts', async () => {
  const previous = { ...done, startedAt: 'old', updateAvailable: true };
  const f = fixture([previous, previous]);
  await f.updater.start();
  f.queue.push(previous, active, done);
  await f.updater.run('update');
  assert.equal(f.view().pending, 'update');
  await f.tick();
  await f.tick();
  assert.equal(f.view().pending, null);
  assert.equal(f.view().status.startedAt, active.startedAt);
});

test('matching commits after updater reset do not imply deployment success', async () => {
  const f = fixture([active]);
  await f.updater.start();
  f.queue.push({ ...idle, localCommit: idle.remoteCommit, updateAvailable: false });
  await f.tick();
  assert.equal(f.view().unconfirmed, true);
  assert.equal(f.view().pending, null);
  assert.equal(f.view().status.ok, null);
  assert.equal(f.timers.size, 0);
});

test('a lost command response is reconciled instead of allowing another deployment', async () => {
  const f = fixture([idle, idle], new Error('connection closed'));
  await f.updater.start();
  f.queue.push(active, done);
  await f.updater.run('update');
  assert.equal(f.view().pending, 'update');
  await f.tick();
  assert.equal(f.view().status.ok, true);
});

test('accepted:false is shown as rejection and never as successful startup', async () => {
  const f = fixture([idle, idle], { accepted: false, message: '部署被拒绝' });
  await f.updater.start();
  f.queue.push(idle);
  await f.updater.run('update');
  assert.equal(f.view().actionError, '部署被拒绝');
  assert.equal(f.view().pending, null);
  assert.equal(f.timers.size, 0);
});

test('an existing task is recovered after a command conflict', async () => {
  const error = Object.assign(new Error('已有任务在运行'), { status: 409 });
  const f = fixture([idle, idle], error);
  await f.updater.start();
  f.queue.push(active);
  await f.updater.run('update');
  assert.equal(f.view().pending, 'maintenance');
  assert.equal(f.view().actionError, '');
  assert.equal(f.timers.size, 1);
});

test('failed deployments stop polling and retain their failure details', async () => {
  const f = fixture([active]);
  await f.updater.start();
  f.queue.push({ ...done, ok: false, stage: 'failed', message: 'build failed' });
  await f.tick();
  assert.equal(f.view().pending, null);
  assert.equal(f.view().status.message, 'build failed');
  assert.equal(f.timers.size, 0);
});

test('a failed build with synchronized code can be rebuilt through restart', async () => {
  const failed = { ...done, ok: false, stage: 'failed' };
  const f = fixture([failed, failed]);
  await f.updater.start();
  assert.equal(canDeploy(failed), false);
  f.queue.push({ ...active, startedAt: 'new-restart' }, { ...done, startedAt: 'new-restart' });
  await f.updater.run('restart');
  assert.equal(f.calls.restarts, 1);
  assert.equal(f.calls.updates, 0);
  assert.equal(f.view().pending, 'restart');
  await f.tick();
  assert.equal(f.view().pending, null);
  assert.equal(f.view().status.ok, true);
});

test('manual status retry resumes polling after a long-running task needs confirmation', async () => {
  const f = fixture([active]);
  await f.updater.start();
  f.queue.push(active, active);
  await f.tick(10 * 60 * 1000);
  assert.equal(f.view().unconfirmed, true);
  assert.equal(f.timers.size, 0);
  await f.updater.run('restart');
  assert.equal(f.calls.restarts, 0);
  await f.updater.check();
  assert.equal(f.view().unconfirmed, false);
  assert.equal(f.view().pending, 'maintenance');
  assert.equal(f.timers.size, 1);
});

test('a long disconnection reports an unconfirmed outcome, never success', async () => {
  const f = fixture([active]);
  await f.updater.start();
  f.queue.push(new Error('still offline'));
  await f.tick(10 * 60 * 1000);
  assert.equal(f.view().unconfirmed, true);
  assert.equal(f.view().pending, null);
  assert.equal(f.timers.size, 0);
});

test('dispose cancels polling and late responses cannot update the view', async () => {
  const f = fixture([active]);
  await f.updater.start();
  f.updater.dispose();
  assert.equal(f.timers.size, 0);
  const changes = f.calls.changes;
  await f.updater.check();
  assert.equal(f.calls.changes, changes);

  let resolve;
  let emissions = 0;
  const updater = createSystemUpdater({ api: { systemStatus: () => new Promise((r) => { resolve = r; }) }, onChange: () => { emissions++; } });
  const pending = updater.start();
  updater.dispose();
  const before = emissions;
  resolve(idle);
  await pending;
  assert.equal(emissions, before);
});
