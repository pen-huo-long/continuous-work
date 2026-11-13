export const POLICY_KEY = 'codex-work/v1';
export const PROVIDER = 'openai-codex';
export const HOUR = 3_600_000;
export const MAX_DATE_MS = 8_640_000_000_000_000;

export function parseInput(input = '') {
  const parts = input.trim().split(/\s+/u);
  const action = parts[0] || 'status';
  if (action === 'start' || action === 'update') {
    const windows = Number(parts[1] ?? 3);
    if ((action === 'update' && parts.length !== 2) || parts.length > 2 ||
        !Number.isSafeInteger(windows) || windows < 1) {
      throw new Error(`用法：/codex-work ${action} [每轮最大等待次数，正安全整数]`);
    }
    return { action, windows };
  }
  if (!['status', 'stop', 'retry'].includes(action) || parts.length > 1) {
    throw new Error('用法：/codex-work start [等待次数=3] | update <等待次数> | retry | status | stop');
  }
  return { action };
}

// Only historical command records accept the removed wall-clock argument.
function replayInput(input = '') {
  const parts = input.trim().split(/\s+/u);
  if (['start', 'update'].includes(parts[0]) && parts.length === 3) {
    const hours = Number(parts[2]);
    if (!Number.isFinite(hours) || hours <= 0) throw new Error('Invalid historical time limit');
    return parseInput(parts.slice(0, 2).join(' '));
  }
  return parseInput(input);
}

// Evidence, not provider identity, decides quota recovery. DSH normalizes
// quota-class failures from every adapter to code "QUOTA"; the native Codex
// transport loses the code behind an English friendly message, and ZCode
// reports a windowed limit as a 429 with a Chinese message and an absolute
// reset time. Plain short 429s stay with the built-in retry.
const WINDOWED_LIMIT = /已达到.{0,10}小时.{0,6}上限|you have hit your ChatGPT usage limit|usage[_ -]limit[_ -]reached/iu;
const RESET_AT = /(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/u;
const RESET_CLOCK = /\bbefore\s+(\d{1,2}):(\d{2})\s+UTC([+-])(\d{1,2})(?::(\d{2}))?(?![\w:+-])/iu;

function resetBody(message) {
  const start = message.indexOf('{');
  if (start === -1) return null;
  try {
    // Parse the actual JSON body, never fields embedded inside its quoted message.
    const body = JSON.parse(message.slice(start));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if ('resets_at' in body || 'resets_in_seconds' in body) return body;
    const error = body.error;
    return error && typeof error === 'object' && !Array.isArray(error) ? error : null;
  } catch {
    return null;
  }
}

function resetDelay(delay, source) {
  return Number.isFinite(delay) && delay > 0 && delay <= 6 * HOUR ?
    { delayMs: delay + 30_000, source } : { delayMs: null, source: 'backoff' };
}

export function classifyQuota(_provider, failure, now = Date.now) {
  if (!failure || ['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL'].includes(failure.code)) return null;
  const message = failure.message ?? '';
  if (failure.code !== 'QUOTA' && !WINDOWED_LIMIT.test(message)) return null;
  const explicit = failure.providerRetryAfterMs;
  if (Number.isFinite(explicit) && explicit > 0) return { delayMs: explicit + 5_000, source: 'provider' };
  const currentTime = now();
  const body = resetBody(message);
  if (body && 'resets_at' in body) {
    // An explicit absolute reset owns the response. A stale/invalid absolute
    // value must not revive its cached relative seconds or roll text to tomorrow.
    if (!Number.isFinite(body.resets_at) || body.resets_at <= 0) return resetDelay(null, 'reset-at');
    return resetDelay(body.resets_at * 1000 - currentTime, 'reset-at');
  }
  if (body && 'resets_in_seconds' in body) {
    return resetDelay(Number.isFinite(body.resets_in_seconds) ? body.resets_in_seconds * 1000 : null, 'reset-seconds');
  }
  const minutes = /try again in\s*~?\s*(\d+(?:\.\d+)?)\s*min/iu.exec(message);
  if (minutes) return { delayMs: Number(minutes[1]) * 60_000 + 65_000, source: 'approximate' };
  const stamped = RESET_AT.exec(message);
  if (stamped) {
    const resetAt = new Date(Number(stamped[1]), Number(stamped[2]) - 1, Number(stamped[3]),
      Number(stamped[4]), Number(stamped[5]), stamped[6] ? Number(stamped[6]) : 0).getTime();
    // Complete dates are authoritative: expired dates cannot become a fresh
    // next-day clock-only reset from a secondary suffix in the same message.
    return resetDelay(resetAt - currentTime, 'reset-at');
  }
  const clock = RESET_CLOCK.exec(message);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    const zoneHours = Number(clock[4]);
    const zoneMinutes = Number(clock[5] ?? 0);
    if (hours > 23 || minutes > 59 || zoneHours > 23 || zoneMinutes > 59) return resetDelay(null, 'reset-clock');
    const offset = (zoneHours * 60 + zoneMinutes) * 60_000 * (clock[3] === '+' ? 1 : -1);
    const localNow = currentTime + offset;
    const localMidnight = Math.floor(localNow / (24 * HOUR)) * 24 * HOUR;
    let resetAt = localMidnight + hours * HOUR + minutes * 60_000 - offset;
    if (resetAt <= currentTime) resetAt += 24 * HOUR;
    return resetDelay(resetAt - currentTime, 'reset-clock');
  }
  return { delayMs: null, source: 'backoff' };
}

