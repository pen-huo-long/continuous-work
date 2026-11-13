import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { apply } from '../index.js';
import { POLICY_KEY, PROVIDER, HOUR, parseInput, classifyQuota, retryDelay,
  reduceState, initialState, waitUntil } from '../core.js';

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
      turn: 1, step: 2, model: { current: () => ({ provider }) },
      cancel(cause) {
        agent.cancellations.push(cause);
        agent.abort.abort(cause);
        agent.session.append('turn/end', { turn: agent.turn, reason: { kind: 'aborted', reason: cause } });
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
    agent.session.append('turn/start', { turn: 1 });
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
    tool: () => tool, command: () => command, definition: () => definition,
    startTurn(agent, turn) { agent.turn = turn; agent.abort = new AbortController(); agent.session.append('turn/start', { turn }); },
    recover: (agent, failure = quotaFailure(), next = async () => undefined,
      provider = agent.model.current().provider) => {
      agent.session.append('assistant/attempt', { turn: agent.turn, step: agent.step,
        stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure } } }] });
      return listeners.get('agent/request-error')({ agent, turn: agent.turn, step: agent.step, provider, failure, signal: agent.abort.signal }, next);
    },
    async dispose() { for (const effect of effects.reverse()) await effect?.(); },
  };
}

function success(agent) {
  agent.session.append('assistant/message', { turn: agent.turn, step: agent.step, message: { source: { provider: agent.model.current().provider } } });
}

test('Magpie Responses spends exactly N wait rounds per turn and delegates the next failure', async (t) => {
  const f = fixture({ provider: 'magpie-responses' }); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3');
  assert.equal(f.run(agent).window, 0);
  for (let round = 1; round <= 3; round++) {
    assert.deepEqual(await f.recover(agent), { kind: 'retry' });
    assert.equal(f.run(agent).window, round);
    success(agent);
    assert.equal(f.run(agent).window, round);
    assert.equal(f.run(agent).attempts, round);
  }
  let delegated = 0;
  assert.deepEqual(await f.recover(agent, quotaFailure(), async () => { delegated++; return { kind: 'retry' }; }), { kind: 'retry' });
  assert.equal(delegated, 1);
  assert.equal(f.run(agent).phase, 'exhausted');
  assert.equal(f.run(agent).enabled, true);
  assert.equal(agent.cancellations.length, 0);
});

test('persistent enable has no pre-step rejection or watchdog deadline', async (t) => {
  const timers = { setTimeout() { throw new Error('Unexpected watchdog'); }, clearTimeout() {} };
  const f = fixture({ timers }); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start');
  f.setClock(f.getClock() + 10_000 * HOUR);
  assert.equal(f.listeners.has('agent/pre-step'), false);
  assert.equal(f.run(agent).enabled, true);
  assert.equal('deadlineAt' in f.run(agent), false);
  assert.equal(agent.abort.signal.aborted, false);
  assert.deepEqual(await f.recover(agent), { kind: 'retry' });
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
  await f.operate(agent, 'start 3');
  const before = f.getClock();
  assert.deepEqual(await f.recover(agent, zcodeFailure(new Date(before + 2 * HOUR).toLocaleString('sv-SE'))), { kind: 'retry' });
  const record = agent.events.find((e) => e.type === 'llm/retry');
  assert.equal(record.data.delayMs, 2 * HOUR + 30_000);
  assert.equal(f.run(agent).phase, 'retrying');
  assert.ok(agent.events.some((e) => e.type === 'llm/retry-started'));
});

test('new commands accept only a positive safe-integer per-turn wait budget', () => {
  assert.deepEqual(parseInput('start'), { action: 'start', windows: 3 });
  assert.deepEqual(parseInput('start 100'), { action: 'start', windows: 100 });
  assert.deepEqual(parseInput('update 1'), { action: 'update', windows: 1 });
  for (const input of ['start 0', 'start -1', 'start 2.5', 'start 9007199254740992',
    'start 2 18', 'update 2 24', 'update', 'stop yes']) assert.throws(() => parseInput(input));
});

