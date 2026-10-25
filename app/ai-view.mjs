// Pure view model for the AI provider UI. Tolerates the older state shape (account only).
import { translator } from './i18n/index.mjs';

const english = translator('en');
export const claudeModels = [
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'opus', name: 'Opus' },
  { id: 'haiku', name: 'Haiku' },
];
export const modelKey = (provider) => (provider === 'claude' ? 'claudeModel' : 'model');
export const providerName = (id) => (id === 'claude' ? 'Claude' : 'ChatGPT');

export function aiView(data) {
  const chatgpt = data?.ai?.chatgpt ?? { ...data?.account, ready: !!data?.account?.sharing };
  const claude = data?.ai?.claude ?? { installed: false };
  const provider = data?.ai?.provider ?? (chatgpt.ready ? 'chatgpt' : null);
  const active = provider === 'claude' ? claude : provider === 'chatgpt' ? chatgpt : null;
  return {
    provider,
    chosen: data?.ai?.chosen ?? null,
    chatgpt,
    claude,
    ready: !!active?.ready,
    label: provider ? providerName(provider) : 'AI',
    // What one click can turn on, in order of least effort.
    suggestion: claude.ready ? 'use-claude' : chatgpt.ready ? 'use-chatgpt' : null,
  };
}

const plans = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
export function claudeSummary(claude, t = english) {
  if (!claude) return '';
  if (claude.checking && claude.installed === undefined)
    return t('Looking for Claude Code on this Mac…');
  if (claude.signingIn) return t('Finish signing in to Claude in your browser…');
  if (!claude.installed) return t('Claude Code is not installed on this Mac.');
  if (!claude.loggedIn) return t('Claude Code is installed. Sign in once to use your plan.');
  if (!claude.ready)
    return t('Claude Code is signed in with an API key, so requests would be billed to that key.');
  const plan = plans[claude.subscriptionType] ?? claude.subscriptionType;
  return [t('Signed in'), plan && t('{plan} plan', { plan }), claude.email]
    .filter(Boolean)
    .join(' · ');
}

export function usageSummary(usage, now = Date.now(), t = english) {
  const window = usage?.sevenDay ?? usage?.fiveHour;
  if (!window || !Number.isFinite(window.utilization)) return '';
  const percent = Math.round(window.utilization * 100);
  const used = usage.sevenDay
    ? t('{percent}% of weekly limit used', { percent })
    : t('{percent}% of 5-hour limit used', { percent });
  const reset = Number.isFinite(window.resetsAt)
    ? new Intl.DateTimeFormat(t.locale, {
        weekday: window.resetsAt * 1000 - now > 86400000 ? 'short' : undefined,
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(window.resetsAt * 1000))
    : '';
  return reset ? `${used} · ${t('resets {time}', { time: reset })}` : used;
}
