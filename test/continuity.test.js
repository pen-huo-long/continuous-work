import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { apply } from '../index.js';
import { POLICY_KEY, PROVIDER, HOUR, MAX_PROBES, parseInput, classifyQuota, retryDelay,
  reduceState, initialState, waitUntil, deadlineFor, MAX_DATE_MS } from '../core.js';

const quotaFailure = (minutes = 5) => ({ code: 'PI_AI_ERROR',
  message: `You have hit your ChatGPT usage limit (plus plan). Try again in ~${minutes} min.` });

const zcodeFailure = (resetAt = '2026-11-12 20:45:05') => ({ code: 'RATE_LIMIT', status: 429,
  message: `ZCode: [1308][已达到 5 小时的使用上限。您的限额将在 ${resetAt} 重置。][20261112155538b2276ec0abab4bc4] (rate limited: not asked again before 20:45 UTC+8)` });

const zcodeNow = new Date(2026, 10, 12, 15, 55, 38).getTime();

function fixture(options = {}) {
  let clock = 10_000;
  let definition;
  let command;
  let tool;
  let onChanged;
  let sequence = 0;
  const listeners = new Map();
  const effects = [];
  const agents = [];
  const states = new Map();
  const ctx = {
    agents: { list: () => agents, get: (id) => agents.find((agent) => agent.id === id) },
    sessionProjections: { onChanged(callback) { onChanged = callback; }, async register(value) {
      definition = value;
      return { stateOf: (session) => states.get(session) ?? initialState() };
    } },
    commands: {
      register(value) { command = value; },
      async execute(agent, line, attachments, signal) {
        assert.deepEqual(attachments, []);
        const commandId = `cmd-${++sequence}`;
        const rawInput = line.slice('/codex-work'.length);
        agent.session.append('command/run', { commandId, name: 'codex-work', args: rawInput });
        let result;
        try { result = await command.handler({ commandId, agent, rawInput, signal }); }
        catch (error) { result = { kind: 'error', text: error.message }; }
        agent.session.append('command/done', { commandId, ...result });
        return { result, commandId };
      },
    },
    tools: { register(value) { tool = value; } },
    on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name); },
    effect(factory) { const cleanup = factory(); effects.push(cleanup); return cleanup; },
  };
  function newAgent(id = `agent-${agents.length}`, provider = options.provider ?? PROVIDER) {
    const abort = new AbortController();
    const events = [];
    const agent = { id, abort, events, cancellations: [],
      model: { current: () => ({ provider }) },
      cancel(cause) {
        agent.cancellations.push(cause);
        abort.abort(cause);
        agent.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: cause } });
      },
      session: { id, eventAt: (seq) => events[seq], append(type, data) {
        const event = { type, data, time: clock, seq: events.length };
        events.push(event);
        const state = definition.apply(states.get(agent.session) ?? definition.init(), event);
        definition.stateSchema.parse(state);
        definition.wire.viewSchema.parse(definition.wire.view(state));
        const previous = states.get(agent.session);
        states.set(agent.session, state);
        if (state !== previous) onChanged?.(agent.session, 'codexContinuity', state, event.seq);
        return event;
      } },
    };
    agents.push(agent);
    return agent;
  }
  const defaultWait = async (deadline, signal) => { if (signal.aborted) return false; clock = deadline; return true; };
  return {
    ctx, listeners, newAgent,
    init: () => apply(ctx, {}, { now: () => clock, waitUntil: options.waitUntil ?? defaultWait, timers: options.timers }),
    run: (agent) => states.get(agent.session)?.run,
    setClock: (value) => { clock = value; },
    getClock: () => clock,
    operate: (agent, input) => ctx.commands.execute(agent, `/codex-work ${input}`, [], new AbortController().signal),
    tool: () => tool, command: () => command,
    recover: (agent, failure = quotaFailure(), next = async () => undefined,
      provider = agent.model.current().provider) => listeners.get('agent/request-error')({
      agent, turn: 1, step: 2, provider, failure, signal: agent.abort.signal,
    }, next),
    async dispose() { for (const effect of effects.reverse()) await effect?.(); },
  };
}

function success(agent) {
  agent.session.append('assistant/message', { turn: 1, step: 2, message: { source: { provider: agent.model.current().provider } } });
}

test('Magpie Responses can arm and recover through three windows with correct counting', async (t) => {
  const f = fixture({ provider: 'magpie-responses' }); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent();
  assert.equal((await f.operate(agent, 'start 3 18')).result.kind, 'success');
  assert.notEqual(classifyQuota('magpie-responses', quotaFailure()), null);
  assert.equal(classifyQuota('magpie-responses', { code: 'RATE_LIMIT', message: '429 Too many requests' }), null);
  for (let window = 2; window <= 3; window++) {
    assert.deepEqual(await f.recover(agent), { kind: 'retry' });
    success(agent);
    assert.equal(f.run(agent).window, window);
    assert.equal(f.run(agent).attempts, 0);
  }
  assert.equal(await f.recover(agent), undefined);
  assert.equal(f.run(agent).phase, 'exhausted');
});

test('Magpie Responses runs the same pre-step deadline guard', async (t) => {
  const f = fixture({ provider: 'magpie-responses' }); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3 1');
  f.setClock(f.getClock() + HOUR);
  const decision = await f.listeners.get('agent/pre-step')({ agent,
    modelSelection: agent.model.current(), signal: agent.abort.signal }, async () => ({ kind: 'enter', messages: [] }));
  assert.deepEqual(decision, { kind: 'reject' });
  assert.equal(f.run(agent).phase, 'expired');
});