test('replays command success only, preserving unrelated event identity', () => {
  let state = initialState();
  assert.equal(reduceState(state, { type: 'unrelated', data: {} }), state);
  state = reduceState(state, { type: 'command/run', time: 100, data: { commandId: 'a', name: 'codex-work', args: 'start' } });
  state = reduceState(state, { type: 'command/done', time: 101, data: { commandId: 'a', kind: 'error' } });
  assert.equal(state.run, null);
  assert.deepEqual(state.pending, {});
});

test('wait rounds preserve the original step without new messages or completed tool replay', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3');
  agent.session.append('user/message', { content: 'original task' });
  agent.session.append('tool/result', { value: 'already completed' });
  for (let round = 1; round <= 3; round++) {
    assert.deepEqual(await f.recover(agent), { kind: 'retry' });
    success(agent); assert.equal(f.run(agent).window, round);
  }
  assert.equal(agent.events.filter((e) => e.type === 'user/message').length, 1);
  assert.equal(agent.events.filter((e) => e.type === 'tool/result').length, 1);
  assert.ok(agent.events.filter((e) => e.type === 'llm/retry').every((e) => e.data.turn === 1 && e.data.step === 2));
  assert.equal(await f.recover(agent), undefined);
  assert.equal(agent.cancellations.length, 0);
});

test('configured fifty wait rounds are honored beyond the former forty-eight probe cap', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 50');
  for (let round = 1; round <= 50; round++) {
    assert.deepEqual(await f.recover(agent, { code: 'QUOTA', message: 'quota' }), { kind: 'retry' });
    assert.equal(f.run(agent).window, round);
  }
  assert.equal(f.run(agent).attempts, 50);
  assert.ok(agent.events.filter((e) => e.type === 'llm/retry').every((e) => e.data.maxRetries === 50));
  assert.equal(await f.recover(agent), undefined);
  assert.equal(f.run(agent).enabled, true);
  assert.equal(agent.cancellations.length, 0);
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

test('a long provider wait is not cut short by any removed wall-clock limit', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3');
  const recovery = f.recover(agent, { code: 'QUOTA', message: 'quota', providerRetryAfterMs: 72 * HOUR });
  const target = f.waiters[0].deadline;
  f.tick(target - 1);
  assert.equal(f.waiters[0].settled, false);
  assert.equal(agent.cancellations.length, 0);
  f.tick(target); f.waiters[0].resolve(true);
  assert.deepEqual(await recovery, { kind: 'retry' });
});

test('user cancellation aborts a real outstanding wait but preserves enable for the next turn', async (t) => {
  let ready; const waiting = new Promise((resolve) => { ready = resolve; });
  const f = fixture({ waitUntil: (deadline, signal, now) => { ready(); return waitUntil(deadline, signal, now); } });
  await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start');
  const recovery = f.recover(agent); await waiting; agent.cancel({ kind: 'user' });
  assert.equal(await recovery, undefined);
  assert.equal(f.run(agent).enabled, true);
  assert.equal(f.run(agent).phase, 'armed');
  assert.equal(agent.events.some((e) => e.type === 'llm/retry-started'), false);
  f.startTurn(agent, 2);
  assert.equal(f.run(agent).window, 0);
  assert.equal(f.run(agent).attempts, 0);
});

test('tool stop leaves the current wait unchanged and disables future handling without cancelling', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); const tool = f.tool();
  const exec = { agent, signal: new AbortController().signal };
  assert.equal((await tool.execute({ action: 'start', windows: 3 }, exec)).kind, 'success');
  const recovery = f.recover(agent); const before = { ...f.run(agent) };
  assert.equal((await tool.execute({ action: 'stop' }, exec)).kind, 'success');
  assert.equal(f.waiters[0].settled, false);
  assert.equal(f.run(agent).enabled, false);
  assert.equal(f.run(agent).nextRetryAt, before.nextRetryAt);
  assert.equal((await f.operate(agent, 'retry')).result.kind, 'error');
  f.tick(f.waiters[0].deadline); f.waiters[0].resolve(true);
  assert.deepEqual(await recovery, { kind: 'retry' });
  assert.equal(f.run(agent).phase, 'stopped');
  assert.equal(await f.recover(agent), undefined);
  assert.equal(agent.cancellations.length, 0);
});

