import test from 'node:test';
import assert from 'node:assert/strict';
import { HOUR, POLICY_KEY, initialState, reduceState } from '../core.js';

// Synthetic standard Session records follow the v1.4.3 persisted event shapes.
// No live Session logs, provider calls, Host services, or UI mocks are used.
const BASE_TIME = Date.parse('2026-11-13T06:00:00Z');

function history(skipBefore = 0) {
  let state = initialState({}, skipBefore);
  let time = BASE_TIME;
  let commandSequence = 0;
  const events = [];
  const append = (type, data, elapsed = 1000) => {
    time += elapsed;
    const event = { seq: events.length, time, type, data };
    events.push(event);
    state = reduceState(state, event);
    return event;
  };
  const command = (args, kind = 'success') => {
    const commandId = `command-${++commandSequence}`;
    append('command/run', { commandId, name: 'codex-work', args });
    append('command/done', { commandId, kind, text: 'Synthetic persisted command result.' });
    return commandId;
  };
  return { append, command, events, get state() { return state; } };
}

function schedule(log, retryId, overrides = {}) {
  return log.append('llm/retry', { retryId, turn: log.state.turn, step: 2,
    provider: 'magpie-responses', mode: 'normal', policyKey: POLICY_KEY,
    retry: 1, maxRetries: 48, delayMs: 60_000,
    failure: { code: 'QUOTA', message: 'usage_limit_reached' }, ...overrides });
}

function started(log, retryId, overrides = {}) {
  return log.append('llm/retry-started', { retryId, turn: log.state.turn, step: 2, retry: 1, ...overrides });
}

function response(log, overrides = {}) {
  return log.append('assistant/message', { turn: log.state.turn, step: 2,
    message: { source: { provider: 'magpie-responses' } }, ...overrides });
}

function end(log, turn, reason = { kind: 'completed' }, elapsed = 1000) {
  return log.append('turn/end', { turn, reason }, elapsed);
}

test('legacy start remembers an already open turn and begins with zero waits', () => {
  const log = history();
  assert.equal(log.state.turn, null);
  log.append('turn/start', { turn: 7 });
  assert.equal(log.state.turn, 7);
  assert.equal(log.state.run, null);
  const commandId = log.command(' start 3 18');
  assert.equal(log.state.run.id, commandId);
  assert.equal(log.state.run.enabled, true);
  assert.equal(log.state.run.turn, 7);
  assert.equal(log.state.run.window, 0);
  assert.equal(log.state.run.maxWindows, 3);
  assert.equal('deadlineAt' in log.state.run, false);
  assert.equal('hours' in log.state.run, false);
});

test('start and stop replay only on successful matching command completion', () => {
  const log = history();
  log.append('turn/start', { turn: 1 });
  log.command(' start 3 18', 'error');
  assert.equal(log.state.run, null);
  log.append('command/run', { commandId: 'enable', name: 'codex-work', args: ' start 3 18' });
  assert.equal(log.state.run, null);
  log.append('command/done', { commandId: 'other-command', kind: 'success' });
  assert.equal(log.state.run, null);
  log.append('command/done', { commandId: 'enable', kind: 'success' });
  assert.equal(log.state.run.enabled, true);
  log.command(' stop', 'error');
  assert.equal(log.state.run.enabled, true);
  log.append('command/run', { commandId: 'disable', name: 'codex-work', args: ' stop' });
  assert.equal(log.state.run.enabled, true);
  log.append('command/done', { commandId: 'disable', kind: 'success' });
  assert.equal(log.state.run.enabled, false);
  assert.equal(log.state.pending.disable, undefined);
});

