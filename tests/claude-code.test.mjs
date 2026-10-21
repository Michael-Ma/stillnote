import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ClaudeCode,
  flattenInput,
  cliEnv,
  friendlyError,
  normalizeUsage,
} from '../app/providers/claude-code.mjs';
import { aiState, pickProvider, terminalScript } from '../app/providers/index.mjs';

const fake = resolve(import.meta.dirname, 'fixtures/fake-claude.mjs');
const binary = '/fixture/bin/claude';

function fixture(t, vars = {}, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-claude-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.jsonl');
  const changes = [];
  const claude = new ClaudeCode({
    workDir: join(dir, 'work'),
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-fixture', ...vars, FAKE_CLAUDE_LOG: log },
    candidates: [binary],
    executable: (path) => path === binary,
    shell: null,
    // Run the fake CLI wherever the provider would run the real binary.
    spawn: (command, args, opts) =>
      command === binary
        ? spawn(process.execPath, [fake, ...args], opts)
        : spawn(command, args, opts),
    onChange: (status) => changes.push(status),
    ...options,
  });
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  return { claude, calls, changes, dir };
}
const ask = (claude, extra = {}) => {
  const deltas = [];
  return {
    deltas,
    promise: claude.respond({
      model: 'haiku',
      input: [{ role: 'user', content: 'Who ships?' }],
      instructions: 'Be careful.',
      onDelta: (d) => deltas.push(d),
      ...extra,
    }),
  };
};

test('refresh reports a ready Claude plan from auth status', async (t) => {
  const { claude, changes } = fixture(t);
  const status = await claude.refresh();
  assert.equal(status.installed, true);
  assert.equal(status.path, binary);
  assert.equal(status.version, '2.1.299');
  assert.equal(status.ready, true);
  assert.equal(status.billing, 'subscription');
  assert.equal(status.subscriptionType, 'max');
  assert.equal(status.checking, false);
  assert.ok(changes.some((s) => s.checking) && !changes.at(-1).checking);
});

test('an API-key sign-in or a signed-out CLI is not treated as a Claude plan', async (t) => {
  const api = fixture(t, { FAKE_CLAUDE_AUTH: 'api_key' }).claude;
  const status = await api.refresh();
  assert.equal(status.ready, false);
  assert.equal(status.billing, 'api');
  await assert.rejects(ask(api).promise, /signed in with an API key/);
  const out = fixture(t, { FAKE_CLAUDE_AUTH: 'logged-out' }).claude;
  const signedOut = await out.refresh();
  assert.equal(signedOut.loggedIn, false);
  assert.equal(signedOut.ready, false);
  assert.equal(signedOut.error, null);
  await assert.rejects(ask(out).promise, /Sign in to Claude in Settings/);
});

test('a missing CLI reports that Claude Code needs installing', async (t) => {
  const { claude } = fixture(t, {}, { candidates: [] });
  assert.equal((await claude.refresh()).installed, false);
  await assert.rejects(ask(claude).promise, /Install Claude Code/);
});

test('the login shell finds custom installs', async (t) => {
  const { claude } = fixture(
    t,
    {},
    {
      candidates: [],
      shell: '/fixture/zsh',
      spawn: (command, args, opts) =>
        command === '/fixture/zsh'
          ? spawn(process.execPath, ['-e', `console.log('noise\\n${binary}')`], opts)
          : spawn(process.execPath, [fake, ...args], opts),
    },
  );
  assert.equal(await claude.locate(), binary);
});

test('respond streams split UTF-8 deltas, isolates the CLI and records plan usage', async (t) => {
  const { claude, calls } = fixture(t);
  const { deltas, promise } = ask(claude);
  assert.equal(await promise, '会议 ✅ Alex ships');
  assert.equal(deltas.join(''), '会议 ✅ Alex ships');
  const call = calls().find((c) => c.args[0] === '-p');
  assert.equal(call.prompt, 'Who ships?');
  assert.equal(call.apiKey, false, 'API keys must not reach the CLI');
  assert.equal(call.cwd.endsWith('/work'), true);
  for (const flag of ['--safe-mode', '--no-session-persistence', '--include-partial-messages'])
    assert.ok(call.args.includes(flag), flag);
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'haiku');
  assert.equal(call.args[call.args.indexOf('--system-prompt') + 1], 'Be careful.');
  assert.ok(!call.args.includes('--bare'), '--bare would ignore the Claude plan sign-in');
  assert.equal(claude.status().usage.sevenDay.utilization, 0.4);
});