export function retryDelay(quota, attempt) {
  return quota.delayMs ?? Math.min(60_000 * 2 ** Math.min(attempt - 1, 8), 30 * 60_000);
}

export function initialState(_header, inheritedEventCount = 0) {
  return { run: null, pending: {}, skipBefore: inheritedEventCount, turn: null };
}

export function isActive(run) {
  return run?.enabled === true;
}

export function updateError(run) {
  return run ? null : '尚未设置托管，请先启用。';
}

// The enabled switch is session-persistent; only the per-turn counters reset.
export function reduceState(state, event) {
  if (event.seq < state.skipBefore) return state;
  const data = event.data;
  const run = state.run;
  const update = (patch) => ({ ...state, run: { ...run, ...patch } });
  if (event.type === 'turn/start') {
    return { ...state, turn: data.turn, run: run ? { ...run,
      phase: run.enabled ? 'armed' : 'stopped', window: 0, attempts: 0, retryIds: [],
      pendingRecovery: false, nextRetryAt: null, turn: data.turn, step: null, retryId: null } : null };
  }
  if (event.type === 'command/run' && data.name === 'codex-work') {
    let input;
    try { input = replayInput(data.args); } catch { return state; }
    if (input.action === 'status') return state;
    return { ...state, pending: { ...state.pending, [data.commandId]: { ...input, time: event.time } } };
  }
  if (event.type === 'command/done' && state.pending[data.commandId]) {
    const operation = state.pending[data.commandId];
    const pending = { ...state.pending };
    delete pending[data.commandId];
    if (data.kind !== 'success' || operation.action === 'retry') return { ...state, pending };
    if (operation.action === 'update') {
      if (updateError(run)) return { ...state, pending };
      return { ...state, pending, run: { ...run, maxWindows: operation.windows,
        phase: run.phase === 'exhausted' && run.window < operation.windows ? 'armed' : run.phase } };
    }
    if (operation.action === 'stop') {
      if (!run) return { ...state, pending };
      const waiting = run.phase === 'waiting' && run.nextRetryAt !== null;
      return { ...state, pending, run: { ...run, enabled: false,
        phase: waiting ? 'waiting' : 'stopped', pendingRecovery: waiting,
        nextRetryAt: waiting ? run.nextRetryAt : null, retryId: waiting ? run.retryId : null } };
    }
    if (run) return { ...state, pending, run: { ...run, enabled: true, maxWindows: operation.windows,
      phase: run.phase === 'waiting' ? 'waiting' : 'armed' } };
    return { ...state, pending, run: {
      id: data.commandId, enabled: true, phase: 'armed', startedAt: operation.time,
      maxWindows: operation.windows, window: 0, attempts: 0, retryIds: [],
      pendingRecovery: false, nextRetryAt: null, turn: state.turn, step: null, retryId: null,
    } };
  }
  if (event.type === 'turn/end') {
    if (state.turn !== null && data.turn !== state.turn) return state;
    return { ...state, turn: null, run: run ? { ...run, phase: run.enabled ? 'armed' : 'stopped',
      pendingRecovery: false, nextRetryAt: null, retryId: null, step: null } : null };
  }
  if (!run) return state;
  if (run.turn !== null && data.turn !== run.turn) return state;
  if (event.type === 'llm/retry' && data.policyKey === POLICY_KEY && run.enabled) {
    const fresh = !run.retryIds.includes(data.retryId);
    if (!fresh && (data.retryId !== run.retryId || run.phase !== 'waiting')) return state;
    return update({ phase: 'waiting', attempts: run.attempts + (fresh ? 1 : 0),
      window: run.window + (fresh ? 1 : 0), retryIds: fresh ? [...run.retryIds, data.retryId] : run.retryIds,
      pendingRecovery: true, nextRetryAt: event.time + data.delayMs,
      turn: data.turn, step: data.step, retryId: data.retryId });
  }
  if (event.type === 'llm/retry-started' && run.phase === 'waiting' && data.retryId === run.retryId && data.step === run.step) {
    return update({ phase: run.enabled ? 'retrying' : 'stopped', pendingRecovery: run.enabled,
      nextRetryAt: null, retryId: run.enabled ? run.retryId : null });
  }
  if (event.type === 'assistant/attempt' && run.enabled && run.window >= run.maxWindows) {
    const failure = data.stream?.find((record) => record.type === 'chunk' && record.chunk?.type === 'finish' &&
      ['error', 'aborted'].includes(record.chunk.reason.kind))?.chunk.reason.failure;
    if (classifyQuota('', failure, () => event.time)) {
      return update({ phase: 'exhausted', pendingRecovery: false, nextRetryAt: null, retryId: null });
    }
  }
  if (event.type === 'assistant/message' && !data.interrupted) {
    const failedFinish = data.stream?.some((record) => record.type === 'chunk' && record.chunk?.type === 'finish' &&
      ['error', 'aborted'].includes(record.chunk.reason.kind));
    if (failedFinish || (run.pendingRecovery && data.step !== run.step)) return state;
    return update({ phase: run.enabled ? 'running' : 'stopped',
      pendingRecovery: false, nextRetryAt: null, retryId: null });
  }
  return state;
}

export function waitUntil(deadline, signal, now = Date.now, timers = { setTimeout, clearTimeout }) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer;
    const finish = (ok) => {
      timers.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onAbort = () => finish(false);
    const check = () => {
      const remaining = deadline - now();
      if (remaining <= 0) finish(!signal.aborted);
      else timer = timers.setTimeout(check, Math.min(remaining, 60_000));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    check();
  });
}
