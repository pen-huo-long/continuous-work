import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { POLICY_KEY, initialState, reduceState, parseInput, isActive,
  updateError, MAX_DATE_MS, classifyQuota, retryDelay, waitUntil } from './core.js';

export const name = 'continuous-work';
export const inject = ['agents', 'commands', 'tools', 'sessionProjections'];

const timestampSchema = z.number().int().min(-MAX_DATE_MS).max(MAX_DATE_MS);
const windowSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const runSchema = z.object({
  id: z.string(), enabled: z.boolean(),
  phase: z.enum(['armed', 'running', 'waiting', 'retrying', 'stopped', 'exhausted']),
  startedAt: timestampSchema, maxWindows: windowSchema, window: countSchema,
  attempts: countSchema, retryIds: z.array(z.string()), pendingRecovery: z.boolean(),
  nextRetryAt: z.number().nullable(), turn: z.number().nullable(), step: z.number().nullable(), retryId: z.string().nullable(),
});
const stateSchema = z.object({ skipBefore: z.number(), turn: z.number().nullable(), run: runSchema.nullable(),
  pending: z.record(z.string(), z.object({ action: z.string(), windows: windowSchema.optional(), time: timestampSchema })) });

export async function apply(ctx, config = {}, internals = {}) {
  if (Object.keys(config).length) throw new Error('continuous-work: use /codex-work to configure each session');
  const now = internals.now ?? Date.now;
  const wait = internals.waitUntil ?? waitUntil;
  const controls = new Map();
  const reservations = new Map();
  const manualRequests = new Map();
  const active = new Set();
  const cooldowns = new Map();
  let closing = false;
  const projection = await ctx.sessionProjections.register({
    key: 'codexContinuity', stateVersion: 8, stateSchema, init: initialState, apply: reduceState,
    wire: { summary: false, viewSchema: stateSchema, view: (state) => state },
  });
  const runOf = (agent) => projection.stateOf(agent.session).run;

  function clearManual(commandId) {
    const request = manualRequests.get(commandId);
    if (!request) return;
    request.signal.removeEventListener('abort', request.onAbort);
    manualRequests.delete(commandId);
    if (reservations.get(request.agentId) === commandId) reservations.delete(request.agentId);
  }
  function clearWaitRequests(control) {
    for (const [commandId, request] of manualRequests) {
      if (request.control === control) clearManual(commandId);
    }
  }
  function finishControl(control) {
    control.claimed = true;
    control.signal.removeEventListener('abort', control.onAbort);
    clearWaitRequests(control);
    if (controls.get(control.agent.id) === control) controls.delete(control.agent.id);
    control.abort.abort();
  }
  function wakeControl(control, reason) {
    if (['turn', 'disposed'].includes(control.reason)) return;
    control.reason = reason;
    control.detached = true;
    control.abort.abort();
  }
  function liveWait(agent, run, expected) {
    const control = controls.get(agent.id);
    if (!isActive(run) || run.phase !== 'waiting' || closing || !control || control.claimed ||
        control.signal.aborted || control.abort.signal.aborted || control.retryId !== run.retryId ||
        control.turn !== run.turn || control.step !== run.step || (expected && expected !== control)) return null;
    return control;
  }

  // Commands only reserve in their handler; committed success owns all effects.
  ctx.sessionProjections.onChanged((session, key, state, seq) => {
    if (key !== 'codexContinuity') return;
    const agent = ctx.agents.get(session.id);
    if (!agent) return;
    const committed = session.eventAt(seq);
    const control = controls.get(agent.id);
    if (control && (committed?.type === 'turn/start' || committed?.type === 'turn/end')) {
      if (committed.type === 'turn/end' ? committed.data.turn === control.turn : committed.data.turn !== control.turn) {
        wakeControl(control, 'turn');
        if (controls.get(agent.id) === control) controls.delete(agent.id);
      }
    } else if (control && !state.run?.enabled) {
      // Stop retains the current timer and target, but stops following later
      // shared cooldown extensions, even if the switch is enabled again.
      control.detached = true;
    }
    if (committed?.type === 'command/done') {
      const request = manualRequests.get(committed.data.commandId);
      if (request?.agentId === agent.id) {
        clearManual(committed.data.commandId);
        if (committed.data.kind === 'success' && !request.signal.aborted &&
            liveWait(agent, state.run, request.control)) wakeControl(request.control, 'manual');
      }
    }
    const reserved = reservations.get(agent.id);
    if (reserved && !state.pending[reserved]) reservations.delete(agent.id);
  });

  async function recover(payload, next) {
    const { agent, failure, provider, signal, turn, step } = payload;
    const quota = classifyQuota(provider, failure, now);
    const run = runOf(agent);
    if (!quota || !isActive(run) || closing || (run.turn !== null && run.turn !== turn)) return next();
    if (signal.aborted) return;
    if (run.window >= run.maxWindows || controls.has(agent.id)) return next();
    const requestedAt = now() + retryDelay(quota, run.attempts + 1);
    const cooldown = cooldowns.get(provider) ?? { at: 0, ticket: 0 };
    if (requestedAt > cooldown.at) { cooldown.at = requestedAt; cooldown.ticket = 0; }
    cooldowns.set(provider, cooldown);
    const retryAt = cooldown.at + cooldown.ticket++ * 1_000;
    const retryId = randomUUID();
    const retry = run.attempts + 1;
    const control = { agent, signal, turn, step, runId: run.id, retryId, target: retryAt,
      abort: new AbortController(), detached: false, reason: null, claimed: false };
    control.onAbort = () => control.abort.abort();
    signal.addEventListener('abort', control.onAbort, { once: true });
    if (signal.aborted) control.onAbort();
    controls.set(agent.id, control);
    const recordSchedule = (target) => agent.session.append('llm/retry', {
      retryId, turn, step, provider, mode: 'normal', policyKey: POLICY_KEY,
      retry, maxRetries: Math.max(retry, runOf(agent).maxWindows), delayMs: Math.max(0, target - now()), failure,
    });
    try {
      recordSchedule(retryAt);
      while (true) {
        const elapsed = await wait(control.target, control.abort.signal, now);
        if (signal.aborted || ['turn', 'disposed'].includes(control.reason)) return;
        const current = runOf(agent);
        if (!current || current.id !== control.runId || current.turn !== turn || current.retryId !== retryId) return;
        const wake = control.reason === 'manual' || control.reason === 'unload';
        if (!elapsed && !wake) return;
        if (!wake && !control.detached && cooldown.at > now()) {
          control.target = cooldown.at + cooldown.ticket++ * 1_000;
          // The same retry id and ordinal extend one wait, not its round count.
          recordSchedule(control.target);
          continue;
        }
        agent.session.append('llm/retry-started', { retryId, turn, step, retry });
        return { kind: 'retry' };
      }
    } finally {
      finishControl(control);
    }
  }

  function operate({ commandId, agent, rawInput, signal }) {
    signal.throwIfAborted();
    const input = parseInput(rawInput);
    const run = runOf(agent);
    if (input.action === 'status') {
      return { kind: 'success', text: run ?
        `额度托管：${run.enabled ? '已启用' : '已关闭'}（${run.phase}）；本轮等待 ${run.window}/${run.maxWindows}` +
        (run.nextRetryAt !== null ? `；已排定重试 ${new Date(run.nextRetryAt).toLocaleString('zh-CN')}` : '') : '额度托管尚未启用。' };
    }
    if (reservations.has(agent.id)) return { kind: 'error', text: '托管状态正在更新，请稍后重试。' };
    if (input.action === 'retry') {
      const control = liveWait(agent, run);
      if (!control) return { kind: 'error', text: '当前没有可立即重试的已启用额度等待。' };
      reservations.set(agent.id, commandId);
      const onAbort = () => clearManual(commandId);
      manualRequests.set(commandId, { agentId: agent.id, control, signal, onAbort });
      signal.addEventListener('abort', onAbort, { once: true });
      return { kind: 'success', text: '已请求立即重试原步骤；本次不会额外消耗等待轮次。' };
    }
    if (input.action === 'stop') {
      reservations.set(agent.id, commandId);
      return { kind: 'success', text: run?.phase === 'waiting' ?
        '已关闭托管；当前已排定的等待保持原计划，之后不再安排新等待。当前执行不会被取消。' :
        '已关闭托管；当前执行继续，不再自动安排额度等待。' };
    }
    if (input.action === 'update') {
      const error = updateError(run);
      if (error) return { kind: 'error', text: error };
      reservations.set(agent.id, commandId);
      return { kind: 'success', text: `已更新托管：每轮最多等待 ${input.windows} 次；已排定的等待保持原计划。` };
    }
    if (isActive(run)) return { kind: 'error', text: '托管已启用，将持续用于后续会话轮次；可用 update 修改等待上限。' };
    reservations.set(agent.id, commandId);
    return { kind: 'success', text: `已启用持续托管：每轮最多等待 ${input.windows} 次，后续轮次自动重新计数。` };
  }

  ctx.commands.register({
    name: 'codex-work', description: '持续额度托管：按会话开关，每轮限制等待次数，启停不取消当前执行',
    input: { hint: 'start [等待轮次=3] | update <等待轮次> | retry | status | stop\nper-turn-rounds-v2' }, handler: operate,
  });
  ctx.tools.register({
    name: 'codex_work', description: 'Enable persistent session quota recovery with a per-turn wait-round budget. Start and stop only toggle recovery without cancelling the current execution. Stop retains an already scheduled wait; future failures then use native handling. Cooldowns are isolated by provider and reported quota reset times are respected. No continuation prompts or permission changes.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['start', 'update', 'retry', 'status', 'stop'], description: 'retry wakes one live enabled wait without consuming an extra round; stop keeps an already scheduled wait.' },
      windows: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
        description: 'Positive safe-integer maximum wait rounds per turn, default 3. Updating affects future waits and preserves the current scheduled wait and used count.' },
    }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', properties: {
      kind: { type: 'string' }, text: { type: 'string' },
    }, required: ['kind'], additionalProperties: false },
    render: (_args, result) => [{ type: 'text', text: result.text ?? result.kind }] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('A session is required');
      const action = args?.action;
      if (action === 'update' && args.windows === undefined) throw new Error('update requires windows');
      const line = action === 'start' ? `start ${args.windows ?? 3}` :
        action === 'update' ? `update ${args.windows}` : action;
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
  ctx.on('agent/disposed', ({ agent }) => {
    const control = controls.get(agent.id);
    if (control) wakeControl(control, 'disposed');
    reservations.delete(agent.id);
  });
  ctx.effect(() => async () => {
    disposeRecovery();
    closing = true;
    for (const control of controls.values()) wakeControl(control, 'unload');
    for (const commandId of manualRequests.keys()) clearManual(commandId);
    await Promise.allSettled([...active]);
    controls.clear();
    reservations.clear();
    cooldowns.clear();
  }, 'continuous-work: release quota waits without cancelling agents');
}