test('quota evidence: QUOTA code or windowed-limit wording on any provider', () => {
  assert.deepEqual(classifyQuota(PROVIDER, quotaFailure(17)), { delayMs: 17 * 60_000 + 65_000, source: 'approximate' });
  for (const provider of ['openai', 'deepseek', 'zcode', 'magpie-responses', PROVIDER]) {
    assert.notEqual(classifyQuota(provider, { code: 'QUOTA', message: '当前请求的额度已用尽' }), null);
    assert.equal(classifyQuota(provider, { code: 'RATE_LIMIT', message: '429 Too many requests' }), null);
    assert.equal(classifyQuota(provider, { ...quotaFailure(), code: 'AUTH' }), null);
  }
  assert.deepEqual(classifyQuota('openai', { ...quotaFailure(), providerRetryAfterMs: 1000 }), { delayMs: 6000, source: 'provider' });
  assert.equal(retryDelay(classifyQuota('deepseek', { code: 'QUOTA', message: 'usage_limit_reached' }), 12), 30 * 60_000);
});

test('ZCode windowed limit yields the exact absolute reset wait', () => {
  const quota = classifyQuota('zcode', zcodeFailure(), () => zcodeNow);
  assert.equal(quota.source, 'reset-at');
  assert.equal(quota.delayMs, (20 * 3600 + 45 * 60 + 5 - (15 * 3600 + 55 * 60 + 38)) * 1000 + 30_000);
  assert.equal(classifyQuota('zcode', zcodeFailure('2026-11-12 14:00:00'), () => zcodeNow).delayMs, null);
  assert.equal(classifyQuota('zcode', zcodeFailure('2026-11-13 20:45:05'), () => zcodeNow).delayMs, null);
});

test('ZCode recovery runs through the same managed wait', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent();
  await f.operate(agent, 'start 3 18');
  const before = f.getClock();
  assert.deepEqual(await f.recover(agent, zcodeFailure(new Date(before + 2 * HOUR).toLocaleString('sv-SE'))), { kind: 'retry' });
  const record = agent.events.find((e) => e.type === 'llm/retry');
  assert.equal(record.data.delayMs, 2 * HOUR + 30_000);
  assert.equal(f.run(agent).phase, 'retrying');
  assert.ok(agent.events.some((e) => e.type === 'llm/retry-started'));
});

test('validates finite windows and wall-clock limits', () => {
  assert.deepEqual(parseInput('start'), { action: 'start', windows: 3, hours: 18 });
  assert.deepEqual(parseInput('start 100 72'), { action: 'start', windows: 100, hours: 72 });
  assert.deepEqual(parseInput('start 9 0.25'), { action: 'start', windows: 9, hours: 0.25 });
  for (const input of ['start 0', 'start -1', 'start 2.5', 'start 9007199254740992',
    'start 2 NaN', 'start 2 Infinity', 'start 2 0', 'start 2 -0.5', 'stop yes']) {
    assert.throws(() => parseInput(input));
  }
});

test('replays command success only, preserving unrelated event identity', () => {
  let state = initialState();
  assert.equal(reduceState(state, { type: 'unrelated', data: {} }), state);
  state = reduceState(state, { type: 'command/run', time: 100, data: { commandId: 'a', name: 'codex-work', args: 'start' } });
  state = reduceState(state, { type: 'command/done', time: 101, data: { commandId: 'a', kind: 'error' } });
  assert.equal(state.run, null);
  assert.deepEqual(state.pending, {});
});

test('two quota recoveries reach three windows in the same step, without messages or tool replay', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent();
  await f.operate(agent, 'start 3 18');
  agent.session.append('user/message', { content: 'original task' });
  agent.session.append('tool/result', { value: 'already completed' });
  for (let window = 2; window <= 3; window++) {
    assert.deepEqual(await f.recover(agent), { kind: 'retry' });
    assert.equal(f.run(agent).window, window - 1);
    success(agent);
    assert.equal(f.run(agent).window, window);
  }
  assert.equal(agent.events.filter((e) => e.type === 'user/message').length, 1);
  assert.equal(agent.events.filter((e) => e.type === 'tool/result').length, 1);
  assert.ok(agent.events.filter((e) => e.type === 'llm/retry').every((e) => e.data.turn === 1 && e.data.step === 2));
  assert.equal(await f.recover(agent), undefined);
  assert.equal(f.run(agent).phase, 'exhausted');
  assert.equal(agent.cancellations.at(-1).reason, 'codex-work:budget');
});

test('repeated failed probes do not consume extra quota windows and are bounded', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3 24');
  for (let i = 0; i < MAX_PROBES; i++) assert.deepEqual(await f.recover(agent, quotaFailure(0)), { kind: 'retry' });
  assert.equal(f.run(agent).window, 1);
  assert.equal(await f.recover(agent), undefined);
  assert.equal(f.run(agent).phase, 'exhausted');
});

test('unknown errors delegate and disabled sessions do not intercept quota', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); let delegated = 0;
  const next = async () => { delegated++; return { kind: 'retry' }; };
  await f.recover(agent, quotaFailure(), next);
  await f.operate(agent, 'start');
  await f.recover(agent, { code: 'AUTH', message: 'invalid token' }, next);
  assert.equal(delegated, 2);
});

test('deadlines stop before an impossible wait and cannot be bypassed by normal retry', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3 1');
  assert.equal(await f.recover(agent, quotaFailure(61)), undefined);
  assert.equal(f.run(agent).phase, 'expired');
  assert.equal(agent.abort.signal.aborted, true);
});

test('user cancellation aborts a real outstanding wait promptly', async (t) => {
  let waiting;
  const ready = new Promise((resolve) => { waiting = resolve; });
  const f = fixture({ waitUntil: (deadline, signal, now) => { waiting(); return waitUntil(deadline, signal, now); } });
  await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start');
  const recovery = f.recover(agent);
  await ready;
  agent.cancel({ kind: 'user' });
  assert.equal(await recovery, undefined);
  assert.equal(f.run(agent).phase, 'interrupted');
  assert.equal(agent.events.some((e) => e.type === 'llm/retry-started'), false);
});

test('tool and UI command use the same operation; stop releases waiting work', async (t) => {
  let waiting;
  const ready = new Promise((resolve) => { waiting = resolve; });
  const f = fixture({ waitUntil: (deadline, signal, now) => { waiting(); return waitUntil(deadline, signal, now); } });
  await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent();
  const tool = f.tool();
  const result = await tool.execute({ action: 'start', windows: 3, hours: 18 }, { agent, signal: new AbortController().signal });
  assert.equal(result.kind, 'success');
  const recovery = f.recover(agent); await ready;
  await tool.execute({ action: 'stop' }, { agent, signal: new AbortController().signal });
  assert.equal(await recovery, undefined);
  assert.equal(f.run(agent).phase, 'stopped');
});

