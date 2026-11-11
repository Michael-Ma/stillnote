import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANAGED_ACCOUNT } from '../../app/providers/claude-code.mjs';

// A fresh notebook where the only AI is a signed-in Claude Team account.
export const managedClaudeScenario = {
  connected: false,
  claude: {
    installed: true,
    path: '/fixture/bin/claude',
    loggedIn: true,
    authMethod: 'claude.ai',
    subscriptionType: 'team',
    email: 'fixture@example.invalid',
    ready: true,
    billing: 'subscription',
    warning: MANAGED_ACCOUNT,
  },
  responses: [{ mode: 'success', text: '- Alex will ship the revised onboarding flow on Friday.' }],
};

export async function managedClaude(h) {
  const page = await h.launch();
  const sent = () => {
    const path = join(h.dataDir, 'adapter-events.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => ['claude-request', 'ai-request', 'todo-request'].includes(event.type));
  };
  assert.equal((await h.state()).ai.provider, null, 'a managed Claude is not picked on its own');
  const meeting = await h.create(
    'E2E managed Claude',
    'Alex will ship the revised onboarding flow on Friday.',
  );
  await h.open(meeting.title);
  // Enhance opens the connect prompt, which shows the warning beside "Use Claude".
  await page.getByRole('button', { name: 'Enhance notes', exact: true }).first().click();
  const connect = page.getByRole('group', { name: 'Connect AI', exact: true });
  await connect.getByText(MANAGED_ACCOUNT, { exact: true }).waitFor();
  assert.deepEqual(sent(), [], 'nothing is sent before the warning is seen');
  assert.ok(!(await h.state()).meetings.find((m) => m.id === meeting.id).summary);
  await h.screenshot('managed-claude-warning');

  await connect.getByRole('button', { name: 'Use Claude', exact: true }).click();
  await h.waitForState((s) => s.settings.provider === 'claude' && s.ai.provider === 'claude');
  await page.getByRole('button', { name: 'Enhance notes', exact: true }).first().click();
  await h.waitForState(
    (s, id) => s.meetings.find((m) => m.id === id).summary.includes('Alex will ship'),
    meeting.id,
  );
  assert.ok(sent().some((event) => event.type === 'claude-request'));

  // Settings shows the same warning in full, beside "In use".
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.locator('dialog.settings-dialog');
  await settings.getByText('Managed by an organization', { exact: true }).waitFor();
  await settings.getByText(MANAGED_ACCOUNT, { exact: true }).waitFor();
  await settings.getByText('In use', { exact: true }).waitFor();
  await h.screenshot('managed-claude-settings');
  h.assertNoRendererErrors();
}