test('plugin unload wakes its pending original step once without cancelling any agent', async () => {
  const f = controlledFixture(); await f.init();
  const agent = f.newAgent(); const normal = f.newAgent();
  await f.operate(agent, 'start'); await f.operate(normal, 'start');
  const recovery = f.recover(agent); const before = { ...f.run(agent) };
  await f.dispose();
  assert.deepEqual(await recovery, { kind: 'retry' });
  assert.equal(f.run(agent).window, before.window);
  assert.equal(f.run(agent).enabled, true);
  assert.equal(agent.events.filter((e) => e.type === 'llm/retry-started').length, 1);
  assert.equal(agent.cancellations.length + normal.cancellations.length, 0);
  assert.equal(getEventListeners(agent.abort.signal, 'abort').length, 0);
});

test('session replay preserves enabled after interrupted turn closers and resets on the next turn', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start'); await f.recover(agent);
  assert.deepEqual(agent.events.reduce(reduceState, initialState()).run, f.run(agent));
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
  assert.equal(f.run(agent).enabled, true);
  f.startTurn(agent, 2);
  assert.equal(f.run(agent).phase, 'armed');
  assert.equal(f.run(agent).window, 0);
  assert.deepEqual(agent.events.reduce(reduceState, initialState()).run, f.run(agent));
});

test('parallel starts reserve through command commit and cannot reset window budgets', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent();
  const results = await Promise.all([f.operate(agent, 'start'), f.operate(agent, 'start')]);
  assert.deepEqual(results.map((entry) => entry.result.kind), ['success', 'error']);
  assert.equal(f.run(agent).maxWindows, 3);
  assert.deepEqual((await f.operate(agent, 'stop')).result.kind, 'success');
});

test('interrupted failed and unrelated replies neither spend rounds nor clear the live recovery', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start'); await f.recover(agent);
  const before = { ...f.run(agent) };
  for (const data of [{ turn: 1, step: 2, interrupted: true }, { turn: 9, step: 9 },
    { turn: 1, step: 2, stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error' } } }] }]) {
    agent.session.append('assistant/message', { ...data, message: { source: { provider: PROVIDER } } });
  }
  assert.deepEqual(f.run(agent), before);
  success(agent);
  assert.equal(f.run(agent).window, 1);
  assert.equal(f.run(agent).attempts, 1);
});

test('enabling mid-turn starts at zero and the projection schema has no time-limit fields', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start');
  assert.equal(f.run(agent).turn, 1);
  assert.equal(f.run(agent).window, 0);
  assert.equal(f.definition().stateVersion, 8);
  assert.equal('deadlineAt' in f.run(agent), false);
  assert.equal('hours' in f.tool().parameters.properties, false);
  assert.match(f.command().input.hint, /(?:^|\s)per-turn-rounds-v2(?:$|\s)/u);
  assert.equal(f.scheduled.size, 0);
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
  await f.operate(zcode, 'start 3'); await f.operate(codex, 'start 3');
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
  await f.operate(codex, 'start 3'); await f.operate(zcode, 'start 3');
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
  for (const agent of agents) await f.operate(agent, 'start 3');
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
  await f.operate(changed, 'start 3'); await f.operate(codex, 'start 3');
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
  await f.operate(zcode, 'start 3'); await f.operate(codex, 'start 3');
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

test('updating the round budget preserves the current wait and later provider extension', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const a = f.newAgent('a'); const b = f.newAgent('b');
  await f.operate(a, 'start 3'); await f.operate(b, 'start 3');
  const first = f.recover(a, { code: 'QUOTA', message: 'quota', providerRetryAfterMs: HOUR / 2 });
  const second = f.recover(b, { code: 'QUOTA', message: 'quota', providerRetryAfterMs: 2 * HOUR });
  const before = { ...f.run(a) };
  await f.operate(a, 'update 1');
  assert.deepEqual(f.run(a), { ...before, maxWindows: 1 });
  f.tick(f.waiters[0].deadline); f.waiters[0].resolve(true); await Promise.resolve();
  assert.equal(f.waiters.length, 3);
  assert.equal(f.run(a).window, 1);
  f.tick(Math.max(...f.waiters.map((item) => item.deadline)));
  f.waiters[1].resolve(true); f.waiters[2].resolve(true);
  assert.deepEqual(await first, { kind: 'retry' }); assert.deepEqual(await second, { kind: 'retry' });
  assert.equal(await f.recover(a), undefined);
  assert.equal(a.cancellations.length, 0);
});

test('lowering the maximum below used rounds affects only a future failure', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3');
  const first = f.recover(agent); f.tick(f.waiters[0].deadline); f.waiters[0].resolve(true); await first;
  const second = f.recover(agent); const before = { ...f.run(agent) };
  assert.equal(before.window, 2);
  assert.equal((await f.operate(agent, 'update 1')).result.kind, 'success');
  assert.deepEqual(f.run(agent), { ...before, maxWindows: 1 });
  assert.equal(f.waiters[1].settled, false);
  f.tick(f.waiters[1].deadline); f.waiters[1].resolve(true);
  assert.deepEqual(await second, { kind: 'retry' });
  assert.equal(await f.recover(agent), undefined);
  assert.equal(agent.cancellations.length, 0);
});