test('plugin unload cancels and drains outstanding quota waits', async () => {
  let waiting;
  const ready = new Promise((resolve) => { waiting = resolve; });
  const f = fixture({ waitUntil: (deadline, signal, now) => { waiting(); return waitUntil(deadline, signal, now); } });
  await f.init(); const agent = f.newAgent(); await f.operate(agent, 'start');
  const recovery = f.recover(agent); await ready;
  await f.dispose();
  assert.equal(await recovery, undefined);
  assert.equal(agent.cancellations.at(-1).reason, 'codex-work:unloaded');
});

test('session replay rebuilds waiting state and crash closers mark interruption', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start'); await f.recover(agent);
  let replay = agent.events.reduce(reduceState, initialState());
  assert.deepEqual(replay.run, f.run(agent));
  replay = reduceState(replay, { type: 'turn/end', data: { reason: { kind: 'interrupted' } } });
  assert.equal(replay.run.phase, 'interrupted');
});

test('parallel starts reserve through command commit and cannot reset window budgets', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent();
  const results = await Promise.all([f.operate(agent, 'start'), f.operate(agent, 'start')]);
  assert.deepEqual(results.map((entry) => entry.result.kind), ['success', 'error']);
  assert.equal(f.run(agent).maxWindows, 3);
  assert.deepEqual((await f.operate(agent, 'stop')).result.kind, 'success');
});

test('interrupted, failed and unrelated messages do not consume recovery windows', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start'); await f.recover(agent);
  for (const data of [
    { turn: 1, step: 2, interrupted: true },
    { turn: 9, step: 9 },
    { turn: 1, step: 2, stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error' } } }] },
  ]) agent.session.append('assistant/message', { ...data, message: { source: { provider: PROVIDER } } });
  assert.equal(f.run(agent).window, 1);
  assert.equal(f.run(agent).attempts, 1);
  success(agent); assert.equal(f.run(agent).window, 2);
});

test('arming mid-turn starts the deadline watchdog immediately after commit', async (t) => {
  let callback; let delay;
  const f = fixture({ timers: { setTimeout(fn, ms) { callback = fn; delay = ms; return {}; }, clearTimeout() {} } });
  await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent();
  await f.operate(agent, 'start 3 1');
  assert.equal(delay, 60_000);
  f.setClock(f.getClock() + HOUR);
  callback();
  assert.equal(agent.cancellations.at(-1).reason, 'codex-work:deadline');
  assert.equal(f.run(agent).phase, 'expired');
});

test('forks do not inherit the parent session recovery authorization', () => {
  const original = initialState({}, 10);
  const state = reduceState(original, { seq: 2, time: 100, type: 'command/run',
    data: { commandId: 'parent', name: 'codex-work', args: 'start' } });
  assert.equal(state, original);
});

test('account cooldown extensions retain one probe and update the durable countdown', async (t) => {
  const waiters = [];
  const f = fixture({ waitUntil: (deadline) => new Promise((resolve) => waiters.push({ deadline, resolve })) });
  await f.init();
  const a = f.newAgent('a'); const b = f.newAgent('b');
  await f.operate(a, 'start'); await f.operate(b, 'start');
  const first = f.recover(a, quotaFailure(1));
  const second = f.recover(b, quotaFailure(10));
  f.setClock(waiters[0].deadline); waiters[0].resolve(true);
  await Promise.resolve();
  assert.equal(f.run(a).attempts, 1);
  assert.ok(f.run(a).nextRetryAt > f.getClock());
  assert.equal(a.events.filter((e) => e.type === 'llm/retry').length, 2);
  f.setClock(Math.max(...waiters.map((item) => item.deadline)));
  for (const item of waiters.slice(1)) item.resolve(true);
  assert.deepEqual(await first, { kind: 'retry' });
  assert.deepEqual(await second, { kind: 'retry' });
  await f.dispose();
});

test('wait uses absolute time across sleep and clears timer on abort', async () => {
  let time = 0; let callback; let cleared = 0;
  const timers = { setTimeout(fn) { callback = fn; return 1; }, clearTimeout() { cleared++; } };
  const signal = new AbortController();
  const waiting = waitUntil(5 * HOUR, signal.signal, () => time, timers);
  time = 6 * HOUR; callback();
  assert.equal(await waiting, true);
  const aborted = waitUntil(10 * HOUR, signal.signal, () => time, timers);
  signal.abort();
  assert.equal(await aborted, false);
  assert.equal(cleared, 2);
});

