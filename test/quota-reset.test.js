import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuota, HOUR } from '../core.js';

const NOW = Date.parse('2026-11-12T17:59:32+08:00');
const quota = (message, code = 'QUOTA') => ({ code, message });
const body = (value) => `magpie-responses API error (429): ${JSON.stringify(value)}`;
const classify = (message, now = NOW) => classifyQuota('magpie-responses', quota(message), () => now);
const backoff = { delayMs: null, source: 'backoff' };

test('real Codex body uses absolute reset seconds before relative seconds and text', () => {
  const message = body({ eligible_promo: null, limit_window_minutes: 300,
    message: 'Codex: The usage limit has been reached (out of its allowance: not asked again before 21:03 UTC+8)',
    plan_type: 'plus', resets_at: 1794488591, resets_in_seconds: 11226, type: 'usage_limit_reached' });
  assert.deepEqual(classify(message), { delayMs: 1794488591 * 1000 - NOW + 30_000, source: 'reset-at' });
});

test('absolute resets do not slide forward when a proxy repeats the same response', () => {
  const message = body({ resets_at: NOW / 1000 + 300, resets_in_seconds: 300 });
  assert.equal(classify(message).delayMs, 330_000);
  assert.equal(classify(message, NOW + 120_000).delayMs, 210_000);
  assert.deepEqual(classify(message, NOW + 300_000), backoff);
});

test('explicit provider delay stays highest priority', () => {
  assert.deepEqual(classifyQuota('openai-codex', { ...quota(body({ resets_at: NOW / 1000 + 300 })),
    providerRetryAfterMs: 1000 }, () => NOW), { delayMs: 6000, source: 'provider' });
});

test('relative numeric seconds and one nested error object are supported', () => {
  assert.deepEqual(classify(body({ resets_in_seconds: 90.5 })), { delayMs: 120_500, source: 'reset-seconds' });
  assert.deepEqual(classify(body({ error: { resets_at: NOW / 1000 + 60, resets_in_seconds: 999 } })),
    { delayMs: 90_000, source: 'reset-at' });
});

test('JSON-looking fields inside quoted strings are not parsed as reset metadata', () => {
  assert.deepEqual(classify(body({ message: 'Example: {"resets_at":1794488591,"resets_in_seconds":900}' })), backoff);
  assert.deepEqual(classify(body({ other: { resets_in_seconds: 900 } })), backoff);
  assert.deepEqual(classify('gateway: {"resets_in_seconds":900'), backoff);
});

test('wrong types, nonpositive and nonfinite relative metadata fall back', () => {
  for (const value of ['900', null, true, -1, 0, {}, [], 6 * 3600 + 1]) {
    assert.deepEqual(classify(body({ resets_in_seconds: value })), backoff);
  }
  assert.deepEqual(classify('gateway: {"resets_in_seconds":1e309}'), backoff);
  assert.deepEqual(classify(body({ resets_at: '1794488591' })), backoff);
});

test('stale or implausible absolute reset blocks stale relative and clock fallback', () => {
  for (const reset of [NOW / 1000 - 1, NOW / 1000, NOW / 1000 + 6 * 3600 + 1]) {
    assert.deepEqual(classify(body({ resets_at: reset, resets_in_seconds: 900,
      message: 'not asked again before 21:03 UTC+8' })), backoff);
  }
});

test('structured reset accepts the six-hour boundary and rejects larger values', () => {
  assert.equal(classify(body({ resets_at: NOW / 1000 + 6 * 3600 })).delayMs, 6 * HOUR + 30_000);
  assert.equal(classify(body({ resets_in_seconds: 6 * 3600 })).delayMs, 6 * HOUR + 30_000);
  assert.deepEqual(classify(body({ resets_at: Number.MAX_VALUE })), backoff);
});

test('explicit UTC-offset clock text uses the named zone rather than the host zone', () => {
  assert.deepEqual(classify('not asked again before 21:03 UTC+8'),
    { delayMs: Date.parse('2026-11-12T21:03:00+08:00') - NOW + 30_000, source: 'reset-clock' });
  const now = Date.parse('2026-11-12T14:00:00Z');
  assert.deepEqual(classify('not asked again before 09:30 UTC-05:00', now),
    { delayMs: 30 * 60_000 + 30_000, source: 'reset-clock' });
  assert.deepEqual(classify('not asked again before 20:00 UTC+05:30', now),
    { delayMs: 30 * 60_000 + 30_000, source: 'reset-clock' });
});

test('clock-only reset rolls across midnight only within the six-hour horizon', () => {
  const now = Date.parse('2026-11-12T23:50:00+08:00');
  assert.deepEqual(classify('not asked again before 00:10 UTC+8', now),
    { delayMs: 20 * 60_000 + 30_000, source: 'reset-clock' });
  assert.deepEqual(classify('not asked again before 23:40 UTC+8', now), backoff);
  assert.deepEqual(classify('not asked again before 23:50 UTC+8', now), backoff);
});

test('incomplete or invalid clock and timezone text falls back', () => {
  for (const text of ['before 21:03', 'before 24:00 UTC+8', 'before 21:60 UTC+8',
    'before 21:03 UTC+25', 'before 21:03 UTC+8:99', 'before 21:03 UTC+8garbage', 'before 21:03 GMT+8']) {
    assert.deepEqual(classify(text), backoff, text);
  }
});

test('past complete date does not roll its clock suffix into the next day', () => {
  const now = new Date(2026, 10, 12, 23, 50).getTime();
  assert.deepEqual(classify('reset 2026-11-12 00:10:00; not asked again before 00:10 UTC+8', now), backoff);
});

test('existing approximate, local date, authorization and ordinary rate-limit behavior stays intact', () => {
  assert.deepEqual(classify('Try again in ~17 min'), { delayMs: 17 * 60_000 + 65_000, source: 'approximate' });
  const now = new Date(2026, 10, 12, 15, 0).getTime();
  assert.deepEqual(classify('您的限额将在 2026-11-12 17:00:00 重置。', now),
    { delayMs: 2 * HOUR + 30_000, source: 'reset-at' });
  assert.equal(classifyQuota('openai', quota('usage_limit_reached', 'AUTH')), null);
  assert.equal(classifyQuota('openai', quota(body({ resets_in_seconds: 900 }), 'RATE_LIMIT')), null);
});