test('updates commit and replay only after successful command completion', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start'); await f.recover(agent);
  const before = { ...f.run(agent) };
  agent.session.append('command/run', { commandId: 'uncommitted', name: 'codex-work', args: 'update 2' });
  assert.deepEqual(f.run(agent), before);
  agent.session.append('command/done', { commandId: 'uncommitted', kind: 'error' });
  assert.deepEqual(f.run(agent), before);
  await f.operate(agent, 'update 2');
  assert.deepEqual(f.run(agent), { ...before, maxWindows: 2 });
  assert.deepEqual(agent.events.reduce(reduceState, initialState()).run, f.run(agent));
});

test('invalid round updates preserve state while valid updates remain available after long idle time', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent();
  assert.equal((await f.operate(agent, 'update 2')).result.kind, 'error');
  await f.operate(agent, 'start'); const before = { ...f.run(agent) };
  for (const input of ['update', 'update 0', 'update -1', 'update 2.5', 'update 9007199254740992', 'update 2 18']) {
    assert.equal((await f.operate(agent, input)).result.kind, 'error');
    assert.deepEqual(f.run(agent), before);
  }
  f.setClock(f.getClock() + 10_000 * HOUR);
  assert.equal((await f.operate(agent, 'update 1')).result.kind, 'success');
  assert.equal(f.run(agent).enabled, true);
});

test('tool updates use the real command handler and serialize concurrent mutations', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start');
  const tool = f.tool(); const exec = { agent, signal: new AbortController().signal };
  await assert.rejects(tool.execute({ action: 'update' }, exec), /requires windows/u);
  assert.equal((await tool.execute({ action: 'update', windows: 2 }, exec)).kind, 'success');
  const results = await Promise.all([f.operate(agent, 'update 3'), f.operate(agent, 'update 2'), f.operate(agent, 'stop')]);
  assert.deepEqual(results.map((entry) => entry.result.kind), ['success', 'error', 'error']);
  assert.equal(f.run(agent).maxWindows, 3);
  assert.equal(agent.cancellations.length, 0);
});

test('updates can lower the maximum during waiting and retrying without discarding either execution', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start');
  const recovery = f.recover(agent); const before = { ...f.run(agent) };
  await f.operate(agent, 'update 1');
  assert.deepEqual(f.run(agent), { ...before, maxWindows: 1 });
  assert.equal(f.waiters[0].settled, false);
  f.tick(f.waiters[0].deadline); f.waiters[0].resolve(true); await recovery;
  assert.equal((await f.operate(agent, 'update 1')).result.kind, 'success');
  success(agent); assert.equal(f.run(agent).window, 1);
  assert.equal(f.run(agent).maxWindows, 1);
});

test('large per-turn budgets start update and replay without a hidden hard cap', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); const exec = { agent, signal: new AbortController().signal };
  assert.equal(f.tool().parameters.properties.windows.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal((await f.tool().execute({ action: 'start', windows: 100 }, exec)).kind, 'success');
  for (let round = 1; round <= 4; round++) { await f.recover(agent); success(agent); assert.equal(f.run(agent).window, round); }
  const before = { ...f.run(agent) };
  await f.tool().execute({ action: 'update', windows: 200 }, exec);
  assert.deepEqual(f.run(agent), { ...before, maxWindows: 200 });
  assert.deepEqual(agent.events.reduce(reduceState, initialState()).run, f.run(agent));
});