function controlledFixture() {
  const scheduled = new Set();
  const waiters = [];
  const f = fixture({
    timers: {
      setTimeout(callback, delay) {
        const timer = { callback, deadline: f.getClock() + delay };
        scheduled.add(timer);
        return timer;
      },
      clearTimeout(timer) { scheduled.delete(timer); },
    },
    waitUntil(deadline, signal) {
      return new Promise((resolve) => {
        const abort = () => finish(false);
        const finish = (result) => {
          if (waiter.settled) return;
          waiter.settled = true;
          signal.removeEventListener('abort', abort);
          resolve(result);
        };
        const waiter = { deadline, signal, resolve: finish, settled: false };
        waiters.push(waiter);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    },
  });
  return { ...f, waiters, scheduled, tick(time) {
    f.setClock(time);
    for (const timer of [...scheduled]) {
      if (timer.deadline <= time) { scheduled.delete(timer); timer.callback(); }
    }
  } };
}

test('a long ZCode cooldown never delays the first Codex backoff', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const zcode = f.newAgent('zcode', 'magpie-anthropic');
  const codex = f.newAgent('codex', 'magpie-responses');
  await f.operate(zcode, 'start 3 8'); await f.operate(codex, 'start 3 8');
  const startedAt = f.getClock();
  const long = f.recover(zcode, { code: 'QUOTA', message: 'quota', providerRetryAfterMs: 3 * HOUR });
  const short = f.recover(codex, { code: 'QUOTA', message: 'usage_limit_reached' });
  const zcodeState = { ...f.run(zcode) };
  assert.equal(f.waiters[1].deadline, startedAt + 60_000);
  f.tick(f.waiters[1].deadline); f.waiters[1].resolve(true);
  assert.deepEqual(await short, { kind: 'retry' });
  assert.equal(f.waiters[0].settled, false);
  assert.deepEqual(f.run(zcode), zcodeState);
  assert.equal(codex.events.filter((event) => event.type === 'llm/retry').length, 1);
  f.tick(f.waiters[0].deadline); f.waiters[0].resolve(true);
  assert.deepEqual(await long, { kind: 'retry' });
});

test('another provider cannot extend an existing wait when its timer wakes', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const codex = f.newAgent('codex', 'magpie-responses');
  const zcode = f.newAgent('zcode', 'magpie-anthropic');
  await f.operate(codex, 'start 3 8'); await f.operate(zcode, 'start 3 8');
  const short = f.recover(codex, { code: 'QUOTA', message: 'usage_limit_reached' });
  const long = f.recover(zcode, { code: 'QUOTA', message: 'quota', providerRetryAfterMs: 3 * HOUR });
  f.tick(f.waiters[0].deadline); f.waiters[0].resolve(true);
  await Promise.resolve();
  assert.equal(f.waiters.length, 2);
  assert.deepEqual(await short, { kind: 'retry' });
  assert.equal(f.run(codex).attempts, 1);
  assert.equal(f.run(codex).window, 1);
  f.tick(f.waiters[1].deadline); f.waiters[1].resolve(true);
  assert.deepEqual(await long, { kind: 'retry' });
});

test('cooldown sharing and one-second staggering stay within the failed provider', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agents = [f.newAgent('a1', 'a'), f.newAgent('b1', 'b'), f.newAgent('a2', 'a'), f.newAgent('b2', 'b')];
  for (const agent of agents) await f.operate(agent, 'start 3 8');
  const startedAt = f.getClock();
  const recoveries = agents.map((agent, i) => f.recover(agent, { code: 'QUOTA', message: 'quota',
    providerRetryAfterMs: [HOUR, 3 * HOUR, 60_000, 60_000][i] }));
  assert.deepEqual(f.waiters.map((waiter) => waiter.deadline - startedAt),
    [HOUR + 5_000, 3 * HOUR + 5_000, HOUR + 6_000, 3 * HOUR + 6_000]);
  f.tick(Math.max(...f.waiters.map((waiter) => waiter.deadline)));
  for (const waiter of f.waiters) waiter.resolve(true);
  assert.deepEqual(await Promise.all(recoveries), agents.map(() => ({ kind: 'retry' })));
});

test('cooldowns use the failed request provider after the model selection changes', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const changed = f.newAgent('changed', 'magpie-responses');
  const codex = f.newAgent('codex', 'magpie-responses');
  await f.operate(changed, 'start 3 8'); await f.operate(codex, 'start 3 8');
  const startedAt = f.getClock();
  const long = f.recover(changed, { code: 'QUOTA', message: 'quota', providerRetryAfterMs: 3 * HOUR },
    undefined, 'magpie-anthropic');
  const short = f.recover(codex, { code: 'QUOTA', message: 'usage_limit_reached' });
  assert.equal(f.waiters[1].deadline, startedAt + 60_000);
  f.tick(f.waiters[1].deadline); f.waiters[1].resolve(true);
  assert.deepEqual(await short, { kind: 'retry' });
  f.tick(f.waiters[0].deadline); f.waiters[0].resolve(true);
  assert.deepEqual(await long, { kind: 'retry' });
});

test('real Codex reset schedules its original step independently of a longer ZCode wait', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  f.setClock(Date.parse('2026-11-12T17:59:32+08:00'));
  const zcode = f.newAgent('zcode', 'magpie-anthropic');
  const codex = f.newAgent('codex', 'magpie-responses');
  await f.operate(zcode, 'start 3 8'); await f.operate(codex, 'start 3 8');
  const long = f.recover(zcode, { code: 'QUOTA', message: 'quota', providerRetryAfterMs: 5 * HOUR });
  const short = f.recover(codex, { code: 'QUOTA', message: 'magpie-responses API error (429): ' +
    JSON.stringify({ type: 'usage_limit_reached', resets_at: 1794488591, resets_in_seconds: 11226,
      message: 'Codex: usage limit reached; not asked again before 21:03 UTC+8' }) });
  const expected = 1794488591 * 1000 + 30_000;
  const scheduled = codex.events.find((event) => event.type === 'llm/retry');
  assert.equal(f.waiters[1].deadline, expected);
  assert.equal(f.run(codex).nextRetryAt, expected);
  f.tick(expected); f.waiters[1].resolve(true);
  assert.deepEqual(await short, { kind: 'retry' });
  const started = codex.events.find((event) => event.type === 'llm/retry-started');
  assert.deepEqual([started.data.turn, started.data.step, started.data.retryId], [1, 2, scheduled.data.retryId]);
  assert.equal(f.waiters[0].settled, false);
  f.tick(f.waiters[0].deadline); f.waiters[0].resolve(true);
  assert.deepEqual(await long, { kind: 'retry' });
});

