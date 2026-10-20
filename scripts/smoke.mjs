import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
const dataDir = mkdtempSync(resolve('.test-data-'));
const output = resolve('output/playwright');
mkdirSync(output, { recursive: true });
const issues = [];
let desktop;
async function launch() {
  console.log('Launching isolated desktop test…');
  desktop = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: { ...process.env, STILLNOTE_DATA_DIR: dataDir },
    timeout: 30000,
  });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => issues.push(e.message));
  await page.getByRole('button', { name: 'New note' }).waitFor();
  return page;
}
try {
  let page = await launch();
  await page.screenshot({ path: join(output, 'welcome.png') });
  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByRole('textbox', { name: 'Meeting title' }).fill('Design review · test fixture');
  await page.getByRole('textbox', { name: 'Participants' }).fill('Alex, Sam');
  await page
    .getByRole('textbox', { name: 'My notes', exact: true })
    .fill(
      'Discuss onboarding. Alex will send the revised flow on Friday.\nKeep microphone capture local.',
    );
  await page.getByRole('tab', { name: 'Transcript' }).click();
  await page.getByRole('button', { name: 'Paste a transcript', exact: true }).click();
  await page
    .getByLabel('Transcript', { exact: true })
    .fill(
      'Alex: I will send the revised onboarding flow on Friday. Sam: Let us keep the microphone capture on device.',
    );
  await page.getByRole('button', { name: 'Save transcript', exact: true }).click();
  await page.getByRole('button', { name: 'Back to Home' }).click();
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('Folder name').fill('Product');
  await page.getByRole('button', { name: 'Create folder', exact: true }).click();
  await page.locator('.note-row').first().click();
  await page.getByLabel('Move note to folder').selectOption({ label: 'Product' });
  await page.getByRole('button', { name: 'Star note', exact: true }).click();
  await page.getByRole('button', { name: 'Chat with this meeting' }).click();
  await page.getByRole('textbox', { name: 'Ask a question' }).fill('What did we decide?');
  await page.getByRole('button', { name: 'Send question' }).click();
  await page.getByRole('alert').filter({ hasText: 'Connect your ChatGPT account' }).waitFor();
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await page.getByRole('tab', { name: 'My notes', exact: true }).click();
  await page.screenshot({ path: join(output, 'notebook.png') });
  await page.getByRole('button', { name: 'Close chat' }).click();
  await page.getByRole('button', { name: 'Back to Home' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.screenshot({ path: join(output, 'settings.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').isVisible(), false);
  await page.locator('.note-row').first().click();
  await page.getByRole('button', { name: 'Export Markdown', exact: true }).click({ trial: true });
  // Native file pickers are handled in the main process; export still traverses the real IPC handler.
  const exportPath = join(dataDir, 'export.md');
  await desktop.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, exportPath);
  await page.getByRole('button', { name: 'Export Markdown', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Exported to' }).waitFor();
  assert.match(readFileSync(exportPath, 'utf8'), /revised onboarding flow/);
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  await page.getByRole('button', { name: 'Back to Home' }).click();
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await page
    .getByRole('button')
    .filter({ has: page.locator('.row-title strong', { hasText: 'Design review' }) })
    .click();
  await page.getByRole('button', { name: 'Restore note', exact: true }).click();
  await page.getByRole('button', { name: 'Back to Home' }).click();
  await page.getByRole('button', { name: 'My notes', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search notes' }).fill('onboarding');
  await page.locator('.note-row').first().waitFor();
  assert.equal(await page.locator('.note-row').count(), 1);
  await page.locator('.note-row').first().click();
  await page.getByRole('tab', { name: 'My notes', exact: true }).click();
  assert.match(
    await page.getByRole('textbox', { name: 'My notes', exact: true }).inputValue(),
    /revised flow/,
  );
  await page
    .getByRole('textbox', { name: 'My notes', exact: true })
    .fill('Immediate-close save regression check.');
  // Close immediately to verify unsaved drafts are flushed before the window goes away.
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await new Promise((resolve) => {
    if (desktop.process().exitCode !== null) resolve();
    else desktop.process().once('exit', resolve);
  });
  page = await launch();
  await page.locator('.note-row').first().click();
  assert.equal(
    await page.getByRole('textbox', { name: 'My notes', exact: true }).inputValue(),
    'Immediate-close save regression check.',
  );
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1024, 768),
  );
  await page.getByRole('button', { name: 'Chat with this meeting' }).click();
  await page.screenshot({ path: join(output, 'compact.png') });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  assert.equal(issues.length, 0, issues.join('\n'));
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        dataDir,
        screenshots: output,
        checks: [
          'create/edit/autosave',
          'paste transcript',
          'folder assignment',
          'star',
          'chat sign-in recovery',
          'settings and Escape',
          'Markdown export',
          'Trash and restore',
          'full-text search',
          'immediate-close persistence',
          '1024px layout',
          'no renderer errors',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (desktop) await desktop.close().catch(() => {});
}