test('persistent enable and settings survive completed errored and cancelled turns', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 2');
  const id = f.run(agent).id;
  for (const [i, reason] of [{ kind: 'completed' }, { kind: 'error', error: { code: 'OTHER', message: 'failure' } },
    { kind: 'aborted', reason: { kind: 'user' } }].entries()) {
    await f.recover(agent);
    agent.session.append('turn/end', { turn: agent.turn, reason });
    assert.equal(f.run(agent).enabled, true);
    f.startTurn(agent, i + 2);
    assert.deepEqual([f.run(agent).window, f.run(agent).attempts, f.run(agent).phase], [0, 0, 'armed']);
    assert.equal(f.run(agent).maxWindows, 2);
    assert.equal(f.run(agent).id, id);
  }
});

test('the live handler rejects removed time arguments instead of enabling hidden deadlines', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent();
  assert.equal((await f.operate(agent, 'start 3 18')).result.kind, 'error');
  assert.equal(f.run(agent), null);
  await f.operate(agent, 'start 3'); const before = { ...f.run(agent) };
  assert.equal((await f.operate(agent, 'update 4 24')).result.kind, 'error');
  assert.deepEqual(f.run(agent), before);
});

test('normal start and stop never cancel the current agent or schedule a watchdog', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 100');
  await f.operate(agent, 'stop');
  assert.equal(agent.abort.signal.aborted, false);
  assert.equal(agent.cancellations.length, 0);
  assert.equal(f.scheduled.size, 0);
  f.tick(f.getClock() + 10_000 * HOUR);
  assert.equal(f.run(agent).enabled, false);
  assert.equal(f.run(agent).phase, 'stopped');
});

test('stop and reenable keep the current turn budget and freeze the old target against later cooldowns', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent('a'); const other = f.newAgent('b');
  await f.operate(agent, 'start 3'); await f.operate(other, 'start 3');
  const recovery = f.recover(agent, quotaFailure(1)); const before = { ...f.run(agent) };
  await f.operate(agent, 'stop');
  assert.equal(f.waiters[0].signal.aborted, false);
  await f.operate(agent, 'start 3');
  assert.equal(f.run(agent).id, before.id);
  assert.equal(f.run(agent).window, before.window);
  assert.equal(f.run(agent).attempts, before.attempts);
  assert.equal(f.run(agent).nextRetryAt, before.nextRetryAt);
  const long = f.recover(other, quotaFailure(30));
  f.tick(f.waiters[0].deadline); f.waiters[0].resolve(true);
  assert.deepEqual(await recovery, { kind: 'retry' });
  assert.equal(f.waiters.length, 2);
  assert.equal(agent.events.filter((e) => e.type === 'llm/retry-started').length, 1);
  assert.equal(f.run(agent).enabled, true);
  f.tick(f.waiters[1].deadline); f.waiters[1].resolve(true); await long;
});

test('manual retry wakes the original wait immediately and keeps its retry identity and counters', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3');
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
  assert.equal(agent.events.some((event) => ['user/message', 'tool/call'].includes(event.type)), false);
  assert.equal(agent.events.filter((event) => event.type === 'turn/start').length, 1);
  success(agent);
  assert.equal(f.run(agent).window, before.window);
  assert.deepEqual(agent.events.reduce(reduceState, initialState()).run, f.run(agent));
});

test('manual retry is inert until success commits and failed commands remove their wake listener', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3');
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
  const agent = f.newAgent(); await f.operate(agent, 'start 3');
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
  const agent = f.newAgent(); await f.operate(agent, 'start 3');
  const recovery = f.recover(agent, quotaFailure(5));
  const results = await Promise.all([f.operate(agent, 'retry'), f.operate(agent, 'retry')]);
  assert.deepEqual(results.map((result) => result.result.kind), ['success', 'error']);
  f.waiters[0].resolve(true);
  assert.deepEqual(await recovery, { kind: 'retry' });
  assert.equal((await f.operate(agent, 'retry')).result.kind, 'error');
  assert.equal(agent.events.filter((event) => event.type === 'llm/retry-started').length, 1);

  const raced = f.newAgent(); await f.operate(raced, 'start 3');
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
  await f.operate(a, 'start 3'); await f.operate(b, 'start 3');
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
  assert.equal(f.run(a).window, 2);
  f.tick(Math.max(f.waiters[1].deadline, f.waiters[2].deadline));
  f.waiters[1].resolve(true); f.waiters[2].resolve(true);
  assert.deepEqual(await second, { kind: 'retry' });
  assert.deepEqual(await failedAgain, { kind: 'retry' });
});