test('waiting update extends watchdog and recovery uses new deadline through cooldown extension', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const a = f.newAgent('a'); const b = f.newAgent('b');
  await f.operate(a, 'start 3 1'); await f.operate(b, 'start 3 3');
  const originalDeadline = f.run(a).deadlineAt;
  const first = f.recover(a, { code: 'QUOTA', message: 'quota', providerRetryAfterMs: HOUR / 2 });
  const second = f.recover(b, { code: 'QUOTA', message: 'quota', providerRetryAfterMs: 2 * HOUR });
  const before = { ...f.run(a) };
  const oldTimer = [...f.scheduled][0];
  assert.equal((await f.operate(a, 'update 3 3')).result.kind, 'success');
  assert.deepEqual(f.run(a), { ...before, deadlineAt: before.startedAt + 3 * HOUR });
  assert.equal(f.waiters.length, 2);
  assert.equal(f.waiters[0].signal.aborted, false);
  oldTimer.callback();
  assert.equal(a.cancellations.length, 0);
  f.tick(originalDeadline + HOUR / 2);
  f.waiters[0].resolve(true); await Promise.resolve();
  assert.equal(f.waiters.length, 3);
  assert.ok(f.waiters[2].deadline > originalDeadline);
  assert.equal(a.cancellations.length, 0);
  assert.equal(f.run(a).attempts, before.attempts);
  f.tick(Math.max(...f.waiters.map((waiter) => waiter.deadline)));
  f.waiters[1].resolve(true); f.waiters[2].resolve(true);
  assert.deepEqual(await first, { kind: 'retry' });
  assert.deepEqual(await second, { kind: 'retry' });
});

test('waiting update shortens deadline without changing current wait or counters', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3 3');
  const recovery = f.recover(agent, { code: 'QUOTA', message: 'quota', providerRetryAfterMs: 2 * HOUR });
  const before = { ...f.run(agent) };
  assert.equal((await f.operate(agent, 'update 2 1')).result.kind, 'success');
  assert.deepEqual(f.run(agent), { ...before, maxWindows: 2, deadlineAt: before.startedAt + HOUR });
  assert.equal(f.waiters.length, 1);
  assert.equal(f.waiters[0].signal.aborted, false);
  f.tick(before.startedAt + HOUR);
  assert.equal(await recovery, undefined);
  assert.equal(f.run(agent).phase, 'expired');
  assert.equal(agent.cancellations.at(-1).reason, 'codex-work:deadline');
  assert.equal(agent.events.some((event) => event.type === 'llm/retry-started'), false);
});

test('update commits and replays limits only after successful command completion', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3 3');
  await f.recover(agent);
  const before = { ...f.run(agent) };
  agent.session.append('command/run', { commandId: 'uncommitted', name: 'codex-work', args: 'update 2 2' });
  assert.deepEqual(f.run(agent), before);
  agent.session.append('command/done', { commandId: 'uncommitted', kind: 'error' });
  assert.deepEqual(f.run(agent), before);
  await f.operate(agent, 'update 2 2');
  assert.deepEqual(f.run(agent), { ...before, maxWindows: 2, deadlineAt: before.startedAt + 2 * HOUR });
  const replay = agent.events.reduce(reduceState, initialState());
  assert.deepEqual(replay.run, f.run(agent));
  assert.deepEqual(replay.pending, {});
});

test('rejects illegal updates without changing run state or reviving expired runs', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent();
  assert.equal((await f.operate(agent, 'update 2 2')).result.kind, 'error');
  await f.operate(agent, 'start 3 3'); await f.recover(agent); success(agent);
  const before = { ...f.run(agent) };
  for (const input of ['update', 'update 2', 'update 0 2', 'update 9007199254740992 2', 'update 2 NaN',
    'update 2 Infinity', 'update 2 0', 'update 2 -1', 'update 1 2']) {
    assert.equal((await f.operate(agent, input)).result.kind, 'error', input);
    assert.deepEqual(f.run(agent), before, input);
  }
  f.setClock(before.startedAt + HOUR);
  assert.equal((await f.operate(agent, 'update 2 1')).result.kind, 'error');
  assert.deepEqual(f.run(agent), before);
  f.setClock(before.startedAt + 3 * HOUR);
  assert.equal((await f.operate(agent, 'update 2 4')).result.kind, 'error');
  assert.deepEqual(f.run(agent), before);
});

test('tool update shares command operation and reservations serialize concurrent mutations', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3 3');
  const tool = f.tool(); const exec = { agent, signal: new AbortController().signal };
  assert.ok(tool.parameters.properties.action.enum.includes('update'));
  await assert.rejects(tool.execute({ action: 'update', windows: 2 }, exec), /requires windows and hours/u);
  assert.equal((await tool.execute({ action: 'update', windows: 2, hours: 2 }, exec)).kind, 'success');
  assert.equal(f.run(agent).maxWindows, 2);
  assert.equal(f.run(agent).deadlineAt, f.run(agent).startedAt + 2 * HOUR);
  const results = await Promise.all([f.operate(agent, 'update 3 4'), f.operate(agent, 'update 2 2'), f.operate(agent, 'stop')]);
  assert.deepEqual(results.map((entry) => entry.result.kind), ['success', 'error', 'error']);
  assert.equal(f.run(agent).maxWindows, 3);
  assert.equal(f.run(agent).deadlineAt, f.run(agent).startedAt + 4 * HOUR);
  assert.equal(agent.events.filter((event) => event.type === 'command/run' && event.data.args.trim() === 'update 2 2').length, 2);
});


test('updates preserve the next quota window while waiting and retrying', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3 3');
  const recovery = f.recover(agent);
  const waiting = { ...f.run(agent) };
  assert.equal(waiting.phase, 'waiting');
  assert.equal(waiting.window, 1);
  assert.equal(waiting.pendingRecovery, true);
  const rejected = await f.operate(agent, 'update 1 3');
  assert.equal(rejected.result.kind, 'error');
  assert.match(rejected.result.text, /保留当前等待恢复的下一窗口/u);
  assert.deepEqual(f.run(agent), waiting);
  assert.equal((await f.operate(agent, 'update 2 3')).result.kind, 'success');
  assert.equal(f.waiters.length, 1);
  assert.equal(f.waiters[0].signal.aborted, false);
  f.tick(f.waiters[0].deadline); f.waiters[0].resolve(true);
  assert.deepEqual(await recovery, { kind: 'retry' });
  const retrying = { ...f.run(agent) };
  assert.equal(retrying.phase, 'retrying');
  assert.equal((await f.operate(agent, 'update 1 3')).result.kind, 'error');
  assert.deepEqual(f.run(agent), retrying);
  success(agent);
  assert.equal(f.run(agent).window, 2);
  assert.equal(f.run(agent).maxWindows, 2);
  assert.ok(f.run(agent).window <= f.run(agent).maxWindows);
  assert.deepEqual(agent.events.reduce(reduceState, initialState()).run, f.run(agent));
});


