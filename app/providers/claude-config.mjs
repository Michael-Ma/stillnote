// Read configuration only, never Claude's credential files. Stillnote supports a directly
// connected Claude plan. Organization-managed settings are allowed only when they reroute nothing,
// and unreadable or unknown routing fails closed: disabling managed policy or overriding its
// endpoint would not be a safe way to use that plan.
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { userInfo } from 'node:os';

export const ROUTING =
  'Stillnote cannot use this Claude configuration. It sends requests to a custom endpoint or another provider, uses an API key, or has managed settings that could copy your notes elsewhere or cannot be checked. Your Claude configuration has not been changed.';
const active = (value) =>
  value != null && !['', '0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
export function checkRouting(env) {
  if (env.ANTHROPIC_CUSTOM_HEADERS) throw new Error(ROUTING);
  if (env.ANTHROPIC_BASE_URL && !/^https:\/\/api\.anthropic\.com\/?$/.test(env.ANTHROPIC_BASE_URL))
    throw new Error(ROUTING);
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
    settings.forceLoginGatewayUrl ||
    (settings.forceLoginMethod && settings.forceLoginMethod !== 'claudeai')
  )
    throw new Error(ROUTING);
}

// Admin settings can also copy prompts elsewhere without rerouting the request itself: hooks run
// commands that see each prompt, telemetry can log prompts to the organization's collector, and a
// proxy (with its certificate) can read the traffic. Safe mode does not turn these off for managed
// settings, so they are refused there. The user's own settings are the user's choice.
function checkManaged(settings) {
  const configured = settings.env ?? {};
  const hooks = settings.hooks;
  if (hooks && (typeof hooks !== 'object' || Object.keys(hooks).length)) throw new Error(ROUTING);
  if (settings.otelHeadersHelper) throw new Error(ROUTING);
  for (const [key, value] of Object.entries(configured)) {
    if (key === 'CLAUDE_CODE_ENABLE_TELEMETRY' && active(value)) throw new Error(ROUTING);
    if (/^(OTEL_|(HTTPS?|ALL)_PROXY$|NODE_EXTRA_CA_CERTS$)/i.test(key) && value)
      throw new Error(ROUTING);
  }
}

const UNREADABLE =
  'Could not verify Claude Code settings. Check the settings files before using Claude in Stillnote.';
// Checks one settings file. Returns false when it does not exist, true when it exists and is clean.
function checkFile(path, unreadable, extra) {
  let settings;
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error(unreadable);
  }
  checkSettings(settings);
  extra?.(settings);
  return true;
}

// Throws when requests could be rerouted. Returns { managed: true } when an organization's admin
// settings are present but neither reroute nor copy prompts: usable, though the admin can change
// them later.
export function checkConfiguration({ env, home, workDir, configDirectory }) {
  checkRouting(env);
  const config = resolve(configDirectory || env.CLAUDE_CONFIG_DIR || join(home, '.claude'));
  const policyDir = '/Library/Application Support/ClaudeCode';
  // Managed JSON settings are checked like the user's own. Managed preference plists cannot be
  // read the same way, so they are still refused.
  const policies = [join(policyDir, 'managed-settings.json'), join(config, 'remote-settings.json')];
  const plists = [
    '/Library/Managed Preferences/com.anthropic.claudecode.plist',
    join('/Library/Managed Preferences', userInfo().username, 'com.anthropic.claudecode.plist'),
  ];
  try {
    policies.push(
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
  let managed = false;
  for (const path of policies) if (checkFile(path, ROUTING, checkManaged)) managed = true;
  const files = new Set([join(config, 'settings.json')]);
  // The private CLI working directory can still inherit an ancestor's project settings.
  for (let dir = resolve(workDir || home); ; dir = dirname(dir)) {
    files.add(join(dir, '.claude/settings.json'));
    files.add(join(dir, '.claude/settings.local.json'));
    if (dirname(dir) === dir) break;
  }
  for (const path of files) checkFile(path, UNREADABLE);
  return { managed };
}
