import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { POLICY_KEY, MAX_PROBES, initialState, reduceState,
  parseInput, isActive, updateError, deadlineFor, MAX_DATE_MS, classifyQuota, retryDelay, waitUntil } from './core.js';

export const name = 'continuous-work';
export const inject = ['agents', 'commands', 'tools', 'sessionProjections'];

const timestampSchema = z.number().int().min(-MAX_DATE_MS).max(MAX_DATE_MS);
const windowSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const runSchema = z.object({
  id: z.string(), phase: z.enum(['armed', 'running', 'waiting', 'retrying', 'stopped', 'expired', 'exhausted', 'interrupted']),
  startedAt: timestampSchema, deadlineAt: timestampSchema, maxWindows: windowSchema, window: windowSchema,
  attempts: z.number().int(), pendingRecovery: z.boolean(), nextRetryAt: z.number().nullable(),
  turn: z.number().nullable(), step: z.number().nullable(), retryId: z.string().nullable(),
});
const stateSchema = z.object({ skipBefore: z.number(), run: runSchema.nullable(), pending: z.record(z.string(), z.object({
  action: z.string(), windows: windowSchema.optional(), hours: z.number().positive().optional(), time: timestampSchema,
})) });

export async function apply(ctx, config = {}, internals = {}) {
  if (Object.keys(config).length) throw new Error('continuous-work: use /codex-work to configure each session');
  const now = internals.now ?? Date.now;
  const wait = internals.waitUntil ?? waitUntil;
  const timers = internals.timers ?? globalThis;
  const lifetime = new AbortController();
  const controls = new Map();
  const reservations = new Map();
  const manualRequests = new Map();
  const active = new Set();
  const cooldowns = new Map();
  const projection = await ctx.sessionProjections.register({
    key: 'codexContinuity', stateVersion: 7, stateSchema, init: initialState, apply: reduceState,
    wire: { summary: false, viewSchema: stateSchema, view: (state) => state },
  });
  const runOf = (agent) => projection.stateOf(agent.session).run;

  function cancel(agent, reason) {
    agent.cancel({ kind: 'hook', reason: `codex-work:${reason}` }, { keepInbox: true });
  }
  function clearManual(commandId) {
    const request = manualRequests.get(commandId);
    if (!request) return;
    request.signal.removeEventListener('abort', request.onAbort);
    manualRequests.delete(commandId);
    if (reservations.get(request.agentId) === commandId) reservations.delete(request.agentId);
  }
  function clearWaitRequests(waiter) {
    for (const [commandId, request] of manualRequests) {
      if (request.waiter === waiter) clearManual(commandId);
    }
  }
  function liveWait(agent, run, expected) {
    const control = controls.get(agent.id);
    const waiter = control?.waiter;
    if (!run || run.phase !== 'waiting' || now() >= run.deadlineAt || lifetime.signal.aborted ||
        control?.runId !== run.id || !control.waiting || !waiter || waiter.claimed ||
        waiter.signal.aborted || control.abort.signal.aborted || waiter.retryId !== run.retryId ||
        (expected && expected !== waiter)) return null;
    return waiter;
  }
  function release(id) {
    const control = controls.get(id);
    if (!control) return;
    timers.clearTimeout(control.timer);
    control.abort.abort();
    clearWaitRequests(control.waiter);
    controls.delete(id);
  }
  function ensureControl(agent, run) {
    const previous = controls.get(agent.id);
    let control = previous;
    if (previous?.runId !== run.id) {
      release(agent.id);
      control = { runId: run.id, agent, abort: new AbortController(), timer: null, waiting: false };
      controls.set(agent.id, control);
    }
    if (control.deadlineAt === run.deadlineAt) return control;
    timers.clearTimeout(control.timer);
    const deadlineAt = run.deadlineAt;
    control.deadlineAt = deadlineAt;
    // Node clamps delays above 2^31-1 to 1ms. Check absolute time in bounded
    // slices instead; sleeping, clock changes and limit updates keep the target.
    const check = () => {
      if (controls.get(agent.id) !== control || control.deadlineAt !== deadlineAt) return;
      const current = runOf(agent);
      if (!isActive(current) || current.id !== control.runId) { release(agent.id); return; }
      if (current.deadlineAt !== deadlineAt) { ensureControl(agent, current); return; }
      const remaining = deadlineAt - now();
      if (remaining <= 0) { cancel(agent, 'deadline'); release(agent.id); return; }
      control.timer = timers.setTimeout(check, Math.min(remaining, 60_000));
      control.timer.unref?.();
    };
    control.timer = timers.setTimeout(check, Math.max(0, Math.min(deadlineAt - now(), 60_000)));
    control.timer.unref?.();
    return control;
  }

  // Observe committed projection changes rather than scanning the Session log.
  // A reservation survives the handler's return until command/done commits.
  ctx.sessionProjections.onChanged((session, key, state, seq) => {
    if (key !== 'codexContinuity') return;
    const agent = ctx.agents.get(session.id);
    if (!agent) return;
    const committed = session.eventAt(seq);
    if (committed?.type === 'command/done') {
      const request = manualRequests.get(committed.data.commandId);
      if (request?.agentId === agent.id) {
        clearManual(committed.data.commandId);
        if (committed.data.kind === 'success' && !request.signal.aborted &&
            liveWait(agent, state.run, request.waiter)) {
          request.waiter.claimed = true;
          request.waiter.manual = true;
          request.waiter.abort.abort();
        }
      }
    }
    const reserved = reservations.get(agent.id);
    if (reserved && !state.pending[reserved]) reservations.delete(agent.id);
    if (isActive(state.run)) ensureControl(agent, state.run);
    else release(agent.id);
  });
  for (const agent of ctx.agents.list()) {
    const run = runOf(agent);
    if (isActive(run)) ensureControl(agent, run);
  }

  async function recover(payload, next) {
    const { agent, failure, provider, signal, turn, step } = payload;
    const quota = classifyQuota(provider, failure, now);
    const run = runOf(agent);
    if (!quota || !isActive(run)) return next();
    if (signal.aborted || lifetime.signal.aborted) return;
    if (now() >= run.deadlineAt) { cancel(agent, 'deadline'); return; }
    if (run.window >= run.maxWindows || run.attempts >= MAX_PROBES) { cancel(agent, 'budget'); return; }
    const control = ensureControl(agent, run);
    const fused = AbortSignal.any([signal, lifetime.signal, control.abort.signal]);
    const requestedAt = now() + retryDelay(quota, run.attempts + 1);
    const cooldown = cooldowns.get(provider) ?? { at: 0, ticket: 0 };
    if (requestedAt > cooldown.at) { cooldown.at = requestedAt; cooldown.ticket = 0; }
    cooldowns.set(provider, cooldown);
    const retryAt = cooldown.at + cooldown.ticket++ * 1_000;
    if (retryAt >= run.deadlineAt) { cancel(agent, 'deadline'); return; }
    const retryId = randomUUID();
    const retry = run.attempts + 1;
    const recordSchedule = (target) => agent.session.append('llm/retry', {
      retryId, turn, step, provider, mode: 'normal', policyKey: POLICY_KEY,
      retry, maxRetries: MAX_PROBES, delayMs: Math.max(0, target - now()), failure,
    });
    recordSchedule(retryAt);
    control.waiting = true;
    try {
      // A later failure on this provider can extend its shared cooldown. The
      // original wait is still logged; a new retry record describes extensions.
      let target = retryAt;
      while (true) {
        const waiter = { retryId, signal: fused, abort: new AbortController(), manual: false, claimed: false };
        const onAbort = () => waiter.abort.abort();
        control.waiter = waiter;
        fused.addEventListener('abort', onAbort, { once: true });
        if (fused.aborted) onAbort();
        let elapsed;
        try {
          // Manual wake aborts only this timer; the original recovery and Agent stay alive.
          elapsed = await wait(target, waiter.abort.signal, now);
        } finally {
          waiter.claimed = true;
          fused.removeEventListener('abort', onAbort);
          clearWaitRequests(waiter);
          if (control.waiter === waiter) control.waiter = null;
        }
        const current = runOf(agent);
        if ((!elapsed && !waiter.manual) || !isActive(current) || current.id !== run.id ||
            current.retryId !== retryId || fused.aborted) return;
        if (now() >= current.deadlineAt) { cancel(agent, 'deadline'); return; }
        if (!waiter.manual && cooldown.at > now()) {
          target = cooldown.at + cooldown.ticket++ * 1_000;
          if (target >= current.deadlineAt) { cancel(agent, 'deadline'); return; }
          // Same retry id and ordinal: update the countdown without spending
          // another probe or incrementing the quota-window counter.
          recordSchedule(target);
          continue;
        }
        agent.session.append('llm/retry-started', { retryId, turn, step, retry });
        return { kind: 'retry' };
      }
    } finally {
      control.waiting = false;
    }
  }

  function operate({ commandId, agent, rawInput, signal }) {
    signal.throwIfAborted();
    const input = parseInput(rawInput);
    const run = runOf(agent);
    if (input.action === 'status') {
      return { kind: 'success', text: run ?
        `额度托管：${isActive(run) && now() >= run.deadlineAt ? 'expired' : run.phase}；额度窗口 ${run.window}/${run.maxWindows}；截止 ${new Date(run.deadlineAt).toLocaleString('zh-CN')}` +
        (run.nextRetryAt ? `；预计重试 ${new Date(run.nextRetryAt).toLocaleString('zh-CN')}` : '') : '额度托管尚未启用。' };
    }
    if (reservations.has(agent.id)) return { kind: 'error', text: '托管状态正在更新，请稍后重试。' };
    if (input.action === 'retry') {
      const waiter = liveWait(agent, run);
      if (!waiter) return { kind: 'error', text: '当前没有可立即重试的活动额度等待。' };
      reservations.set(agent.id, commandId);
      const onAbort = () => clearManual(commandId);
      manualRequests.set(commandId, { agentId: agent.id, waiter, signal, onAbort });
      signal.addEventListener('abort', onAbort, { once: true });
      return { kind: 'success', text: '已请求立即重试当前步骤；额度仍不足时将继续自动等待。' };
    }
    if (input.action === 'stop') {
      reservations.set(agent.id, commandId);
      release(agent.id);
      if (isActive(run)) cancel(agent, 'stopped');
      return { kind: 'success', text: '已停止托管，当前执行已取消；不会自动续跑。' };
    }
    if (input.action === 'update') {
      const error = updateError(run, input, now());
      if (error) return { kind: 'error', text: error };
      reservations.set(agent.id, commandId);
      return { kind: 'success', text: `已更新额度托管：最多 ${input.windows} 个额度窗口，总时限 ${input.hours} 小时（从原启用时间计算）。` };
    }
    if (isActive(run) && now() < run.deadlineAt) return { kind: 'error', text: '当前已有托管运行，请先停止后再启用。' };
    deadlineFor(now(), input.hours);
    reservations.set(agent.id, commandId);
    return { kind: 'success', text: `已启用额度托管：最多 ${input.windows} 个额度窗口，最长 ${input.hours} 小时。额度恢复后重试原步骤；请保持 Harness 和机器运行。` };
  }

  ctx.commands.register({
    name: 'codex-work', description: '额度托管：限额后等待恢复并重试原步骤，适用于任何模型路由',
    input: { hint: 'start [正整数窗口数=3] [正小时数=18] | update <窗口数> <总小时数> | retry | status | stop' }, handler: operate,
  });
  ctx.tools.register({
    name: 'codex_work', description: 'Manage provider quota recovery in this session. Start bounded recovery after a usage-limit failure, update its limits, retry a live quota wait now, inspect status, or stop the current managed execution. Works for any model route. Cooldowns are isolated by provider and reported quota reset times are respected. It sends no continuation prompt and does not change permissions.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['start', 'update', 'retry', 'status', 'stop'], description: 'retry wakes only the current live quota wait, bypassing this wait without changing shared cooldowns or recovery budgets.' },
      windows: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: 'Positive safe-integer total quota windows. Start defaults to 3; update requires this value and preserves used windows plus the next window during pending recovery.' },
      hours: { type: 'number', exclusiveMinimum: 0, description: 'Positive finite total hours from the original start, including waits; fractions are allowed. Start defaults to 18; update requires this value and a future deadline. The deadline must fit a safe millisecond timestamp and a valid JavaScript Date.' },
    }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', properties: {
      kind: { type: 'string' }, text: { type: 'string' },
    }, required: ['kind'], additionalProperties: false },
    render: (_args, result) => [{ type: 'text', text: result.text ?? result.kind }] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('A session is required');
      const action = args?.action;
      if (action === 'update' && (args.windows === undefined || args.hours === undefined)) {
        throw new Error('update requires windows and hours');
      }
      const line = action === 'start' ? `start ${args.windows ?? 3} ${args.hours ?? 18}` :
        action === 'update' ? `update ${args.windows} ${args.hours}` : action;
      const result = await ctx.commands.execute(exec.agent, `/codex-work ${line}`, [], exec.signal);
      if (!result) throw new Error('codex-work command unavailable');
      return result.result;
    },
  });

  const disposeRecovery = ctx.on('agent/request-error', (payload, next) => {
    const operation = recover(payload, next);
    active.add(operation);
    operation.then(() => active.delete(operation), () => active.delete(operation));
    return operation;
  });
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const run = runOf(agent);
    if (isActive(run)) {
      if (now() >= run.deadlineAt) { cancel(agent, 'deadline'); return { kind: 'reject' }; }
      ensureControl(agent, run);
      signal.throwIfAborted();
    }
    return next();
  });
  ctx.on('agent/created', ({ agent }) => {
    const run = runOf(agent);
    if (isActive(run)) ensureControl(agent, run);
  });
  ctx.on('agent/disposed', ({ agent }) => { release(agent.id); reservations.delete(agent.id); });
  ctx.effect(() => async () => {
    disposeRecovery();
    lifetime.abort();
    for (const control of controls.values()) {
      if (isActive(runOf(control.agent))) cancel(control.agent, 'unloaded');
      timers.clearTimeout(control.timer);
      control.abort.abort();
    }
    controls.clear();
    cooldowns.clear();
    for (const commandId of manualRequests.keys()) clearManual(commandId);
    await Promise.allSettled([...active]);
  }, 'continuous-work: cancel and drain quota waits');
}