test('large budgets start, update and replay without the former product caps', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent();
  const tool = f.tool(); const exec = { agent, signal: new AbortController().signal };
  assert.equal(tool.parameters.properties.windows.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(tool.parameters.properties.hours.maximum, undefined);
  assert.equal(tool.parameters.properties.hours.exclusiveMinimum, 0);
  assert.equal((await tool.execute({ action: 'start', windows: 100, hours: 72 }, exec)).kind, 'success');
  const startedAt = f.run(agent).startedAt;
  assert.equal(f.run(agent).maxWindows, 100);
  assert.equal(f.run(agent).deadlineAt, startedAt + 72 * HOUR);
  for (let window = 2; window <= 5; window++) {
    assert.deepEqual(await f.recover(agent, quotaFailure(0)), { kind: 'retry' });
    success(agent);
    assert.equal(f.run(agent).window, window);
  }
  const before = { ...f.run(agent) };
  assert.equal((await tool.execute({ action: 'update', windows: 200, hours: 1000.5 }, exec)).kind, 'success');
  assert.deepEqual(f.run(agent), { ...before, maxWindows: 200, deadlineAt: startedAt + 1000.5 * HOUR });
  assert.deepEqual(agent.events.reduce(reduceState, initialState()).run, f.run(agent));
});

test('fractional positive hours preserve millisecond precision and safe Date boundaries', async (t) => {
  assert.equal(deadlineFor(10_000, 0.001), 13_600);
  assert.equal(deadlineFor(10_000, 0.0000001), 10_001);
  assert.equal(deadlineFor(0, MAX_DATE_MS / HOUR), MAX_DATE_MS);
  for (const [start, hours] of [[10_000, Number.MAX_VALUE], [10_000, MAX_DATE_MS / HOUR],
    [0, Number.MAX_SAFE_INTEGER], [Number.MAX_SAFE_INTEGER, 1], [10_000, Number.MIN_VALUE]]) {
    assert.throws(() => deadlineFor(start, hours), /有效截止日期/u);
  }
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent();
  assert.equal((await f.operate(agent, 'start 100 0.001')).result.kind, 'success');
  const deadlineAt = f.run(agent).deadlineAt;
  assert.equal(deadlineAt, f.run(agent).startedAt + 3600);
  f.tick(deadlineAt - 1);
  assert.equal(agent.cancellations.length, 0);
  f.tick(deadlineAt);
  assert.equal(f.run(agent).phase, 'expired');
});

test('overflowing deadlines are rejected on commands and replay without corrupting state', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent();
  const rejected = await f.operate(agent, 'start 100 1e308');
  assert.equal(rejected.result.kind, 'error');
  assert.match(rejected.result.text, /有效截止日期/u);
  assert.equal(f.run(agent), null);
  await f.operate(agent, 'start 100 72');
  const before = { ...f.run(agent) };
  const update = await f.operate(agent, 'update 200 1e308');
  assert.equal(update.result.kind, 'error');
  assert.match(update.result.text, /有效截止日期/u);
  assert.deepEqual(f.run(agent), before);
  let state = initialState();
  state = reduceState(state, { type: 'command/run', time: 10_000,
    data: { commandId: 'overflow', name: 'codex-work', args: 'start 100 1e308' } });
  state = reduceState(state, { type: 'command/done', time: 10_001,
    data: { commandId: 'overflow', kind: 'success' } });
  assert.equal(state.run, null);
  assert.deepEqual(state.pending, {});
  assert.deepEqual(agent.events.reduce(reduceState, initialState()).run, before);
});

test('long watchdog uses bounded absolute-time checks and never expires at a timer slice', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent();
  await f.operate(agent, 'start 100 1000');
  const before = { ...f.run(agent) };
  assert.ok(before.deadlineAt - before.startedAt > 2 ** 31 - 1);
  const firstTimer = [...f.scheduled][0];
  assert.equal(firstTimer.deadline, before.startedAt + 60_000);
  f.tick(firstTimer.deadline);
  assert.equal(agent.cancellations.length, 0);
  assert.deepEqual(f.run(agent), before);
  assert.equal([...f.scheduled][0].deadline, f.getClock() + 60_000);
  // A resumed machine can jump over many slices; target time stays absolute.
  f.tick(before.deadlineAt - 1);
  assert.equal(agent.cancellations.length, 0);
  assert.equal([...f.scheduled][0].deadline, before.deadlineAt);
  f.tick(before.deadlineAt);
  assert.equal(agent.cancellations.length, 1);
  assert.equal(f.run(agent).phase, 'expired');
  assert.equal(agent.cancellations[0].reason, 'codex-work:deadline');
});

test('long waiting budgets can extend and shorten without interrupting the recovery wait', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 100 1000');
  const recovery = f.recover(agent, { code: 'QUOTA', message: 'quota', providerRetryAfterMs: 72 * HOUR });
  const before = { ...f.run(agent) };
  const oldTimer = [...f.scheduled][0];
  assert.equal((await f.operate(agent, 'update 200 2000')).result.kind, 'success');
  oldTimer.callback();
  assert.equal(f.waiters.length, 1);
  assert.equal(f.waiters[0].signal.aborted, false);
  assert.equal(agent.cancellations.length, 0);
  assert.equal((await f.operate(agent, 'update 100 24.5')).result.kind, 'success');
  assert.equal(f.waiters.length, 1);
  assert.equal(f.waiters[0].signal.aborted, false);
  assert.equal(f.run(agent).deadlineAt, before.startedAt + 24.5 * HOUR);
  assert.equal(f.run(agent).attempts, before.attempts);
  f.tick(f.run(agent).deadlineAt - 1);
  assert.equal(agent.cancellations.length, 0);
  f.tick(f.run(agent).deadlineAt);
  assert.equal(await recovery, undefined);
  assert.equal(agent.cancellations.at(-1).reason, 'codex-work:deadline');
});


