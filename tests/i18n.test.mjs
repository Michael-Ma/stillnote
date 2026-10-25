import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLanguage, translator } from '../app/i18n/index.mjs';
import zh from '../app/i18n/zh-Hans.mjs';
import { usedKeys } from '../scripts/i18n-keys.mjs';

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every interface string in app/ has a Chinese translation', () => {
  const missing = [...usedKeys().keys()].filter((key) => !(key in zh));
  assert.deepEqual(missing, [], 'run `node scripts/i18n-keys.mjs` to list them');
});

test('translations keep the placeholders of their English key', () => {
  for (const [key, value] of Object.entries(zh))
    assert.deepEqual(placeholders(value), placeholders(key), `placeholders differ for "${key}"`);
});

test('the interface follows the setting, else the first macOS language Stillnote has', () => {
  assert.equal(resolveLanguage('zh-Hans', ['en-US']), 'zh-Hans');
  assert.equal(resolveLanguage('en', ['zh-Hans-CN']), 'en');
  assert.equal(resolveLanguage('system', ['zh-Hant-TW', 'en-US']), 'zh-Hans');
  assert.equal(resolveLanguage('system', ['fr-FR', 'en-GB']), 'en');
  assert.equal(resolveLanguage(undefined, ['ja-JP']), 'en');
});

test('t fills placeholders, falls back to English, and picks plurals', () => {
  const en = translator('en');
  assert.equal(en('Recording {n}', { n: 2 }), 'Recording 2');
  assert.equal(en.count(1, '{n} note', '{n} notes'), '1 note');
  assert.equal(en.count(3, '{n} note', '{n} notes'), '3 notes');
  const missing = [];
  const zhT = translator('zh-Hans', { missing: (key) => missing.push(key) });
  assert.equal(zhT('A sentence nobody translated'), 'A sentence nobody translated');
  assert.deepEqual(missing, ['A sentence nobody translated']);
  assert.equal(zhT.locale, 'zh-CN');
});

test('helper messages are translated, including ones with a part filled in', async () => {
  const { helperMessage } = await import('../app/helper-messages.mjs');
  const fake = translator('en');
  // English stays English, with the filled-in part named for people.
  assert.equal(
    helperMessage(
      'Download the zh-CN language in Settings to enable transcription. Audio is still saved.',
      fake,
    ),
    'Download the Chinese (China) language in Settings to enable transcription. Audio is still saved.',
  );
  const zhT = translator('zh-Hans');
  const translated = helperMessage(
    'Microphone input restarted on AirPods Pro. The capture gap is padded with silence.',
    zhT,
  );
  assert.match(translated, /AirPods Pro/);
  assert.notEqual(
    translated,
    'Microphone input restarted on AirPods Pro. The capture gap is padded with silence.',
  );
  assert.equal(
    helperMessage('Something the helper never says.', zhT),
    'Something the helper never says.',
  );
});