test('legacy update accepts the old hours argument without creating a deadline', () => {
  const log = history();
  log.append('turn/start', { turn: 3 });
  log.command(' start 3 18');
  schedule(log, 'wait-1');
  const before = structuredClone(log.state.run);
  log.append('command/run', { commandId: 'limits', name: 'codex-work', args: ' update 4 24' });
  assert.deepEqual(log.state.run, before);
  log.append('command/done', { commandId: 'limits', kind: 'success' });
  assert.equal(log.state.run.maxWindows, 4);
  assert.equal(log.state.run.window, 1);
  assert.equal(log.state.run.retryId, before.retryId);
  assert.equal(log.state.run.nextRetryAt, before.nextRetryAt);
  assert.equal(log.state.run.id, before.id);
  assert.equal('deadlineAt' in log.state.run, false);
  log.command(' update 7 48', 'error');
  assert.equal(log.state.run.maxWindows, 4);
});

test('waits are counted when a new retry is scheduled, not on successful replies', () => {
  const log = history();
  log.append('turn/start', { turn: 4 });
  log.command(' start 4 18');
  const first = schedule(log, 'wait-1');
  assert.equal(log.state.run.window, 1);
  const extension = schedule(log, 'wait-1', { delayMs: 120_000 });
  assert.equal(log.state.run.window, 1);
  assert.equal(log.state.run.nextRetryAt, extension.time + extension.data.delayMs);
  assert.ok(log.state.run.nextRetryAt > first.time + first.data.delayMs);
  started(log, 'wait-1');
  response(log);
  assert.equal(log.state.run.window, 1);
  // v1.4.3 restarted this ordinal after each successful recovery; v8 counts
  // distinct waits across the whole turn rather than copying that old ordinal.
  schedule(log, 'wait-2', { retry: 1, step: 5 });
  assert.equal(log.state.run.window, 2);
  schedule(log, 'wait-2', { retry: 1, step: 5, delayMs: 180_000 });
  assert.equal(log.state.run.window, 2);
  started(log, 'wait-2', { retry: 1, step: 5 });
  response(log, { step: 5 });
  assert.equal(log.state.run.window, 2);
  assert.equal(log.state.run.attempts, 2);
});

test('rescheduling a completed retry cannot replace a later wait or count again', () => {
  const log = history();
  log.append('turn/start', { turn: 4 });
  log.command(' start 4 18');
  schedule(log, 'completed-wait');
  started(log, 'completed-wait');
  response(log);
  schedule(log, 'current-wait', { retry: 2, step: 5 });
  const before = structuredClone(log.state);
  schedule(log, 'completed-wait', { delayMs: 240_000 });
  started(log, 'completed-wait');
  assert.deepEqual(log.state, before);
  assert.equal(log.state.run.window, 2);
  assert.equal(log.state.run.retryId, 'current-wait');
});

test('new turns reset their wait budget while preserving the enabled switch and run identity', () => {
  const log = history();
  log.append('turn/start', { turn: 11 });
  log.command(' start 3 18');
  const runId = log.state.run.id;
  schedule(log, 'wait-1');
  schedule(log, 'wait-2', { retry: 2 });
  end(log, 11);
  assert.equal(log.state.turn, null);
  assert.equal(log.state.run.enabled, true);
  assert.equal(log.state.run.window, 2);
  log.append('turn/start', { turn: 12 });
  assert.equal(log.state.turn, 12);
  assert.equal(log.state.run.turn, 12);
  assert.equal(log.state.run.id, runId);
  assert.equal(log.state.run.enabled, true);
  assert.equal(log.state.run.window, 0);
  assert.equal(log.state.run.attempts, 0);
  assert.deepEqual(log.state.run.retryIds, []);
  assert.equal(log.state.run.pendingRecovery, false);
  assert.equal(log.state.run.nextRetryAt, null);
  assert.equal(log.state.run.retryId, null);
  assert.equal(log.state.run.step, null);
  // Deduplication belongs to the turn: a reused identifier in a new turn counts.
  schedule(log, 'wait-1');
  assert.equal(log.state.run.window, 1);
});