test('manual retry wakes the original wait immediately and keeps its retry identity and counters', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3 3');
  const recovery = f.recover(agent, quotaFailure(60));
  const before = { ...f.run(agent) }; const clock = f.getClock();
  assert.equal((await f.operate(agent, 'retry')).result.kind, 'success');
  assert.deepEqual(await recovery, { kind: 'retry' });
  assert.equal(f.getClock(), clock);
  assert.equal(agent.cancellations.length, 0);
  assert.equal(agent.abort.signal.aborted, false);
  assert.equal(f.waiters[0].settled, true);
  assert.equal(getEventListeners(f.waiters[0].signal, 'abort').length, 0);
  assert.equal(f.run(agent).phase, 'retrying');
  assert.equal(f.run(agent).id, before.id);
  assert.equal(f.run(agent).retryId, before.retryId);
  assert.equal(f.run(agent).attempts, before.attempts);
  assert.equal(f.run(agent).window, before.window);
  const started = agent.events.filter((event) => event.type === 'llm/retry-started');
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].data, { retryId: before.retryId, turn: before.turn, step: before.step, retry: before.attempts });
  assert.equal(agent.events.some((event) => ['user/message', 'turn/start', 'tool/call'].includes(event.type)), false);
  success(agent);
  assert.equal(f.run(agent).window, before.window + 1);
  assert.deepEqual(agent.events.reduce(reduceState, initialState()).run, f.run(agent));
});

test('manual retry is inert until success commits and failed commands remove their wake listener', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3 3');
  const recovery = f.recover(agent, quotaFailure(60));
  const before = { ...f.run(agent) }; const request = new AbortController();
  agent.session.append('command/run', { commandId: 'manual-failure', name: 'codex-work', args: 'retry' });
  const result = await f.command().handler({ commandId: 'manual-failure', agent, rawInput: 'retry', signal: request.signal });
  assert.equal(result.kind, 'success');
  assert.equal(getEventListeners(request.signal, 'abort').length, 1);
  assert.equal(f.waiters[0].settled, false);
  assert.deepEqual(f.run(agent), before);
  agent.session.append('command/done', { commandId: 'manual-failure', kind: 'error', text: 'commit rejected' });
  assert.equal(f.waiters[0].settled, false);
  assert.equal(getEventListeners(request.signal, 'abort').length, 0);
  assert.deepEqual(f.run(agent), before);
  assert.equal((await f.operate(agent, 'retry')).result.kind, 'success');
  assert.deepEqual(await recovery, { kind: 'retry' });
  assert.equal(agent.events.filter((event) => event.type === 'llm/retry-started').length, 1);
});

test('retry commit append failure never wakes and its pending request is cleaned when the original wait ends', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3 3');
  const recovery = f.recover(agent, quotaFailure(5));
  const append = agent.session.append;
  agent.session.append = (type, data) => {
    if (type === 'command/done') throw new Error('append failed');
    return append(type, data);
  };
  await assert.rejects(f.operate(agent, 'retry'), /append failed/u);
  agent.session.append = append;
  assert.equal(f.waiters[0].settled, false);
  assert.equal(agent.events.some((event) => event.type === 'llm/retry-started'), false);
  f.tick(f.waiters[0].deadline); f.waiters[0].resolve(true);
  assert.deepEqual(await recovery, { kind: 'retry' });
  const next = f.recover(agent, { code: 'QUOTA', message: 'quota' });
  assert.equal((await f.operate(agent, 'retry')).result.kind, 'success');
  assert.deepEqual(await next, { kind: 'retry' });
  assert.equal(f.waiters.every((waiter) => waiter.settled), true);
});

test('concurrent manual retries and natural wake races emit at most one retry-started', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3 3');
  const recovery = f.recover(agent, quotaFailure(5));
  const results = await Promise.all([f.operate(agent, 'retry'), f.operate(agent, 'retry')]);
  assert.deepEqual(results.map((result) => result.result.kind), ['success', 'error']);
  f.waiters[0].resolve(true);
  assert.deepEqual(await recovery, { kind: 'retry' });
  assert.equal((await f.operate(agent, 'retry')).result.kind, 'error');
  assert.equal(agent.events.filter((event) => event.type === 'llm/retry-started').length, 1);

  const raced = f.newAgent(); await f.operate(raced, 'start 3 3');
  const automatic = f.recover(raced, quotaFailure(5));
  raced.session.append('command/run', { commandId: 'race', name: 'codex-work', args: 'retry' });
  const signal = new AbortController().signal;
  assert.equal((await f.command().handler({ commandId: 'race', agent: raced, rawInput: 'retry', signal })).kind, 'success');
  const waiter = f.waiters.at(-1);
  f.tick(waiter.deadline); waiter.resolve(true);
  assert.deepEqual(await automatic, { kind: 'retry' });
  const before = { ...f.run(raced) };
  raced.session.append('command/done', { commandId: 'race', kind: 'success' });
  assert.deepEqual(f.run(raced), before);
  assert.equal(raced.events.filter((event) => event.type === 'llm/retry-started').length, 1);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('manual retry bypasses only this wait and leaves shared cooldown and other sessions untouched', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const a = f.newAgent('manual-a'); const b = f.newAgent('manual-b');
  await f.operate(a, 'start 3 3'); await f.operate(b, 'start 3 3');
  const first = f.recover(a, quotaFailure(5));
  const second = f.recover(b, { code: 'QUOTA', message: 'quota', providerRetryAfterMs: HOUR });
  const bBefore = { ...f.run(b) };
  assert.equal((await f.operate(a, 'retry')).result.kind, 'success');
  assert.deepEqual(await first, { kind: 'retry' });
  assert.equal(f.waiters[1].settled, false);
  assert.deepEqual(f.run(b), bBefore);
  const failedAgain = f.recover(a, { code: 'QUOTA', message: 'quota' });
  assert.equal(f.run(a).attempts, 2);
  assert.ok(f.waiters[2].deadline >= bBefore.nextRetryAt);
  assert.equal(f.run(a).window, 1);
  f.tick(Math.max(f.waiters[1].deadline, f.waiters[2].deadline));
  f.waiters[1].resolve(true); f.waiters[2].resolve(true);
  assert.deepEqual(await second, { kind: 'retry' });
  assert.deepEqual(await failedAgain, { kind: 'retry' });
});

