// Presentation-only fixtures. Never runs against the user's notebook or real accounts.
import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from '../app/store.mjs';
const dataDir = mkdtempSync(resolve('.test-data-shots-'));
const store = new Store(dataDir);
const product = store.addFolder('Product');
store.addFolder('1:1s');
store.addFolder('Customer conversations');
const now = new Date();
const samples = [
  {
    title: 'Product review — a calmer onboarding',
    participants: 'Alex, Sam & Jordan',
    notes:
      'Keep the first screen simple.\n\nOne choice at a time.\nAlex to share the revised flow on Friday.',
    summary:
      '## A simpler first session\n\n- Guide new users through one decision at a time. [1]\n- **Keep the first screen simple.** Move optional setup into the workspace.\n- Preserve the user’s progress if they leave and come back.\n\n## What we decided\n\n- Start with a blank note, with a clear way to record or import a transcript. [1]\n- Keep meeting details close to the document title.\n- Use a quiet, familiar writing surface.\n\n## Next steps\n\n- **Alex to share the revised flow on Friday.**\n- Sam will review the permission prompts.\n- Bring the updated flow to the next product review.',
    folderId: product.id,
    duration: 1800,
    days: 0,
  },
  {
    title: 'Weekly team catch-up',
    participants: 'Sam & Jordan',
    notes: 'Discuss the next milestone and open questions.',
    days: 0,
    duration: 1500,
  },
  {
    title: 'Customer conversation — Cedar',
    participants: 'Taylor & Alex',
    notes: 'Learn how the team prepares for recurring customer calls.',
    days: 0,
    duration: 2400,
  },
  {
    title: '1:1 — Alex',
    participants: 'Alex',
    notes: 'Feedback on the first prototype and next week’s priorities.',
    days: 1,
    duration: 1800,
  },
  {
    title: 'Research synthesis',
    participants: 'Sam, Taylor & Jordan',
    notes: 'Compare the themes from this week’s conversations.',
    days: 1,
    duration: 2700,
  },
];
let primary;
for (let i = 0; i < samples.length; i++) {
  const x = samples[i];
  let m = store.create({ title: x.title, participants: x.participants, notes: x.notes });
  const created = new Date(now);
  created.setDate(created.getDate() - x.days);
  created.setHours(14 - i, 0, 0, 0);
  m = store.write({
    ...m,
    createdAt: created.toISOString(),
    updatedAt: created.toISOString(),
    summary: x.summary ?? '',
    duration: x.duration,
    folderId: x.folderId ?? null,
  });
  if (i === 0) {
    primary = m;
    store.append(m.id, {
      speaker: 'Alex',
      timestamp: 24,
      text: 'Let’s keep the first screen simple. I’ll share the revised flow on Friday.',
    });
    store.append(m.id, {
      speaker: 'Sam',
      timestamp: 64,
      text: 'I’ll review the permission prompts. We should preserve progress when someone comes back.',
    });
  }
}
store.close();
mkdirSync('docs/images', { recursive: true });
const desktop = await electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  env: { ...process.env, STILLNOTE_DATA_DIR: dataDir, STILLNOTE_DISABLE_CLAUDE: '1' },
  timeout: 30000,
});
try {
  const page = await desktop.firstWindow();
  await page.getByRole('button', { name: 'New note', exact: true }).waitFor();
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1280, 860),
  );
  const state = await page.evaluate(() => window.stillnote.call('state'));
  state.calendar = ['Design critique', 'Customer discovery', 'Weekly planning'].map((title, i) => ({
    id: `fixture-event-${i}`,
    title,
    start: new Date(Date.now() + (i + 1) * 3600000).toISOString(),
    end: new Date(Date.now() + (i + 1) * 3600000 + 1800000).toISOString(),
    participants: 'Fictional demonstration attendees',
    notes: '',
  }));
  // Replace only the safe read-state handler in this isolated screenshot process.
  await desktop.evaluate(({ ipcMain }, fixture) => {
    ipcMain.removeHandler('stillnote:state');
    ipcMain.handle('stillnote:state', () => fixture);
  }, state);
  await page.reload();
  await page.getByRole('button', { name: 'New note', exact: true }).waitFor();
  await page.getByText('Design critique', { exact: true }).waitFor();
  await page.screenshot({ path: resolve('docs/images/home.png'), scale: 'css' });
  await page.locator('.note-row').filter({ hasText: primary.title }).click();
  await page.getByRole('heading', { name: 'A simpler first session', exact: true }).waitFor();
  await page.screenshot({ path: resolve('docs/images/editor.png'), scale: 'css' });
  console.log('Saved Home and editor screenshots using fictional local fixtures.');
} finally {
  await desktop.close();
}
