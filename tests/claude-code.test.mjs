import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ClaudeCode,
  flattenInput,
  cliEnv,
  friendlyError,
  normalizeUsage,
  managedWarning,
  MANAGED_ACCOUNT,
  MANAGED_MAC,
} from '../app/providers/claude-code.mjs';
import { checkConfiguration } from '../app/providers/claude-config.mjs';
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

test('a personal plan has no warning', async (t) => {
  const status = await fixture(t).claude.refresh();
  assert.equal(status.ready, true);
  assert.equal(status.warning, null);
});

test('Team and Enterprise plans work with a managed-account warning', async (t) => {
  for (const plan of ['team', 'enterprise']) {
    const { claude, calls } = fixture(t, { FAKE_CLAUDE_PLAN: plan });
    const status = await claude.refresh();
    assert.equal(status.ready, true);
    assert.equal(status.subscriptionType, plan);
    assert.equal(status.warning, MANAGED_ACCOUNT);
    await ask(claude).promise;
    assert.ok(calls().some((c) => c.args[0] === '-p'));
  }
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

test('a Claude account with a warning is used only once the user chooses it', () => {
  const idle = { ready: false },
    ready = { ready: true },
    managed = { ready: true, warning: MANAGED_ACCOUNT };
  // Nothing is picked on its own, so the connect prompt shows the warning before anything is sent.
  assert.equal(pickProvider(undefined, { chatgpt: idle, claude: managed }), null);
  assert.equal(pickProvider(undefined, { chatgpt: ready, claude: managed }), 'chatgpt');
  assert.equal(pickProvider('claude', { chatgpt: idle, claude: managed }), 'claude');
  const state = aiState(null, { connected: false }, { id: 'claude', ...managed });
  assert.equal(state.provider, null);
  assert.equal(state.claude.warning, MANAGED_ACCOUNT);
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

test('an unsupported plan is told which plans work and never receives prompts', async (t) => {
  for (const plan of ['free', 'unknown']) {
    const { claude, calls } = fixture(t, { FAKE_CLAUDE_PLAN: plan });
    await assert.rejects(ask(claude).promise, /needs a Claude Pro, Max, Team or Enterprise plan/);
    assert.ok(!calls().some((c) => c.args[0] === '-p'));
  }
});

test('custom endpoints, provider flags, settings routing and managed plans never receive prompts', async (t) => {
  for (const vars of [
    { ANTHROPIC_BASE_URL: 'https://gateway.example.invalid' },
    { CLAUDE_CODE_USE_BEDROCK: '1' },
    { CLAUDE_CODE_USE_VERTEX: 'true' },
    { CLAUDE_CODE_USE_FOUNDRY: '1' },
    { CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' },
    { CLAUDE_CODE_API_BASE_URL: 'https://gateway.example.invalid' },
    { ANTHROPIC_UNIX_SOCKET: '/tmp/fixture.sock' },
    { FAKE_CLAUDE_PROVIDER: 'bedrock' },
  ]) {
    const { claude, calls } = fixture(t, vars);
    await assert.rejects(ask(claude).promise, /cannot use this Claude configuration/);
    assert.ok(!calls().some((c) => c.args[0] === '-p'));
  }
  for (const settings of [
    { env: { ANTHROPIC_BASE_URL: 'https://gateway.example.invalid' } },
    { env: { ANTHROPIC_API_KEY: 'fixture' } },
    { env: { CLAUDE_CODE_API_BASE_URL: 'https://gateway.example.invalid' } },
    { apiKeyHelper: 'fixture command' },
    { policyHelper: 'fixture command' },
    { policyHelpers: { macos: { path: '/tmp/fixture' } } },
  ]) {
    const { claude, calls } = fixture(t);
    await claude.refresh();
    mkdirSync(claude.env.CLAUDE_CONFIG_DIR);
    writeFileSync(join(claude.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify(settings));
    await assert.rejects(ask(claude).promise, /cannot use this Claude configuration/);
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

test('managed settings that reroute nothing work with a warning and are left unchanged', async (t) => {
  for (const original of [
    '{}',
    '{"permissions":{"deny":["Read(secrets)"]},"forceLoginMethod":"claudeai"}',
    // Telemetry explicitly turned off is not an export.
    '{"env":{"CLAUDE_CODE_ENABLE_TELEMETRY":"0","OTEL_LOGS_EXPORTER":"none","OTEL_METRICS_EXPORTER":"none","OTEL_LOG_USER_PROMPTS":"0","ENABLE_BETA_TRACING_DETAILED":false,"DISABLE_TELEMETRY":"1","NO_PROXY":"*"}}',
  ]) {
    const { claude, calls } = fixture(t);
    mkdirSync(claude.env.CLAUDE_CONFIG_DIR);
    const policy = join(claude.env.CLAUDE_CONFIG_DIR, 'remote-settings.json');
    writeFileSync(policy, original);
    const status = await claude.refresh();
    assert.equal(status.ready, true);
    // A Max plan with settings managed on this Mac: switching plans would not help.
    assert.equal(status.warning, MANAGED_MAC);
    await ask(claude).promise;
    assert.ok(calls().some((c) => c.args[0] === '-p'));
    assert.equal(readFileSync(policy, 'utf8'), original);
  }
});

test('managed settings that reroute or copy prompts are rejected without overwriting them', async (t) => {
  for (const original of [
    '{"env":{"ANTHROPIC_BASE_URL":"https://gateway.example.invalid"}}',
    '{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"}}',
    '{"apiKeyHelper":"fixture command"}',
    '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"fixture"}]}]}}',
    '{"env":{"CLAUDE_CODE_ENABLE_TELEMETRY":"1"}}',
    '{"env":{"OTEL_LOG_USER_PROMPTS":"1"}}',
    '{"otelHeadersHelper":"fixture command"}',
    '{"env":{"HTTPS_PROXY":"http://proxy.example.invalid:8080"}}',
    '{"env":{"https_proxy":"http://proxy.example.invalid:8080"}}',
    '{"env":{"NODE_EXTRA_CA_CERTS":"/tmp/fixture.pem"}}',
    // Detailed tracing exports session content to its endpoint.
    '{"env":{"ENABLE_BETA_TRACING_DETAILED":"1","BETA_TRACING_ENDPOINT":"https://collector.example.invalid"}}',
    '{"env":{"BETA_TRACING_ENDPOINT":"https://collector.example.invalid"}}',
    '{"env":{"CLAUDE_CODE_ENHANCED_TELEMETRY_BETA":"1"}}',
    '{"env":{"CLAUDE_CODE_ENABLE_TELEMETRY":true}}',
    '{"env":{"OTEL_LOGS_EXPORTER":"otlp"}}',
    '{"env":{"OTEL_LOG_USER_PROMPTS":"0","OTEL_EXPORTER_OTLP_ENDPOINT":"https://collector.example.invalid"}}',
    '{"env":{"CLAUDE_CODE_HTTPS_PROXY":"http://proxy.example.invalid:8080"}}',
    '{"proxyAuthHelper":"fixture command"}',
    '{"env":{"CLAUDE_CODE_CERT_STORE":"system"}}',
    '{"env":{"SSL_CERT_FILE":"/tmp/fixture.pem"}}',
    '{"env":{"CLAUDE_CODE_API_BASE_URL":"https://gateway.example.invalid"}}',
    '{"env":{"ANTHROPIC_UNIX_SOCKET":"/tmp/fixture.sock"}}',
    '{"policyHelpers":{"macos":{"path":"/tmp/fixture"}}}',
    'not json',
    '[]',
  ]) {
    const { claude, calls } = fixture(t);
    mkdirSync(claude.env.CLAUDE_CONFIG_DIR);
    const policy = join(claude.env.CLAUDE_CONFIG_DIR, 'remote-settings.json');
    writeFileSync(policy, original);
    await assert.rejects(ask(claude).promise, /cannot use this Claude configuration/);
    assert.equal(readFileSync(policy, 'utf8'), original);
    assert.ok(!calls().some((c) => c.args[0] === '-p'));
  }
});

test('the warning says whether the account or this Mac is managed', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, 'config'),
    policyDir = join(dir, 'policy');
  const check = () =>
    checkConfiguration({
      env: {},
      home: dir,
      workDir: join(dir, 'work'),
      configDirectory: config,
      policyDir,
    });
  assert.deepEqual(check(), { managed: false, machine: false });
  assert.equal(managedWarning('max', check()), null);
  assert.equal(managedWarning('team', check()), MANAGED_ACCOUNT);
  // Remote settings come with the account.
  mkdirSync(config);
  writeFileSync(join(config, 'remote-settings.json'), '{}');
  assert.deepEqual(check(), { managed: true, machine: false });
  assert.equal(managedWarning('enterprise', check()), MANAGED_ACCOUNT);
  assert.equal(managedWarning('pro', check()), MANAGED_MAC);
  // This Mac's policy stays whichever plan signs in, so no plan advice.
  mkdirSync(join(policyDir, 'managed-settings.d'), { recursive: true });
  writeFileSync(join(policyDir, 'managed-settings.d', '10-org.json'), '{"permissions":{}}');
  assert.deepEqual(check(), { managed: true, machine: true });
  assert.equal(managedWarning('team', check()), MANAGED_MAC);
  assert.doesNotMatch(MANAGED_MAC, /Pro or Max/);
  writeFileSync(
    join(policyDir, 'managed-settings.d', '20-trace.json'),
    '{"env":{"BETA_TRACING_ENDPOINT":"https://collector.example.invalid"}}',
  );
  assert.throws(check, /cannot use this Claude configuration/);
});

test('a named pipe, device or folder at a settings path fails closed without hanging', (t) => {
  const module = pathToFileURL(resolve(import.meta.dirname, '../app/providers/claude-config.mjs'));
  for (const [name, make, expected] of [
    ['remote-settings.json', (path) => execFileSync('mkfifo', [path]), /cannot use this Claude/],
    ['settings.json', (path) => execFileSync('mkfifo', [path]), /Could not verify/],
    ['remote-settings.json', (path) => execFileSync('ln', ['-s', '/dev/zero', path]), /cannot use/],
    ['remote-settings.json', (path) => mkdirSync(path), /cannot use this Claude/],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'stillnote-fifo-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'config'));
    make(join(dir, 'config', name));
    // A blocking read would freeze this process, so the check runs in a child that can be killed.
    const options = { env: {}, home: dir, workDir: join(dir, 'work'), policyDir: join(dir, 'p') };
    const script = `import { checkConfiguration } from ${JSON.stringify(module.href)};
      try { checkConfiguration({ ...${JSON.stringify(options)}, configDirectory: ${JSON.stringify(join(dir, 'config'))} }); console.log('passed'); }
      catch (error) { console.log(error.message); }`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(child.signal, null, `${name} hung the settings check`);
    assert.match(child.stdout, expected);
  }
});
