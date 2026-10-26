// Runs the user's own, unmodified Claude Code CLI with their Claude plan. Stillnote never reads
// Claude credentials or the keychain: sign-in completes in Anthropic's own `claude auth login` flow.
import { spawn as nodeSpawn } from 'node:child_process';
import { accessSync, statSync, mkdirSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

import { checkConfiguration, ROUTING } from './claude-config.mjs';
import { claudeModels } from '../ai-view.mjs';
export { claudeModels };
export const subscriptionMethods = ['claude.ai', 'oauth_token'];
const INSTALL = 'Install Claude Code to use your Claude plan.';
const SIGN_IN = 'Sign in to Claude in Settings.';
const UPDATE = 'Update Claude Code (run `claude update`) to use it with Stillnote.';
const ENDED = 'Connection ended before Claude finished. Your previous notes are unchanged.';
const API_BILLING =
  'Claude Code on this Mac is signed in with an API key, not a Claude plan. Sign in with your Claude plan in Settings.';

export const defaultCandidates = (home) => [
  join(home, '.local/bin/claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  join(home, '.claude/local/claude'),
  join(home, '.npm-global/bin/claude'),
];

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// API keys in the environment take precedence over the plan sign-in in `claude -p`.
export function cliEnv(env, binary, home) {
  const result = { ...env };
  delete result.ANTHROPIC_API_KEY;
  delete result.ANTHROPIC_AUTH_TOKEN;
  // Packaged GUI apps start with a minimal PATH.
  result.PATH = [
    binary && dirname(binary),
    join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
  ]
    .filter(Boolean)
    .join(':');
  return result;
}

const text = (content) =>
  typeof content === 'string' ? content : (content ?? []).map((part) => part?.text ?? '').join('');

// Responses-style input → one prompt. Sources first, then earlier turns, then the question.
export function flattenInput(input) {
  const items = (Array.isArray(input) ? input : [{ role: 'user', content: input }]).map((m) => ({
    role: m.role,
    content: text(m.content),
  }));
  const last = items.at(-1)?.role === 'user' ? items.pop() : null;
  const context = items.filter((m) => ['developer', 'system'].includes(m.role));
  const turns = items.filter((m) => ['user', 'assistant'].includes(m.role));
  const parts = context.map((m) => m.content);
  if (turns.length)
    parts.push(
      'EARLIER CONVERSATION:\n' +
        turns.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n'),
    );
  if (last) parts.push(parts.length ? 'CURRENT QUESTION:\n' + last.content : last.content);
  return parts.join('\n\n');
}

export function normalizeUsage(info) {
  if (!info || typeof info !== 'object') return null;
  const window = (w) =>
    w && { utilization: Number(w.utilization) || 0, resetsAt: Number(w.resetsAt) || null };
  return {
    status: info.status ?? null,
    type: info.rateLimitType ?? null,
    resetsAt: Number(info.resetsAt) || null,
    fiveHour: window(info.unifiedWindows?.five_hour) ?? null,
    sevenDay: window(info.unifiedWindows?.seven_day) ?? null,
  };
}

const resetTime = (seconds) =>
  new Date(seconds * 1000).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

export function friendlyError(message = '', usage = null) {
  if (/unknown option|unrecognized option|error: option/i.test(message)) return UPDATE;
  if (/not logged in|\/login|login expired|oauth token|invalid api key|authenticat/i.test(message))
    return SIGN_IN;
  if (
    usage?.status === 'rejected' ||
    /(session|weekly|usage|opus|sonnet|rate) limit|hit your .*limit/i.test(message)
  )
    return (
      'Claude plan usage limit reached.' +
      (usage?.resetsAt ? ` It resets ${resetTime(usage.resetsAt)}.` : ' Try again later.')
    );
  const line = message.trim().split('\n')[0].slice(0, 200);
  return line ? `Claude could not complete the response: ${line}` : ENDED;
}

const abortError = (signal) =>
  signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('This operation was aborted', 'AbortError');

export class ClaudeCode {
  constructor({
    workDir,
    spawn = nodeSpawn,
    env = process.env,
    home = homedir(),
    candidates = defaultCandidates(home),
    shell = '/bin/zsh',
    executable = isExecutable,
    onChange = () => {},
    configurationCheck = checkConfiguration,
  } = {}) {
    Object.assign(this, {
      workDir,
      spawn,
      env,
      home,
      candidates,
      shell,
      executable,
      onChange,
      configurationCheck,
    });
    this.state = {
      installed: null,
      checking: false,
      path: null,
      version: null,
      loggedIn: false,
      authMethod: null,
      subscriptionType: null,
      email: null,
      usage: null,
      error: null,
      loginUrl: null,
    };
  }
  status() {
    const s = this.state;
    const ready = !!(s.loggedIn && !s.error && subscriptionMethods.includes(s.authMethod));
    return {
      id: 'claude',
      label: 'Claude',
      installed: s.installed,
      checking: s.checking,
      path: s.path,
      version: s.version,
      loggedIn: s.loggedIn,
      authMethod: s.authMethod,
      subscriptionType: s.subscriptionType,
      email: s.email,
      ready,
      billing: s.loggedIn
        ? ready
          ? 'subscription'
          : subscriptionMethods.includes(s.authMethod)
            ? null
            : 'api'
        : null,
      usage: s.usage,
      signingIn: !!this.login,
      loginUrl: this.login ? s.loginUrl : null,
      error: s.error,
    };
  }
  update(patch) {
    Object.assign(this.state, patch);
    this.onChange(this.status());
  }
  setPath(path) {
    this.override = path || undefined;
    this.found = undefined;
    this.missingUntil = 0;
    this.state.version = null;
    return this.refresh();
  }
  async locate() {
    if (this.override) return this.executable(this.override) ? this.override : null;
    if (this.found && this.executable(this.found)) return this.found;
    if (Date.now() < (this.missingUntil ?? 0)) return null;
    this.found = this.candidates.find((path) => this.executable(path));
    if (!this.found && this.shell) {
      // Last resort for custom installs: ask the user's login shell.
      const { stdout } = await this.run(this.shell, ['-lc', 'command -v claude'], {
        timeout: 10000,
      }).catch(() => ({ stdout: '' }));
      const path = stdout.trim().split('\n').at(-1);
      if (path?.startsWith('/') && this.executable(path)) this.found = path;
    }
    if (!this.found) this.missingUntil = Date.now() + 60000;
    return this.found ?? null;
  }
  options(binary, env = this.env) {
    if (this.workDir) mkdirSync(this.workDir, { recursive: true, mode: 0o700 });
    return {
      cwd: this.workDir,
      env: cliEnv(env, binary, this.home),
      stdio: ['pipe', 'pipe', 'pipe'],
    };
  }
  run(command, args, { timeout = 10000, input, options } = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawn(command, args, options ?? this.options(command));
      let stdout = '',
        stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Claude Code did not respond in time.'));
      }, timeout);
      child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }
  load() {
    void this.refresh();
  }
  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.check()
      .then(() => this.status())
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }
  async check(options, checkedPath) {
    this.update({ checking: true });
    try {
      const path = checkedPath ?? (await this.locate());
      if (!path) {
        this.update({ installed: false, path: null, loggedIn: false, authMethod: null });
        return { ...this.status(), checking: false };
      }
      if (!this.state.version || this.state.path !== path) {
        const v = await this.run(path, ['--version'], { options });
        this.state.version = v.stdout.trim().split(/\s/)[0] || null;
      }
      const effective = options ?? this.options(path);
      this.configurationCheck({ env: effective.env, home: this.home, workDir: this.workDir });
      const r = await this.run(path, ['--safe-mode', 'auth', 'status', '--json'], {
        options: effective,
      });
      let auth = null;
      try {
        auth = JSON.parse(r.stdout);
      } catch {}
      // A status probe carries no meeting text. Require the same effective environment and
      // fresh, readable direct-plan status before every inference; the UI cache is not authority.
      let configurationError = null;
      if (auth?.loggedIn) {
        try {
          if (
            r.code !== 0 ||
            auth.apiProvider !== 'firstParty' ||
            !['pro', 'max'].includes(auth.subscriptionType)
          )
            throw new Error(ROUTING);
          this.configurationCheck({
            env: effective.env,
            home: this.home,
            workDir: this.workDir,
            configDirectory: auth.configDirectory,
          });
        } catch (error) {
          configurationError = error.message;
        }
      }
      this.update({
        installed: true,
        path,
        loggedIn: !!auth?.loggedIn,
        authMethod: auth?.authMethod ?? 'none',
        subscriptionType: auth?.subscriptionType ?? null,
        email: auth?.email ?? null,
        error:
          configurationError ||
          (auth && typeof auth.loggedIn === 'boolean'
            ? null
            : 'Could not read the Claude Code sign-in status.'),
      });
      return { ...this.status(), checking: false };
    } catch (e) {
      this.update({
        loggedIn: false,
        authMethod: null,
        error: e.code === 'ENOENT' ? INSTALL : e.message,
      });
      return { ...this.status(), checking: false };
    } finally {
      this.update({ checking: false });
    }
  }
  async signIn() {
    if (this.login) throw new Error('Claude sign-in is already in progress.');
    const path = await this.locate();
    if (!path) throw new Error(INSTALL);
    const child = this.spawn(path, ['auth', 'login', '--claudeai'], this.options(path));
    this.login = child;
    this.cancelled = false;
    this.update({ loginUrl: null, error: null });
    const capture = (d) => {
      const url = String(d).match(/https:\/\/\S+/)?.[0];
      if (url && !this.state.loginUrl) this.update({ loginUrl: url });
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.stdin.on('error', () => {});
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('Claude sign-in timed out. Please try again.'));
        }, 600000);
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(e.code === 'ENOENT' ? new Error(INSTALL) : e);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (this.cancelled) reject(new Error('Sign-in cancelled.'));
          else if (code === 0) resolve();
          else
            reject(
              new Error(
                'Claude sign-in did not complete. Try again, or sign in from Terminal with `claude auth login`.',
              ),
            );
        });
      });
    } finally {
      this.login = undefined;
      this.update({ loginUrl: null });
      await this.refresh();
    }
    return this.status();
  }
  cancel() {
    if (!this.login) return;
    this.cancelled = true;
    this.login.kill();
  }
  // Signing out would also sign the user's own Claude Code out, so Stillnote never does it.
  disconnect() {
    return this.status();
  }
  async models() {
    return claudeModels;
  }
  async respond({ model, input, instructions, onDelta = () => {}, signal }) {
    signal?.throwIfAborted();
    // Finish an older UI check, then run a new one. Snapshot the environment so the auth
    // probe and print process cannot see different inherited routing/credentials.
    await this.refreshing;
    const path = await this.locate();
    if (!path) throw new Error(INSTALL);
    const options = this.options(path, { ...this.env });
    const verified = await this.check(options, path);
    signal?.throwIfAborted();
    if (verified.loggedIn && !subscriptionMethods.includes(verified.authMethod))
      throw new Error(API_BILLING);
    if (verified.error) throw new Error(verified.error);
    if (!verified.loggedIn) throw new Error(SIGN_IN);
    // Detect a settings edit while auth was being queried, too.
    this.configurationCheck({ env: options.env, home: this.home, workDir: this.workDir });
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model',
      model || claudeModels[0].id,
      '--tools',
      '',
      '--safe-mode',
      '--no-session-persistence',
      '--max-turns',
      '1',
    ];
    if (instructions) args.push('--system-prompt', instructions);
    signal?.throwIfAborted();
    const child = this.spawn(path, args, options);
    let buffer = '',
      streamed = '',
      stderr = '',
      result,
      usage;
    const line = (raw) => {
      if (!raw.trim()) return;
      let e;
      try {
        e = JSON.parse(raw);
      } catch {
        return;
      }
      if (
        e.type === 'stream_event' &&
        e.event?.type === 'content_block_delta' &&
        e.event.delta?.type === 'text_delta'
      ) {
        streamed += e.event.delta.text;
        onDelta(e.event.delta.text);
      }
      if (e.type === 'rate_limit_event') {
        usage = normalizeUsage(e.rate_limit_info);
        this.update({ usage });
      }
      if (e.type === 'result') result = e;
    };
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const code = await new Promise((resolve, reject) => {
        child.stdout.setEncoding('utf8').on('data', (d) => {
          buffer += d;
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            line(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
          }
        });
        child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
        child.stdin.on('error', () => {});
        child.stdin.end(flattenInput(input));
        child.on('error', reject);
        child.on('close', resolve);
      });
      line(buffer);
      if (signal?.aborted) throw abortError(signal);
      if (result && result.subtype === 'success' && !result.is_error) {
        const final = typeof result.result === 'string' ? result.result : streamed;
        if (!final.trim()) throw new Error('Claude returned an empty response.');
        return final;
      }
      if (result) throw new Error(friendlyError(String(result.result ?? stderr), usage));
      if (code !== 0 && stderr.trim()) throw new Error(friendlyError(stderr, usage));
      throw new Error(ENDED);
    } catch (e) {
      if (signal?.aborted) throw abortError(signal);
      if (e.code === 'ENOENT') throw new Error(INSTALL);
      throw e;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
}