test('manual retry rejects absent restored-only disabled and user-cancelled waits', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const empty = f.newAgent(); assert.equal((await f.operate(empty, 'retry')).result.kind, 'error');
  await f.operate(empty, 'start');
  empty.session.append('llm/retry', { retryId: 'restored', policyKey: POLICY_KEY, retry: 1, delayMs: 60_000, turn: 1, step: 1 });
  assert.equal((await f.operate(empty, 'retry')).result.kind, 'error');
  for (const mode of ['stop', 'cancel']) {
    const agent = f.newAgent(); await f.operate(agent, 'start'); const recovery = f.recover(agent);
    if (mode === 'stop') await f.operate(agent, 'stop'); else agent.cancel({ kind: 'user' });
    assert.equal((await f.operate(agent, 'retry')).result.kind, 'error');
    if (mode === 'stop') { f.tick(f.waiters.at(-1).deadline); f.waiters.at(-1).resolve(true); }
    assert.deepEqual(await recovery, mode === 'stop' ? { kind: 'retry' } : undefined);
  }
});

test('manual retry is allowed for the last already-consumed wait round', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 1');
  const recovery = f.recover(agent);
  assert.equal(f.run(agent).window, 1);
  assert.equal((await f.tool().execute({ action: 'retry' }, { agent, signal: new AbortController().signal })).kind, 'success');
  assert.deepEqual(await recovery, { kind: 'retry' });
  assert.equal(f.run(agent).window, 1);
  assert.equal(await f.recover(agent), undefined);
  assert.equal(f.run(agent).phase, 'exhausted');
  assert.equal(f.run(agent).enabled, true);
  assert.equal(agent.cancellations.length, 0);
});

test('aborted manual requests user cancellation and unload clean all waiting listeners', async () => {
  for (const mode of ['request-abort', 'cancel', 'unload']) {
    const f = controlledFixture(); await f.init(); const agent = f.newAgent(); await f.operate(agent, 'start');
    const recovery = f.recover(agent); const signal = new AbortController();
    agent.session.append('command/run', { commandId: mode, name: 'codex-work', args: 'retry' });
    await f.command().handler({ commandId: mode, agent, rawInput: 'retry', signal: signal.signal });
    if (mode === 'request-abort') {
      signal.abort();
      agent.session.append('command/done', { commandId: mode, kind: 'success' });
      assert.equal(f.waiters[0].settled, false);
      f.tick(f.waiters[0].deadline); f.waiters[0].resolve(true);
    } else if (mode === 'cancel') agent.cancel({ kind: 'user' }); else await f.dispose();
    assert.deepEqual(await recovery, mode === 'cancel' ? undefined : { kind: 'retry' });
    assert.equal(getEventListeners(signal.signal, 'abort').length, 0);
    assert.equal(getEventListeners(f.waiters[0].signal, 'abort').length, 0);
    assert.equal(getEventListeners(agent.abort.signal, 'abort').length, 0);
    await f.dispose();
  }
});

test('manual retry clears its only real timer and leaves no watchdog', async () => {
  const scheduled = new Set();
  const timers = { setTimeout(callback, delay) { const timer = { callback, delay }; scheduled.add(timer); return timer; },
    clearTimeout(timer) { scheduled.delete(timer); } };
  const f = fixture({ waitUntil: (deadline, signal, now) => waitUntil(deadline, signal, now, timers) });
  await f.init(); const agent = f.newAgent(); await f.operate(agent, 'start');
  const recovery = f.recover(agent);
  assert.equal(scheduled.size, 1);
  await f.operate(agent, 'retry'); assert.deepEqual(await recovery, { kind: 'retry' });
  assert.equal(scheduled.size, 0);
  assert.equal(agent.cancellations.length, 0);
  await f.dispose();
});

