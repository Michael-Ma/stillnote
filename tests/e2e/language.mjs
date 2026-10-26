import assert from 'node:assert/strict';

export const languageScenario = {
  connected: false,
  calendar: [{ id: 'fixture-sync', title: 'E2E weekly sync', startIn: 30_000 }],
};

// English labels that must not survive a switch to Chinese.
const english = ['New note', 'Settings', 'Start recording', 'Coming up', 'Ask anything'];

export async function language(h) {
  const page = await h.launch();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('App language', { exact: true }).selectOption('zh-Hans');

  // The whole window switches at once, without a restart.
  await page.getByRole('heading', { name: '通用', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-Hans');
  assert.equal((await h.state()).settings.uiLanguage, 'zh-Hans');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByText('即将开始', { exact: true }).first().waitFor();
  await h.screenshot('home-zh');
  const body = await page.evaluate(() => document.body.innerText);
  for (const label of english) assert.ok(!body.includes(label), `English left on Home: ${label}`);

  // Main-process text follows too: the meeting reminder is written in Chinese.
  await page.waitForFunction(() => true);
  let reminder = '';
  for (let i = 0; i < 40 && !reminder; i++) {
    reminder = await h.desktop.evaluate(() => globalThis.__stillnoteReminders[0]?.body ?? '');
    if (!reminder) await page.waitForTimeout(100);
  }
  assert.match(reminder, /分钟后开始|现在开始/);
  assert.match(reminder, /点按以记笔记/);

  // A new note starts with a Chinese placeholder title and a Chinese dock.
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="会议标题"]')?.value === '未命名会议',
  );
  await page.getByRole('button', { name: '开始录音', exact: true }).waitFor();
  await h.screenshot('note-zh');

  // And back to English.
  await page.getByRole('button', { name: '返回首页', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '通用', exact: true }).click();
  await page.getByLabel('应用语言', { exact: true }).selectOption('en');
  await page.getByRole('heading', { name: 'General', exact: true }).waitFor();
  h.assertNoRendererErrors();
}