test('legacy deadline and budget turn endings do not permanently disable later turns', () => {
  for (const reason of ['deadline', 'budget', 'unloaded']) {
    const log = history();
    log.append('turn/start', { turn: 8 });
    log.command(' start 3 18');
    schedule(log, 'old-wait');
    end(log, 8, { kind: 'aborted', reason: { kind: 'hook', reason: `codex-work:${reason}` } }, 48 * HOUR);
    assert.equal(log.state.run.enabled, true, reason);
    assert.equal(log.state.turn, null);
    assert.equal(log.state.run.pendingRecovery, false);
    assert.equal(log.state.run.nextRetryAt, null);
    log.append('turn/start', { turn: 9 });
    assert.equal(log.state.run.enabled, true, reason);
    assert.equal(log.state.run.window, 0);
    schedule(log, 'new-wait');
    assert.equal(log.state.run.window, 1);
  }
});

test('fork cutoff excludes inherited authorization, limits, retries, and turn boundaries', () => {
  const log = history(5);
  log.append('turn/start', { turn: 1 });
  log.command(' start 3 18');
  schedule(log, 'parent-wait', { turn: 1 });
  end(log, 1);
  assert.equal(log.events.length, 5);
  assert.equal(log.state.run, null);
  assert.equal(log.state.turn, null);
  log.append('turn/start', { turn: 2 });
  assert.equal(log.state.turn, 2);
  assert.equal(log.state.run, null);
  log.command(' start 4 24');
  assert.equal(log.state.run.enabled, true);
  assert.equal(log.state.run.maxWindows, 4);
  assert.equal(log.state.run.window, 0);
  assert.equal(log.state.run.turn, 2);
});

test('forking after command/run does not let a later inherited completion authorize the child', () => {
  const log = history(2);
  log.append('turn/start', { turn: 1 });
  log.append('command/run', { commandId: 'parent-enable', name: 'codex-work', args: ' start 3 18' });
  log.append('command/done', { commandId: 'parent-enable', kind: 'success' });
  assert.equal(log.state.run, null);
  assert.deepEqual(log.state.pending, {});
  log.append('turn/start', { turn: 2 });
  log.command(' start 3 18');
  assert.equal(log.state.run.enabled, true);
  assert.notEqual(log.state.run.id, 'parent-enable');
});

test('quota records before enable and while disabled do not retroactively consume a budget', () => {
  const log = history();
  log.append('turn/start', { turn: 2 });
  schedule(log, 'before-enable');
  started(log, 'before-enable');
  assert.equal(log.state.run, null);
  log.command(' start 3 18');
  assert.equal(log.state.run.window, 0);
  log.command(' stop');
  const before = structuredClone(log.state.run);
  schedule(log, 'while-disabled');
  assert.deepEqual(log.state.run, before);
  log.command(' start 3 18');
  assert.equal(log.state.run.enabled, true);
  assert.equal(log.state.run.window, 0);
  assert.equal(log.state.run.pendingRecovery, false);
});

test('disabled replay preserves the scheduled wait until its original retry starts', () => {
  const log = history();
  log.append('turn/start', { turn: 6 });
  log.command(' start 3 18');
  schedule(log, 'wait-before-stop');
  const waiting = structuredClone(log.state.run);
  log.command(' stop');
  assert.equal(log.state.run.enabled, false);
  assert.equal(log.state.run.phase, 'waiting');
  assert.equal(log.state.run.pendingRecovery, true);
  assert.equal(log.state.run.nextRetryAt, waiting.nextRetryAt);
  assert.equal(log.state.run.retryId, waiting.retryId);
  assert.equal(log.state.run.window, 1);
  const cold = log.events.reduce(reduceState, initialState());
  assert.deepEqual(cold, log.state);
  started(log, 'wait-before-stop');
  assert.equal(log.state.run.enabled, false);
  assert.equal(log.state.run.phase, 'stopped');
  assert.equal(log.state.run.pendingRecovery, false);
  assert.equal(log.state.run.nextRetryAt, null);
  assert.equal(log.state.run.retryId, null);
  assert.equal(log.state.run.window, 1);
  response(log);
  assert.equal(log.state.run.enabled, false);
  assert.equal(log.state.run.phase, 'stopped');
  assert.equal(log.state.run.window, 1);
});