test('quota failure after manual retry resumes the original automatic backoff sequence', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3');
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
  assert.equal(f.run(agent).window, 2);
  f.tick(f.waiters[1].deadline); f.waiters[1].resolve(true);
  assert.deepEqual(await failedAgain, { kind: 'retry' });
  assert.equal(agent.events.filter((event) => event.type === 'llm/retry-started').length, 2);
  success(agent);
  assert.equal(f.run(agent).window, 2);
  assert.equal(f.run(agent).attempts, 2);
});


test('a failed start completion cannot enable recovery or disturb the agent', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent();
  agent.session.append('command/run', { commandId: 'start-failed', name: 'codex-work', args: 'start 3' });
  const result = await f.command().handler({ commandId: 'start-failed', agent,
    rawInput: 'start 3', signal: new AbortController().signal });
  assert.equal(result.kind, 'success');
  assert.equal(f.run(agent), null);
  agent.session.append('command/done', { commandId: 'start-failed', kind: 'error' });
  assert.equal(f.run(agent), null);
  assert.equal((await f.operate(agent, 'start 3')).result.kind, 'success');
  assert.equal(f.run(agent).enabled, true);
  assert.equal(agent.cancellations.length, 0);
});

test('failed stop is inert even for shared cooldown extension of a live wait', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const a = f.newAgent('a'); const b = f.newAgent('b');
  await f.operate(a, 'start'); await f.operate(b, 'start');
  const first = f.recover(a, quotaFailure(1)); const before = { ...f.run(a) };
  a.session.append('command/run', { commandId: 'stop-failed', name: 'codex-work', args: 'stop' });
  assert.equal((await f.command().handler({ commandId: 'stop-failed', agent: a,
    rawInput: 'stop', signal: new AbortController().signal })).kind, 'success');
  assert.deepEqual(f.run(a), before);
  assert.equal(f.waiters[0].settled, false);
  a.session.append('command/done', { commandId: 'stop-failed', kind: 'error' });
  assert.deepEqual(f.run(a), before);
  const second = f.recover(b, quotaFailure(30));
  f.tick(f.waiters[0].deadline); f.waiters[0].resolve(true); await Promise.resolve();
  assert.equal(f.waiters.length, 3);
  assert.equal(f.run(a).window, 1);
  f.tick(Math.max(...f.waiters.map((item) => item.deadline)));
  f.waiters[1].resolve(true); f.waiters[2].resolve(true);
  assert.deepEqual(await first, { kind: 'retry' }); assert.deepEqual(await second, { kind: 'retry' });
  assert.equal(a.cancellations.length, 0);
});

test('stopping then user-cancelling a retained wait never sends its retry', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start');
  const recovery = f.recover(agent); await f.operate(agent, 'stop');
  agent.cancel({ kind: 'user' });
  assert.equal(await recovery, undefined);
  assert.equal(f.run(agent).enabled, false);
  assert.equal(agent.events.filter((event) => event.type === 'llm/retry-started').length, 0);
  assert.equal(getEventListeners(agent.abort.signal, 'abort').length, 0);
  f.startTurn(agent, 2);
  assert.equal(f.run(agent).phase, 'stopped');
  assert.equal(f.run(agent).window, 0);
});

test('reenabling a retained wait permits explicit manual retry without resetting its budget', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3');
  const recovery = f.recover(agent); const before = { ...f.run(agent) };
  await f.operate(agent, 'stop');
  assert.equal((await f.operate(agent, 'retry')).result.kind, 'error');
  await f.operate(agent, 'start 3');
  assert.equal(f.waiters[0].settled, false);
  assert.equal(f.run(agent).nextRetryAt, before.nextRetryAt);
  assert.equal((await f.operate(agent, 'retry')).result.kind, 'success');
  assert.deepEqual(await recovery, { kind: 'retry' });
  assert.equal(f.run(agent).window, 1);
  assert.equal(f.run(agent).attempts, 1);
  assert.equal(f.run(agent).id, before.id);
  assert.equal(agent.events.filter((event) => event.type === 'llm/retry-started').length, 1);
  const next = f.recover(agent); assert.equal(f.run(agent).window, 2);
  await f.operate(agent, 'retry'); await next;
});

