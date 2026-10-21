// ChatGPT and Claude share one provider contract: load, status, models, cancel and
// respond({ model, input, instructions, onDelta, signal }).
export const providerIds = ['chatgpt', 'claude'];
export const modelSetting = { chatgpt: 'model', claude: 'claudeModel' };

export const chatgptStatus = (status) => ({
  ...status,
  id: 'chatgpt',
  label: 'ChatGPT',
  ready: !!status.sharing,
});

// An explicit choice wins. Otherwise use whichever plan is ready, preferring ChatGPT.
export function pickProvider(chosen, statuses) {
  if (providerIds.includes(chosen)) return chosen;
  return providerIds.find((id) => statuses[id]?.ready) ?? null;
}

export function aiState(chosen, chatgpt, claude) {
  const statuses = { chatgpt: chatgptStatus(chatgpt), claude };
  const valid = providerIds.includes(chosen) ? chosen : null;
  return { provider: pickProvider(valid, statuses), chosen: valid, ...statuses };
}

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// A Terminal script for steps that belong to Anthropic's own installer and sign-in flow.
export function terminalScript(step, binary) {
  const claude = binary ? quote(binary) : '"$HOME/.local/bin/claude"';
  const commands = {
    'sign-in': [
      'echo "Stillnote: signing in to Claude Code with your Claude plan…"',
      `${claude} auth login --claudeai`,
    ],
    install: [
      'echo "Stillnote: installing Claude Code from claude.ai…"',
      `curl -fsSL https://claude.ai/install.sh | bash && ${claude} auth login --claudeai`,
    ],
  }[step];
  if (!commands) throw new Error('Unknown Claude setup step.');
  return [
    '#!/bin/zsh -l',
    ...commands,
    'echo',
    'echo "Done. You can close this window and return to Stillnote."',
    '',
  ].join('\n');
}
