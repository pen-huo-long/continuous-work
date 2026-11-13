export const POLICY_KEY = 'codex-work/v1';
export const PROVIDER = 'openai-codex';
export const MAX_PROBES = 48;
export const HOUR = 3_600_000;
export const MAX_DATE_MS = 8_640_000_000_000_000;

export function parseInput(input = '') {
  const parts = input.trim().split(/\s+/u);
  const action = parts[0] || 'status';
  if (action === 'start' || action === 'update') {
    const windows = Number(parts[1] ?? 3);
    const hours = Number(parts[2] ?? 18);
    if ((action === 'update' && parts.length !== 3) || parts.length > 3 || !Number.isSafeInteger(windows) || windows < 1 ||
        !Number.isFinite(hours) || hours <= 0) {
      throw new Error(`用法：/codex-work ${action} [正安全整数窗口数] [正有限小时数，可小数]`);
    }
    return { action, windows, hours };
  }
  if (!['status', 'stop', 'retry'].includes(action) || parts.length > 1) {
    throw new Error('用法：/codex-work start 3 18 | update <窗口数> <总小时数> | retry | status | stop');
  }
  return { action };
}

// Millisecond timestamps must be representable both as safe integers and Dates.
// Round up fractional milliseconds so a positive duration cannot expire early.
export function deadlineFor(startedAt, hours) {
  const deadlineAt = Math.ceil(startedAt + hours * HOUR);
  if (!Number.isFinite(hours) || hours <= 0 || !Number.isSafeInteger(startedAt) ||
      Math.abs(startedAt) > MAX_DATE_MS || !Number.isSafeInteger(deadlineAt) ||
      Math.abs(deadlineAt) > MAX_DATE_MS || deadlineAt <= startedAt) {
    throw new Error('运行时限无法安全表示为有效截止日期，请调整小时数。');
  }
  return deadlineAt;
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
  return { run: null, pending: {}, skipBefore: inheritedEventCount };
}

export function isActive(run) {
  return run != null && ['armed', 'running', 'waiting', 'retrying'].includes(run.phase);
}

export function updateError(run, input, time) {
  if (!isActive(run) || time >= run.deadlineAt) return '当前没有可更新的活动托管，请先启用。';
  const minWindows = run.window + (run.pendingRecovery ? 1 : 0);
  if (input.windows < minWindows) return run.pendingRecovery ?
    `窗口上限至少为 ${minWindows}，需保留当前等待恢复的下一窗口。` : '窗口上限不能小于当前已使用窗口数。';
  let deadlineAt;
  try { deadlineAt = deadlineFor(run.startedAt, input.hours); } catch (error) { return error.message; }
  if (deadlineAt <= time) return '新的总时限已到期，请增加运行小时数。';
  return null;
}

// Only existing standard events are used, so session readers and migrations
// do not need to understand a new event type. Command success commits arming.
export function reduceState(state, event) {
  if (event.seq < state.skipBefore) return state;
  const data = event.data;
  if (event.type === 'command/run' && data.name === 'codex-work') {
    let input;
    try { input = parseInput(data.args); } catch { return state; }
    if (input.action === 'status') return state;
    return { ...state, pending: { ...state.pending, [data.commandId]: { ...input, time: event.time } } };
  }
  if (event.type === 'command/done' && state.pending[data.commandId]) {
    const operation = state.pending[data.commandId];
    const pending = { ...state.pending };
    delete pending[data.commandId];
    if (data.kind !== 'success') return { ...state, pending };
    if (operation.action === 'retry') return { ...state, pending };
    if (operation.action === 'update') {
      if (updateError(state.run, operation, event.time)) return { ...state, pending };
      return { ...state, pending, run: { ...state.run,
        maxWindows: operation.windows, deadlineAt: deadlineFor(state.run.startedAt, operation.hours) } };
    }
    if (operation.action === 'stop') return { ...state, pending, run: state.run ? { ...state.run, phase: 'stopped', nextRetryAt: null } : null };
    let deadlineAt;
    try { deadlineAt = deadlineFor(operation.time, operation.hours); } catch { return { ...state, pending }; }
    return { ...state, pending, run: {
      id: data.commandId, phase: 'armed', startedAt: operation.time,
      deadlineAt, maxWindows: operation.windows,
      window: 1, attempts: 0, pendingRecovery: false, nextRetryAt: null,
      turn: null, step: null, retryId: null,
    } };
  }
  const run = state.run;
  if (!isActive(run)) return state;
  const update = (patch) => ({ ...state, run: { ...run, ...patch } });
  if (event.type === 'llm/retry' && data.policyKey === POLICY_KEY) {
    return update({ phase: 'waiting', attempts: data.retry, pendingRecovery: true,
      nextRetryAt: event.time + data.delayMs, turn: data.turn, step: data.step, retryId: data.retryId });
  }
  if (event.type === 'llm/retry-started' && run.phase === 'waiting' && data.retryId === run.retryId) {
    return update({ phase: 'retrying', nextRetryAt: null });
  }
  if (event.type === 'assistant/message' && !data.interrupted) {
    const failedFinish = data.stream?.some((record) => record.type === 'chunk' && record.chunk?.type === 'finish' &&
      ['error', 'aborted'].includes(record.chunk.reason.kind));
    if (failedFinish || (run.pendingRecovery && (data.turn !== run.turn || data.step !== run.step))) return state;
    return update({ phase: 'running', window: run.window + (run.pendingRecovery ? 1 : 0),
      attempts: 0, pendingRecovery: false, nextRetryAt: null, retryId: null });
  }
  if (event.type === 'turn/end' && data.reason.kind === 'completed') return update({ phase: 'armed' });
  if (event.type === 'turn/end' && data.reason.kind !== 'completed') {
    const reason = data.reason.reason?.reason ?? '';
    const phase = reason === 'codex-work:deadline' ? 'expired' :
      reason === 'codex-work:budget' ? 'exhausted' : 'interrupted';
    return update({ phase, nextRetryAt: null });
  }
  // A normal turn may be followed by the existing goal driver. Do not wake it
  // ourselves and do not equate a model's final answer with goal completion.
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