test('an old turn wait cannot remove the new turn waiter during asynchronous cleanup', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 3');
  const old = f.recover(agent); f.startTurn(agent, 2);
  const next = f.recover(agent); const current = { ...f.run(agent) };
  assert.equal(await old, undefined);
  assert.equal(f.run(agent).turn, 2);
  assert.equal(f.run(agent).window, 1);
  assert.equal((await f.operate(agent, 'retry')).result.kind, 'success');
  assert.deepEqual(await next, { kind: 'retry' });
  assert.equal(f.run(agent).retryId, current.retryId);
  const started = agent.events.filter((event) => event.type === 'llm/retry-started');
  assert.equal(started.length, 1); assert.equal(started[0].data.turn, 2);
  assert.equal(agent.cancellations.length, 0);
});

test('unload never revives a wait whose original turn signal was cancelled', async () => {
  const f = controlledFixture(); await f.init(); const agent = f.newAgent();
  await f.operate(agent, 'start'); const recovery = f.recover(agent);
  agent.abort.abort(); await f.dispose();
  assert.equal(await recovery, undefined);
  assert.equal(agent.cancellations.length, 0);
  assert.equal(agent.events.filter((event) => event.type === 'llm/retry-started').length, 0);
});

test('budget exhaustion reflects quota evidence and lets native handling decide the outcome', async (t) => {
  const f = fixture(); await f.init(); t.after(() => f.dispose());
  const agent = f.newAgent(); await f.operate(agent, 'start 1'); await f.recover(agent); success(agent);
  let called = 0; const native = async () => { called++; return { kind: 'retry' }; };
  await f.recover(agent, { code: 'AUTH', message: 'invalid credentials' }, native);
  assert.equal(f.run(agent).phase, 'running');
  await f.recover(agent, { code: 'QUOTA', message: 'usage_limit_reached' }, native);
  assert.equal(called, 2);
  assert.equal(f.run(agent).phase, 'exhausted');
  assert.equal(f.run(agent).enabled, true);
  assert.equal(agent.events.filter((event) => event.type === 'llm/retry').length, 1);
  assert.equal(agent.cancellations.length, 0);
});


test('an extended existing second wait keeps legal retry metadata after lowering the maximum to one', async (t) => {
  const f = controlledFixture(); await f.init(); t.after(() => f.dispose());
  const a = f.newAgent('a'); const b = f.newAgent('b');
  await f.operate(a, 'start 3'); await f.operate(b, 'start 3');
  const first = f.recover(a, quotaFailure(1));
  f.tick(f.waiters[0].deadline); f.waiters[0].resolve(true); await first;
  const second = f.recover(a, quotaFailure(1)); const identity = f.run(a).retryId;
  await f.operate(a, 'update 1');
  const other = f.recover(b, quotaFailure(30));
  f.tick(f.waiters[1].deadline); f.waiters[1].resolve(true); await Promise.resolve();
  assert.equal(f.waiters.length, 4);
  assert.deepEqual([f.run(a).window, f.run(a).attempts, f.run(a).maxWindows], [2, 2, 1]);
  const extension = a.events.filter((event) => event.type === 'llm/retry').at(-1);
  assert.equal(extension.data.retryId, identity);
  assert.deepEqual([extension.data.retry, extension.data.maxRetries], [2, 2]);
  f.tick(Math.max(...f.waiters.map((waiter) => waiter.deadline)));
  f.waiters[2].resolve(true); f.waiters[3].resolve(true);
  assert.deepEqual(await second, { kind: 'retry' }); assert.deepEqual(await other, { kind: 'retry' });
  assert.equal(await f.recover(a), undefined);
  assert.equal(a.cancellations.length, 0);
});


test('plugin unload cannot revive a waiter already invalidated by agent disposal', async () => {
  const f = controlledFixture(); await f.init(); const agent = f.newAgent();
  await f.operate(agent, 'start'); const recovery = f.recover(agent);
  f.listeners.get('agent/disposed')({ agent });
  await f.dispose();
  assert.equal(await recovery, undefined);
  assert.equal(agent.events.filter((event) => event.type === 'llm/retry-started').length, 0);
  assert.equal(agent.cancellations.length, 0);
  assert.equal(getEventListeners(agent.abort.signal, 'abort').length, 0);
});