test('respond maps CLI failures to recoverable messages', async (t) => {
  const cases = [
    ['not-logged-in', /Sign in to Claude in Settings/],
    ['limit', /Claude plan usage limit reached\. It resets/],
    ['empty', /empty response/],
    ['crash', /Claude could not complete the response: boom/],
    ['cut', /Connection ended before Claude finished/],
    ['unknown-option', /claude update/],
  ];
  for (const [mode, pattern] of cases) {
    const { claude } = fixture(t, { FAKE_CLAUDE_MODE: mode });
    await assert.rejects(ask(claude).promise, pattern, mode);
  }
});

test('aborting kills the CLI and rejects as an abort', async (t) => {
  const { claude } = fixture(t, { FAKE_CLAUDE_MODE: 'slow' });
  const controller = new AbortController();
  const { deltas, promise } = ask(claude, { signal: controller.signal });
  while (!deltas.length) await new Promise((r) => setTimeout(r, 10));
  controller.abort();
  await assert.rejects(promise, (e) => e.name === 'AbortError');
});

test('sign-in runs the CLI login, surfaces its URL and can be cancelled', async (t) => {
  const ok = fixture(t);
  const status = await ok.claude.signIn();
  assert.equal(status.ready, true);
  assert.equal(status.signingIn, false);
  assert.ok(ok.calls().some((c) => c.args.join(' ') === 'auth login --claudeai'));
  assert.ok(ok.changes.some((s) => s.loginUrl?.startsWith('https://claude.ai/oauth')));
  const hang = fixture(t, { FAKE_CLAUDE_LOGIN: 'hang' }).claude;
  const pending = hang.signIn();
  while (!hang.status().signingIn) await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(hang.signIn(), /already in progress/);
  hang.cancel();
  await assert.rejects(pending, /cancelled/);
  assert.equal(hang.status().signingIn, false);
  const fail = fixture(t, { FAKE_CLAUDE_LOGIN: 'fail' }).claude;
  await assert.rejects(fail.signIn(), /claude auth login/);
});

test('input flattening keeps sources, earlier turns and the question in order', () => {
  assert.equal(flattenInput([{ role: 'user', content: 'Summarize.' }]), 'Summarize.');
  assert.equal(
    flattenInput([
      { role: 'developer', content: 'CURRENT MEETING SOURCES:\nSOURCE [1]' },
      { role: 'user', content: 'What happened?' },
      { role: 'assistant', content: 'A launch. [1]' },
      { role: 'user', content: [{ type: 'input_text', text: 'When?' }] },
    ]),
    'CURRENT MEETING SOURCES:\nSOURCE [1]\n\nEARLIER CONVERSATION:\nUser: What happened?\n\nAssistant: A launch. [1]\n\nCURRENT QUESTION:\nWhen?',
  );
});

test('CLI environment drops API credentials and extends PATH for GUI launches', () => {
  const env = cliEnv(
    { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'y', KEEP: '1' },
    '/opt/tools/claude',
    '/Users/fixture',
  );
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.KEEP, '1');
  assert.equal(
    env.PATH,
    '/opt/tools:/Users/fixture/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin',
  );
});

test('usage and error helpers', () => {
  assert.equal(normalizeUsage(null), null);
  assert.deepEqual(
    normalizeUsage({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.5 } } })
      .fiveHour,
    { utilization: 0.5, resetsAt: null },
  );
  assert.match(friendlyError('Login expired · Please run /login'), /Sign in/);
  assert.match(friendlyError('anything', { status: 'rejected' }), /usage limit/);
  assert.match(friendlyError(''), /Connection ended/);
});

test('provider selection prefers an explicit choice, then a ready plan', () => {
  const ready = { ready: true },
    idle = { ready: false };
  assert.equal(pickProvider('claude', { chatgpt: ready, claude: idle }), 'claude');
  assert.equal(pickProvider(undefined, { chatgpt: ready, claude: ready }), 'chatgpt');
  assert.equal(pickProvider(undefined, { chatgpt: idle, claude: ready }), 'claude');
  assert.equal(pickProvider('bogus', { chatgpt: idle, claude: idle }), null);
  const state = aiState(undefined, { connected: true, sharing: true }, { id: 'claude', ...idle });
  assert.equal(state.provider, 'chatgpt');
  assert.equal(state.chosen, null);
  assert.equal(state.chatgpt.ready, true);
  assert.equal(state.chatgpt.id, 'chatgpt');
});

test('Terminal setup scripts only run the official installer and CLI login', () => {
  const signIn = terminalScript('sign-in', "/Users/o'neil/.local/bin/claude");
  assert.match(signIn, /^#!\/bin\/zsh -l\n/);
  assert.ok(signIn.includes(`'/Users/o'\\''neil/.local/bin/claude' auth login --claudeai`));
  const install = terminalScript('install');
  assert.ok(install.includes('curl -fsSL https://claude.ai/install.sh | bash && '));
  assert.ok(install.includes('"$HOME/.local/bin/claude" auth login --claudeai'));
  assert.throws(() => terminalScript('rm -rf'), /Unknown/);
});
