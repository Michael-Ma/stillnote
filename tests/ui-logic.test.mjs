import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanError,
  languageName,
  languageOptions,
  recordingLanguage,
  silentState,
} from '../app/format.mjs';
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

test('CJK notes match by neighbouring characters, not common single ones', () => {
  const isOwn = ownLineMatcher('我们保存原始记录');
  assert.equal(isOwn('团队决定：我们保存原始记录。'), true);
  assert.equal(isOwn('下周讨论定价方案'), false);
  assert.equal(ownLineMatcher('我们的目标')('我们的计划是什么'), false, 'only 我们的 in common');
  assert.equal(ownLineMatcher('用React开发定价页')('决定用 React 开发定价页。'), true);
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

test('cleanError removes Electron remote error names without hiding the useful message', () => {
  for (const name of ['Error', 'TypeError', 'SyntaxError', 'RangeError', 'CustomError'])
    assert.equal(
      cleanError(`Error invoking remote method 'stillnote:state': ${name}: Try again.`),
      'Try again.',
    );
  assert.equal(cleanError(new Error('Cannot read notebook.')), 'Cannot read notebook.');
  assert.equal(
    cleanError("Error invoking remote method 'stillnote:state': Unknown operation."),
    'Unknown operation.',
  );
});

test('cleanError gives cancellation and timeout calm, distinct messages', () => {
  assert.equal(
    cleanError(
      "Error invoking remote method 'stillnote:ai': AbortError: This operation was aborted",
    ),
    'Stopped.',
  );
  assert.equal(cleanError(new DOMException('Cancelled by user', 'AbortError')), 'Stopped.');
  assert.equal(
    cleanError('The operation was aborted.', { timedOut: true }),
    'Timed out after 5 minutes. Your notes are unchanged.',
  );
  assert.equal(
    cleanError('TimeoutError: The operation timed out'),
    'Timed out after 5 minutes. Your notes are unchanged.',
  );
  assert.equal(cleanError('Request cancelled', { stopped: true }), 'Stopped.');
  assert.equal(
    cleanError(
      "Error invoking remote method 'stillnote:ai': TimeoutError: The operation was aborted",
    ),
    'Timed out after 5 minutes. Your notes are unchanged.',
  );
  assert.equal(
    cleanError('Audio devices timed out after 10 seconds.'),
    'Audio devices timed out after 10 seconds.',
  );
});

test('language display supports the complete native locale list and falls back safely', () => {
  assert.equal(languageName('en-US', 'en'), 'English (United States)');
  assert.equal(languageName('zh-TW', 'en'), 'Chinese (Taiwan)');
  assert.equal(recordingLanguage('auto', ['zh-CN', 'en-US'], 'en'), 'Auto (Chinese + English)');
  assert.equal(
    recordingLanguage('auto', ['zh-CN', 'zh-TW'], 'en'),
    'Auto (Chinese (China) + Chinese (Taiwan))',
  );
  assert.equal(recordingLanguage('en-US', [], 'en'), 'English (United States)');
  assert.equal(languageName('not_a_locale', 'en'), 'not_a_locale');
});

test('language options are deduplicated, sorted by display name, and mark only installed locales', () => {
  const input = { supported: ['ja-JP', 'en-US', 'de-DE', 'en-US'], installed: ['en-US', 'fr-FR'] };
  const options = languageOptions(input, 'en');
  assert.deepEqual(
    options.map((o) => o.locale),
    ['en-US', 'de-DE', 'ja-JP'],
  );
  assert.deepEqual(
    options.map((o) => o.installed),
    [true, false, false],
  );
  assert.equal(input.supported.length, 4);
  assert.deepEqual(languageOptions(null), []);
});

test('legacy language options show exactly the locales supported on this Mac', () => {
  const locales = ['en-US', 'en-ID'];
  const options = languageOptions(
    { engine: 'legacy', supported: locales, installed: locales },
    'en',
  );
  assert.equal(options.length, 2);
  assert.ok(options.every((o) => o.installed));
  assert.ok(!options.some((o) => o.locale === 'zh-CN'));
});

test('silence warnings track independent sources and clear when their signal returns', () => {
  const mic = {
    type: 'source-silent',
    source: 'microphone',
    recordingId: 'a',
    device: 'External Microphone',
  };
  const first = silentState({}, mic, 'a');
  const both = silentState(first, { ...mic, source: 'system', device: '' }, 'a');
  assert.deepEqual(first, { microphone: 'External Microphone' });
  assert.deepEqual(both, { microphone: 'External Microphone', system: 'meeting audio' });
  assert.deepEqual(silentState(both, { ...mic, type: 'source-signal' }, 'a'), {
    system: 'meeting audio',
  });
  assert.deepEqual(silentState({}, { ...mic, device: '' }, 'a'), { microphone: 'microphone' });
});

test('silence warnings ignore stale recordings and unknown sources', () => {
  const state = { microphone: 'Built-in microphone' };
  assert.equal(
    silentState(state, { type: 'source-signal', source: 'microphone', recordingId: 'old' }, 'new'),
    state,
  );
  assert.equal(
    silentState(state, { type: 'source-silent', source: 'other', recordingId: 'a' }, 'a'),
    state,
  );
  assert.equal(silentState(state, { type: 'source-silent', source: 'system' }, null), state);
});

test('silence warnings reset at recording lifecycle boundaries', () => {
  for (const event of [
    { type: 'started' },
    { type: 'stopped' },
    { type: 'error', recording: null },
  ])
    assert.deepEqual(silentState({ microphone: 'External' }, event, 'a'), {});
  const state = { microphone: 'External' };
  assert.equal(silentState(state, { type: 'warning', message: 'Permission needed' }, 'a'), state);
});
