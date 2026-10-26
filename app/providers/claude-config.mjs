// Read configuration only, never Claude's credential files. Stillnote supports a directly
// connected personal Claude plan. Unknown/dynamic organizational routing must fail closed:
// disabling managed policy or overriding its endpoint would not be a safe way to use that plan.
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { userInfo } from 'node:os';

export const ROUTING =
  'Stillnote requires a direct Claude Pro or Max connection. Custom endpoints, other providers, and managed Claude configurations are not supported; your Claude configuration has not been changed.';
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

export function checkConfiguration({ env, home, workDir, configDirectory }) {
  checkRouting(env);
  const config = resolve(configDirectory || env.CLAUDE_CONFIG_DIR || join(home, '.claude'));
  const policyDir = '/Library/Application Support/ClaudeCode';
  // The CLI can fetch new policy at inference startup. We cannot verify its final endpoint
  // using `auth status`, so managed installations are rejected, never silently bypassed.
  const managed = [
    join(policyDir, 'managed-settings.json'),
    join(config, 'remote-settings.json'),
    '/Library/Managed Preferences/com.anthropic.claudecode.plist',
    join('/Library/Managed Preferences', userInfo().username, 'com.anthropic.claudecode.plist'),
  ];
  try {
    managed.push(
      ...readdirSync(join(policyDir, 'managed-settings.d'))
        .filter((name) => !name.startsWith('.') && name.endsWith('.json'))
        .map((name) => join(policyDir, 'managed-settings.d', name)),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(ROUTING);
  }
  for (const path of managed) {
    try {
      lstatSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(ROUTING);
    }
    throw new Error(ROUTING);
  }
  const files = new Set([join(config, 'settings.json')]);
  // The private CLI working directory can still inherit an ancestor's project settings.
  for (let dir = resolve(workDir || home); ; dir = dirname(dir)) {
    files.add(join(dir, '.claude/settings.json'));
    files.add(join(dir, '.claude/settings.local.json'));
    if (dirname(dir) === dir) break;
  }
  for (const path of files) {
    let settings;
    try {
      settings = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(
        'Could not verify Claude Code settings. Check the settings files before using Claude in Stillnote.',
      );
    }
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
}