test('manual retry rejects absent, restored-only, stopped, expired and cancelled waits', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const empty = f.newAgent();
  assert.equal((await f.operate(empty, 'retry')).result.kind, 'error');
  await f.operate(empty, 'start 3 3');
  assert.equal((await f.operate(empty, 'retry')).result.kind, 'error');
  empty.session.append('llm/retry', { retryId: 'restored', policyKey: POLICY_KEY, retry: 1, delayMs: 60_000, turn: 1, step: 1 });
  assert.equal(f.run(empty).phase, 'waiting');
  assert.equal((await f.operate(empty, 'retry')).result.kind, 'error');

  for (const mode of ['stop', 'expired', 'cancel']) {
    const agent = f.newAgent(); await f.operate(agent, 'start 3 1');
    const recovery = f.recover(agent, quotaFailure(5));
    if (mode === 'stop') await f.operate(agent, 'stop');
    else if (mode === 'cancel') agent.cancel({ kind: 'user' });
    else f.setClock(f.run(agent).deadlineAt);
    assert.equal((await f.operate(agent, 'retry')).result.kind, 'error', mode);
    if (mode === 'expired') f.tick(f.getClock());
    assert.equal(await recovery, undefined);
    assert.equal(f.waiters.at(-1).settled, true);
    assert.equal(agent.events.some((event) => event.type === 'llm/retry-started'), false);
  }
});

test('retry tool shares the committed command operation and permits the already scheduled final probe', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3 3');
  agent.session.append('llm/retry', { retryId: 'prior', policyKey: POLICY_KEY, retry: MAX_PROBES - 1, delayMs: 1, turn: 1, step: 1 });
  const recovery = f.recover(agent, { code: 'QUOTA', message: 'quota' });
  assert.equal(f.run(agent).attempts, MAX_PROBES);
  const tool = f.tool();
  assert.ok(tool.parameters.properties.action.enum.includes('retry'));
  assert.equal((await tool.execute({ action: 'retry' }, { agent, signal: new AbortController().signal })).kind, 'success');
  assert.deepEqual(await recovery, { kind: 'retry' });
  assert.equal(f.run(agent).attempts, MAX_PROBES);
  assert.equal(f.run(agent).window, 1);
  assert.equal(await f.recover(agent, { code: 'QUOTA', message: 'quota' }), undefined);
  assert.equal(f.run(agent).phase, 'exhausted');
  assert.equal(agent.events.filter((event) => event.type === 'llm/retry-started').length, 1);
  assert.deepEqual(agent.events.reduce(reduceState, initialState()).run, f.run(agent));
});

test('manual retry abort, stop and unload remove pending command and waiting listeners', async () => {
  for (const mode of ['request-abort', 'stop', 'unload']) {
    const f = controlledFixture(); await f.init();
    const agent = f.newAgent(); await f.operate(agent, 'start 3 3');
    const recovery = f.recover(agent, quotaFailure(5));
    const signal = new AbortController();
    agent.session.append('command/run', { commandId: mode, name: 'codex-work', args: 'retry' });
    assert.equal((await f.command().handler({ commandId: mode, agent, rawInput: 'retry', signal: signal.signal })).kind, 'success');
    assert.equal(getEventListeners(signal.signal, 'abort').length, 1);
    if (mode === 'request-abort') {
      signal.abort();
      assert.equal(f.waiters[0].settled, false);
      agent.session.append('command/done', { commandId: mode, kind: 'success' });
      assert.equal(f.waiters[0].settled, false);
      await f.operate(agent, 'stop');
    } else if (mode === 'stop') agent.cancel({ kind: 'user' });
    else await f.dispose();
    assert.equal(await recovery, undefined);
    assert.equal(getEventListeners(signal.signal, 'abort').length, 0);
    assert.equal(getEventListeners(f.waiters[0].signal, 'abort').length, 0);
    assert.equal(f.waiters[0].settled, true);
    await f.dispose();
  }
});

test('manual retry cancels its real wait timer while leaving the deadline watchdog alive', async () => {
  const scheduled = new Set();
  const timers = {
    setTimeout(callback, delay) { const timer = { callback, delay }; scheduled.add(timer); return timer; },
    clearTimeout(timer) { scheduled.delete(timer); },
  };
  const f = fixture({ timers, waitUntil: (deadline, signal, now) => waitUntil(deadline, signal, now, timers) });
  await f.init();
  const agent = f.newAgent(); await f.operate(agent, 'start 3 3');
  const recovery = f.recover(agent, quotaFailure(5));
  assert.equal(scheduled.size, 2);
  assert.equal((await f.operate(agent, 'retry')).result.kind, 'success');
  assert.deepEqual(await recovery, { kind: 'retry' });
  assert.equal(scheduled.size, 1);
  assert.equal(agent.cancellations.length, 0);
  await f.dispose();
  assert.equal(scheduled.size, 0);
});


test('quota failure after manual retry resumes the original automatic backoff sequence', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3 3');
  assert.deepEqual(parseInput('retry'), { action: 'retry' });
  assert.throws(() => parseInput('retry 3'), /用法/u);
  const clock = f.getClock();
  const first = f.recover(agent, { code: 'QUOTA', message: 'quota' });
  assert.equal(f.waiters[0].deadline, clock + 60_000);
  await f.operate(agent, 'retry');
  assert.deepEqual(await first, { kind: 'retry' });
  const failedAgain = f.recover(agent, { code: 'QUOTA', message: 'quota' });
  assert.equal(f.waiters[1].deadline, clock + 120_000);
  assert.equal(f.run(agent).attempts, 2);
  assert.equal(f.run(agent).window, 1);
  f.tick(f.waiters[1].deadline); f.waiters[1].resolve(true);
  assert.deepEqual(await failedAgain, { kind: 'retry' });
  assert.equal(agent.events.filter((event) => event.type === 'llm/retry-started').length, 2);
  success(agent);
  assert.equal(f.run(agent).window, 2);
  assert.equal(f.run(agent).attempts, 0);
});
