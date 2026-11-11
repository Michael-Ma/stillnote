// Read configuration only, never Claude's credential files. Stillnote supports a directly
// connected Claude plan. Organization-managed settings are allowed only when they reroute nothing,
// and unreadable or unknown routing fails closed: disabling managed policy or overriding its
// endpoint would not be a safe way to use that plan.
import {
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  readdirSync,
  lstatSync,
  constants,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { userInfo } from 'node:os';

export const ROUTING =
  'Stillnote cannot use this Claude configuration. It sends requests to a custom endpoint or another provider, uses an API key, or has managed settings that could copy your notes elsewhere or cannot be checked. Your Claude configuration has not been changed.';
export const POLICY_DIR = '/Library/Application Support/ClaudeCode';
const active = (value) =>
  value != null && !['', '0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
const anthropic = /^https:\/\/api\.anthropic\.com\/?$/;
export function checkRouting(env) {
  // ANTHROPIC_UNIX_SOCKET sends API requests through a local socket instead of to Anthropic.
  if (env.ANTHROPIC_CUSTOM_HEADERS || env.ANTHROPIC_UNIX_SOCKET) throw new Error(ROUTING);
  // Claude Code also sends inference to CLAUDE_CODE_API_BASE_URL.
  for (const key of ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_API_BASE_URL'])
    if (env[key] && !anthropic.test(env[key])) throw new Error(ROUTING);
  for (const [key, value] of Object.entries(env)) {
    if (/^CLAUDE_CODE_USE_/.test(key) && active(value)) throw new Error(ROUTING);
    if (
      /^(ANTHROPIC_(AWS_|FOUNDRY_|VERTEX_|BEDROCK_)|CLAUDE_CODE_(GATEWAY|MANAGED|PARENT_SETTINGS))/.test(
        key,
      ) &&
      value
    )
      throw new Error(ROUTING);
  }
}

// One settings object (user, project or managed): anything that reroutes requests or swaps the
// credential is refused.
function checkSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw new Error(ROUTING);
  const configured = settings.env ?? {};
  if (typeof configured !== 'object' || Array.isArray(configured)) throw new Error(ROUTING);
  checkRouting(configured);
  if (
    configured.ANTHROPIC_API_KEY ||
    configured.ANTHROPIC_AUTH_TOKEN ||
    configured.CLAUDE_CONFIG_DIR ||
    settings.apiKeyHelper ||
    settings.policyHelper ||
    settings.policyHelpers ||
    settings.forceLoginGatewayUrl ||
    (settings.forceLoginMethod && settings.forceLoginMethod !== 'claudeai')
  )
    throw new Error(ROUTING);
}

// Managed env keys that could copy prompts elsewhere: telemetry and tracing exports (OTEL_*,
// CLAUDE_CODE_ENABLE_TELEMETRY, the enhanced-telemetry flags, BETA_TRACING_ENDPOINT), proxies
// (HTTP(S)_PROXY, ALL_PROXY, CLAUDE_CODE_HTTPS_PROXY, …) and the TLS trust that lets a proxy read
// the traffic (NODE_EXTRA_CA_CERTS, SSL_CERT_FILE/DIR, CLAUDE_CODE_CERT_STORE). Matched by family
// so a renamed or newly added variable is refused too.
const copying = /OTEL|TELEMETRY|TRACING|PROXY|CA_CERTS|SSL_CERT|CERT_STORE/i;
const harmless = /^(NO_PROXY|DISABLE_TELEMETRY)$/i;
// A value that turns its setting off: "0", "false" and the like, or "none" for an exporter.
const off = (key, value) =>
  !active(value) || (/_EXPORTER$/i.test(key) && String(value).toLowerCase() === 'none');

// Admin settings can also copy prompts elsewhere without rerouting the request itself: hooks run
// commands that see each prompt, telemetry and tracing can export prompts to the organization's
// collector, and a proxy (with its certificate) can read the traffic. Safe mode does not turn
// these off for managed settings, so they are refused there. The user's own settings are the
// user's choice.
function checkManaged(settings) {
  const hooks = settings.hooks;
  if (hooks && (typeof hooks !== 'object' || Object.keys(hooks).length)) throw new Error(ROUTING);
  if (settings.otelHeadersHelper || settings.proxyAuthHelper) throw new Error(ROUTING);
  for (const [key, value] of Object.entries(settings.env ?? {}))
    if (copying.test(key) && !harmless.test(key) && !off(key, value)) throw new Error(ROUTING);
}

const UNREADABLE =
  'Could not verify Claude Code settings. Check the settings files before using Claude in Stillnote.';
const MAX_SETTINGS_BYTES = 1024 * 1024;
// Opens without blocking and reads only a regular file of sane size: a named pipe or device at a
// settings path would otherwise hang the main process at startup.
function readSettings(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    // The caller replaces this with its own message.
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES)
      throw Object.assign(new Error(), { code: 'EINVAL' });
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
// Checks one settings file. Returns false when it does not exist, true when it exists and is clean.
function checkFile(path, unreadable, extra) {
  let settings;
  try {
    settings = JSON.parse(readSettings(path));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error(unreadable);
  }
  checkSettings(settings);
  extra?.(settings);
  return true;
}

// Throws when requests could be rerouted. Otherwise reports which organization settings were
// found and passed: `machine` for this Mac's managed policy, `managed` for any managed settings
// (machine policy or the account's remote settings). Both are usable, though an admin can change
// them later.
export function checkConfiguration({
  env,
  home,
  workDir,
  configDirectory,
  policyDir = POLICY_DIR,
}) {
  checkRouting(env);
  const config = resolve(configDirectory || env.CLAUDE_CONFIG_DIR || join(home, '.claude'));
  // Managed JSON settings are checked like the user's own. Managed preference plists cannot be
  // read the same way, so they are still refused.
  const machinePolicies = [join(policyDir, 'managed-settings.json')];
  const plists = [
    '/Library/Managed Preferences/com.anthropic.claudecode.plist',
    join('/Library/Managed Preferences', userInfo().username, 'com.anthropic.claudecode.plist'),
  ];
  try {
    machinePolicies.push(
      ...readdirSync(join(policyDir, 'managed-settings.d'))
        .filter((name) => !name.startsWith('.') && name.endsWith('.json'))
        .map((name) => join(policyDir, 'managed-settings.d', name)),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(ROUTING);
  }
  for (const path of plists) {
    try {
      lstatSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(ROUTING);
    }
    throw new Error(ROUTING);
  }
  // An unreadable managed file fails closed as routing; an unreadable user file asks for a fix.
  let machine = false;
  for (const path of machinePolicies) if (checkFile(path, ROUTING, checkManaged)) machine = true;
  const remote = checkFile(join(config, 'remote-settings.json'), ROUTING, checkManaged);
  const files = new Set([join(config, 'settings.json')]);
  // The private CLI working directory can still inherit an ancestor's project settings.
  for (let dir = resolve(workDir || home); ; dir = dirname(dir)) {
    files.add(join(dir, '.claude/settings.json'));
    files.add(join(dir, '.claude/settings.local.json'));
    if (dirname(dir) === dir) break;
  }
  for (const path of files) checkFile(path, UNREADABLE);
  return { managed: machine || remote, machine };
}
