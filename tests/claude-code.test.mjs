import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
    home: dir,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: 'sk-fixture',
      ...vars,
      CLAUDE_CONFIG_DIR: join(dir, 'config'),
      FAKE_CLAUDE_LOG: log,
    },
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
          .split('\n')
          // The fake creates the file before writing to it; only newline-ended lines are complete.
          .slice(0, -1)
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

test('abort during authentication never starts inference', async (t) => {
  const { claude, calls } = fixture(t);
  const controller = new AbortController();
  const spawnCLI = claude.spawn;
  const spawned = [];
  claude.spawn = (command, args, options) => {
    spawned.push(args);
    const child = spawnCLI(command, args, options);
    // Abort as the probe starts, so it is always in flight and there is no clock to race.
    if (args.includes('status')) controller.abort();
    return child;
  };
  await assert.rejects(
    ask(claude, { signal: controller.signal }).promise,
    (error) => error.name === 'AbortError',
  );
  // The probe approved the sign-in, so only the abort stood between it and inference.
  assert.equal(claude.status().ready, true);
  // A killed child never reads stdin and so never logs, which is why the spawn is checked too.
  assert.equal(spawned.filter((args) => args[0] === '-p').length, 0);
  assert.equal(calls().filter((call) => call.args[0] === '-p').length, 0);
});
test('abort during locate never starts inference', async (t) => {
  const { claude, calls } = fixture(t);
  await claude.refresh();
  const controller = new AbortController();
  const locate = claude.locate.bind(claude);
  claude.locate = async () => {
    controller.abort();
    return locate();
  };
  await assert.rejects(
    ask(claude, { signal: controller.signal }).promise,
    (error) => error.name === 'AbortError',
  );
  assert.equal(calls().filter((call) => call.args[0] === '-p').length, 0);
});
test('abort in the spawn/listener gap kills the child immediately', async (t) => {
  const { claude } = fixture(t, { FAKE_CLAUDE_MODE: 'slow' });
  await claude.refresh();
  const controller = new AbortController();
  const spawnCLI = claude.spawn;
  let child;
  claude.spawn = (...args) => {
    child = spawnCLI(...args);
    if (args[1][0] === '-p') controller.abort();
    return child;
  };
  await assert.rejects(
    ask(claude, { signal: controller.signal }).promise,
    (error) => error.name === 'AbortError',
  );
  assert.equal(child.killed, true);
});
test('missing Claude discovery backs off for at least sixty seconds', async (t) => {
  const { claude } = fixture(t, {}, { candidates: [], shell: '/fixture/zsh' });
  let calls = 0;
  claude.run = async () => {
    calls++;
    return { stdout: '' };
  };
  assert.equal(await claude.locate(), null);
  assert.equal(await claude.locate(), null);
  await claude.refresh();
  assert.equal(calls, 1);
  assert.ok(claude.missingUntil >= Date.now() + 59000);
  claude.missingUntil = Date.now() - 1;
  assert.equal(await claude.locate(), null);
  assert.equal(calls, 2);
});

for (const auth of ['api_key', 'logged-out', 'unreadable', 'failed']) {
  test(`each inference rejects changed external auth: ${auth}`, async (t) => {
    const { claude, calls } = fixture(t);
    await claude.refresh();
    assert.equal(claude.status().ready, true);
    claude.env.FAKE_CLAUDE_AUTH = auth;
    await assert.rejects(ask(claude).promise);
    assert.equal(calls().filter((c) => c.args.includes('status')).length, 2);
    assert.equal(calls().filter((c) => c.args[0] === '-p').length, 0);
    assert.equal(claude.status().ready, false);
  });
}

test('custom endpoints, provider flags, settings routing and managed plans never receive prompts', async (t) => {
  for (const vars of [
    { ANTHROPIC_BASE_URL: 'https://gateway.example.invalid' },
    { CLAUDE_CODE_USE_BEDROCK: '1' },
    { CLAUDE_CODE_USE_VERTEX: 'true' },
    { CLAUDE_CODE_USE_FOUNDRY: '1' },
    { CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' },
    { FAKE_CLAUDE_PROVIDER: 'bedrock' },
    { FAKE_CLAUDE_PLAN: 'enterprise' },
  ]) {
    const { claude, calls } = fixture(t, vars);
    await assert.rejects(ask(claude).promise, /direct Claude Pro or Max/);
    assert.ok(!calls().some((c) => c.args[0] === '-p'));
  }
  for (const settings of [
    { env: { ANTHROPIC_BASE_URL: 'https://gateway.example.invalid' } },
    { env: { ANTHROPIC_API_KEY: 'fixture' } },
    { apiKeyHelper: 'fixture command' },
    { policyHelper: 'fixture command' },
  ]) {
    const { claude, calls } = fixture(t);
    await claude.refresh();
    mkdirSync(claude.env.CLAUDE_CONFIG_DIR);
    writeFileSync(join(claude.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify(settings));
    await assert.rejects(ask(claude).promise, /direct Claude Pro or Max/);
    assert.ok(!calls().some((c) => c.args[0] === '-p'));
  }
});

test('an unreadable settings file fails closed without changing it', async (t) => {
  const { claude, calls } = fixture(t);
  mkdirSync(claude.env.CLAUDE_CONFIG_DIR);
  const path = join(claude.env.CLAUDE_CONFIG_DIR, 'settings.json');
  writeFileSync(path, '{invalid');
  await assert.rejects(ask(claude).promise, /Could not verify Claude Code settings/);
  assert.equal(readFileSync(path, 'utf8'), '{invalid');
  assert.ok(!calls().some((c) => c.args[0] === '-p'));
});

test('inference uses the exact binary verified by its own auth probe', async (t) => {
  const { claude, calls } = fixture(t);
  let locates = 0;
  claude.locate = async () => (++locates === 1 ? binary : '/unexpected/changed-claude');
  assert.equal(await ask(claude).promise, '会议 ✅ Alex ships');
  assert.equal(locates, 1);
  assert.ok(
    calls()
      .find((c) => c.args.includes('status'))
      .args.includes('--safe-mode'),
  );
});

test('a later UI status update cannot approve a failed inference auth probe', async (t) => {
  const { claude, calls } = fixture(t, { FAKE_CLAUDE_AUTH: 'unreadable' });
  const check = claude.check.bind(claude);
  claude.check = async (...args) => {
    const verified = await check(...args);
    claude.update({ loggedIn: true, authMethod: 'claude.ai', error: null });
    return verified;
  };
  await assert.rejects(ask(claude).promise, /Could not read/);
  assert.ok(!calls().some((c) => c.args[0] === '-p'));
});

test('managed configuration is rejected without overwriting organizational policy', async (t) => {
  const { claude, calls } = fixture(t);
  mkdirSync(claude.env.CLAUDE_CONFIG_DIR);
  const policy = join(claude.env.CLAUDE_CONFIG_DIR, 'remote-settings.json');
  const original = '{"permissions":{"deny":["Read(secrets)"]}}';
  writeFileSync(policy, original);
  await assert.rejects(ask(claude).promise, /managed Claude configurations are not supported/);
  assert.equal(readFileSync(policy, 'utf8'), original);
  assert.ok(!calls().some((c) => c.args[0] === '-p'));
});
