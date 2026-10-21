import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

export async function notebook(h) {
  let page = await h.launch();
  const title = 'E2E design review';
  const original = 'Alex will ship the revised onboarding flow on Friday. 我们保存原始记录。';
  const meeting = await h.create(title, original);
  await page.getByRole('textbox', { name: 'Participants', exact: true }).fill('Alex, Sam');
  await h.sheet('Transcript');
  await page.getByRole('button', { name: 'Paste a transcript', exact: true }).click();
  await page
    .getByLabel('Transcript', { exact: true })
    .fill('Alex: I will ship the revised onboarding flow on Friday.');
  await page.getByRole('button', { name: 'Save transcript', exact: true }).click();
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByLabel('Folder name', { exact: true }).fill('E2E product');
  await page.getByRole('button', { name: 'Create folder', exact: true }).click();
  await h.open(title);
  await page
    .getByLabel('Move note to folder', { exact: true })
    .selectOption({ label: 'E2E product' });
  await page.getByRole('button', { name: 'Star note', exact: true }).click();
  const marked = (await h.state()).meetings.find((m) => m.id === meeting.id);
  assert.equal(marked.starred, true);
  assert.ok(marked.folderId);
  assert.equal(marked.participants, 'Alex, Sam');
  await h.screenshot('notebook');
  await page.getByRole('button', { name: /^Chat with this meeting/ }).click();
  await page
    .getByRole('textbox', { name: 'Ask a question', exact: true })
    .fill('What did we decide?');
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Connect your ChatGPT account' }).waitFor();
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await page.getByRole('button', { name: 'Close chat', exact: true }).click();
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await h.waitForState((state) => state.account.connected && state.account.sharing);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await h.open(title);

  const exportPath = join(h.output, 'meeting.md');
  await h.saveDialog(exportPath);
  await page.getByRole('button', { name: 'Export Markdown', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Exported to' }).waitFor();
  assert.match(readFileSync(exportPath, 'utf8'), /Alex: I will ship/);
  assert.match(readFileSync(exportPath, 'utf8'), /我们保存原始记录/);

  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  const backupPath = join(h.output, 'notebook.json');
  await h.saveDialog(backupPath);
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await page.getByRole('button', { name: 'Back up notebook', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Backup saved' }).waitFor();
  const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
  assert.equal(backup.audioIncluded, false);
  assert.equal(backup.meetings.length, 1);
  assert.ok(!/access_token|refresh_token|id_token/.test(JSON.stringify(backup)));
  await h.openDialog(backupPath);
  await page.getByRole('button', { name: 'Import transcript or backup', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Imported 0 new meetings' }).waitFor();
  assert.equal((await h.state()).meetings.length, 1, 'Reimport must not duplicate meetings');
  const invalidPath = join(h.output, 'invalid-backup.json');
  writeFileSync(invalidPath, JSON.stringify({ version: 1, meetings: [{ id: 'bad', title: 55 }] }));
  await h.openDialog(invalidPath);
  await page.getByRole('button', { name: 'Import transcript or backup', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(
    (await h.state()).meetings.length,
    1,
    'Invalid import must leave the notebook intact',
  );
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();

  const importPath = join(h.output, 'Imported E2E transcript.txt');
  writeFileSync(importPath, 'Sam: The import round trip preserves this unique sentence.');
  await h.openDialog(importPath);
  await page.getByRole('button', { name: 'Import transcript or backup', exact: true }).click();
  await page
    .getByText('Sam: The import round trip preserves this unique sentence.', { exact: true })
    .waitFor();
  assert.equal((await h.state()).meetings.length, 2);
  await h.open(title);
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  assert.ok((await h.state()).meetings.find((m) => m.id === meeting.id).deletedAt);
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await page.locator('.note-row').filter({ hasText: title }).click();
  await page.getByRole('button', { name: 'Restore note', exact: true }).click();
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await page.getByRole('button', { name: 'My notes', exact: true }).click();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search notes', exact: true }).fill('原始记录');
  await page.locator('.note-row').filter({ hasText: title }).waitFor();
  assert.equal(await page.locator('.note-row').count(), 1);
  await page.locator('.note-row').first().click();
  await page.getByRole('tab', { name: 'My notes', exact: true }).click();
  const immediatelySaved = 'Immediate-close regression: final keystrokes must survive.';
  await page.getByRole('textbox', { name: 'My notes', exact: true }).fill(immediatelySaved);
  page = await h.restart();
  await h.open(title);
  assert.equal(
    await page.getByRole('textbox', { name: 'My notes', exact: true }).inputValue(),
    immediatelySaved,
  );
  const persisted = (await h.state()).meetings.find((m) => m.id === meeting.id);
  assert.equal(persisted.transcript.length, 1);
  assert.equal(persisted.starred, true);
  assert.equal(persisted.deletedAt, null);
  await h.desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1024, 768),
  );
  await page.getByRole('button', { name: /^Chat with this meeting/ }).click();
  await h.screenshot('compact');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  h.assertNoRendererErrors();
}