test('stop then start in the same turn preserves the old wait without counting it twice', () => {
  const log = history();
  log.append('turn/start', { turn: 5 });
  log.command(' start 3 18');
  schedule(log, 'old-wait');
  const before = structuredClone(log.state.run);
  log.command(' stop');
  log.command(' start 4 24');
  assert.equal(log.state.run.id, before.id);
  assert.equal(log.state.run.startedAt, before.startedAt);
  assert.equal(log.state.run.enabled, true);
  assert.equal(log.state.run.maxWindows, 4);
  for (const key of ['window', 'attempts', 'pendingRecovery', 'nextRetryAt', 'turn', 'step', 'retryId']) {
    assert.equal(log.state.run[key], before[key], key);
  }
  assert.deepEqual(log.state.run.retryIds, before.retryIds);
  started(log, 'old-wait');
  assert.equal(log.state.run.enabled, true);
  assert.equal(log.state.run.window, 1);
  assert.equal(log.state.run.phase, 'retrying');
  response(log);
  assert.equal(log.state.run.window, 1);
});

test('old retry-started cannot revive a disabled state or clear a later turn wait', () => {
  const log = history();
  log.append('turn/start', { turn: 20 });
  log.command(' start 3 18');
  schedule(log, 'old-turn-wait');
  log.command(' stop');
  end(log, 20);
  log.append('turn/start', { turn: 21 });
  assert.equal(log.state.run.enabled, false);
  started(log, 'old-turn-wait', { turn: 20 });
  assert.equal(log.state.run.enabled, false);
  assert.equal(log.state.run.window, 0);
  log.command(' start 3 18');
  schedule(log, 'new-turn-wait');
  const before = structuredClone(log.state);
  started(log, 'old-turn-wait', { turn: 20 });
  response(log, { turn: 20 });
  assert.deepEqual(log.state, before);
});

test('foreign policies, other turn records and unrelated commands cannot alter a current wait', () => {
  const log = history();
  log.append('turn/start', { turn: 30 });
  log.command(' start 3 18');
  schedule(log, 'current-wait');
  const before = structuredClone(log.state);
  schedule(log, 'builtin-wait', { policyKey: 'builtin-policy', retry: 99 });
  schedule(log, 'old-wait', { turn: 29, retry: 99 });
  started(log, 'current-wait', { turn: 29 });
  started(log, 'other-id');
  response(log, { interrupted: true });
  response(log, { step: 99 });
  log.append('command/run', { commandId: 'unrelated', name: 'another-command', args: ' stop' });
  log.append('command/done', { commandId: 'unrelated', kind: 'success' });
  log.append('user/message', { content: 'Synthetic unrelated input.' });
  log.append('tool/result', { value: 'Synthetic unrelated result.' });
  assert.deepEqual(log.state, before);
});

test('cold replay and incremental folding agree across legacy history, toggles and new turns', () => {
  const log = history();
  log.append('turn/start', { turn: 40 });
  log.command(' start 3 18');
  schedule(log, 'wait-1');
  schedule(log, 'wait-1', { delayMs: 120_000 });
  log.command(' stop');
  log.command(' start 4 24');
  started(log, 'wait-1');
  response(log);
  log.command(' update 5 48');
  end(log, 40, { kind: 'aborted', reason: { kind: 'hook', reason: 'codex-work:budget' } });
  log.append('turn/start', { turn: 41 });
  schedule(log, 'wait-2');
  log.command(' stop');
  const saved = structuredClone(log.events);
  const replayed = saved.reduce(reduceState, initialState());
  assert.deepEqual(replayed, log.state);
  assert.deepEqual(saved, log.events);
  assert.equal(replayed.run.enabled, false);
  assert.equal(replayed.run.window, 1);
  assert.equal(replayed.run.maxWindows, 5);
  assert.equal(replayed.run.pendingRecovery, true);
});
