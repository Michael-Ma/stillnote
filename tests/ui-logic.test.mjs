import test from 'node:test';
import assert from 'node:assert/strict';
import { ownLineMatcher } from '../app/own-lines.mjs';
import { aiView, claudeSummary, usageSummary, modelKey } from '../app/ai-view.mjs';

test('enhanced lines that restate rough notes are marked as the user’s own', () => {
  const isOwn = ownLineMatcher(
    'Keep the first screen simple.\n- Alex to share the revised flow Friday',
  );
  assert.equal(isOwn('**Keep the first screen simple.** Move optional setup elsewhere.'), true);
  assert.equal(isOwn('Alex to share the revised flow on Friday.'), true);
  assert.equal(isOwn('Sam will review the permission prompts.'), false);
});

test('short or empty notes never mark generated text', () => {
  assert.equal(ownLineMatcher('')('Anything at all here'), false);
  assert.equal(ownLineMatcher('ok')('ok sounds good to everyone'), false);
  assert.equal(ownLineMatcher('Ship the flow Friday')('Ship'), false);
});

test('CJK notes match by character', () => {
  const isOwn = ownLineMatcher('我们保存原始记录');
  assert.equal(isOwn('团队决定：我们保存原始记录。'), true);
  assert.equal(isOwn('下周讨论定价方案'), false);
});

test('aiView falls back to the legacy account shape', () => {
  const view = aiView({ account: { sharing: true, email: 'a@example.invalid' } });
  assert.equal(view.provider, 'chatgpt');
  assert.equal(view.ready, true);
  assert.equal(view.label, 'ChatGPT');
});

test('aiView reports the active provider and what one click can enable', () => {
  const view = aiView({
    ai: { provider: 'claude', chosen: null, chatgpt: { ready: false }, claude: { ready: true } },
  });
  assert.equal(view.label, 'Claude');
  assert.equal(view.ready, true);
  assert.equal(view.chosen, null);
  assert.equal(view.suggestion, 'use-claude');
  assert.equal(aiView({ ai: { provider: null, chatgpt: {}, claude: {} } }).ready, false);
});

test('model settings are kept per provider', () => {
  assert.equal(modelKey('claude'), 'claudeModel');
  assert.equal(modelKey('chatgpt'), 'model');
});

test('claudeSummary explains each setup state', () => {
  assert.match(claudeSummary({ installed: false }), /not installed/);
  assert.match(claudeSummary({ installed: true, loggedIn: false }), /Sign in once/);
  assert.match(claudeSummary({ installed: true, loggedIn: true, ready: false }), /API key/);
  assert.equal(
    claudeSummary({ installed: true, loggedIn: true, ready: true, subscriptionType: 'max' }),
    'Signed in · Max plan',
  );
});

test('usageSummary prefers the weekly window and omits unknown data', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const text = usageSummary(
    { sevenDay: { utilization: 0.774, resetsAt: now / 1000 + 3 * 86400 } },
    now,
  );
  assert.match(text, /^77% of weekly limit used · resets /);
  assert.equal(usageSummary(null), '');
  assert.equal(usageSummary({ fiveHour: { utilization: 0.1 } }), '10% of 5-hour limit used');
});
