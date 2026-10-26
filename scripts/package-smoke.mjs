import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
// Spotlight skips `.noindex` folders, so the build never shows up beside the installed app.
const bundle = resolve(
  `release.noindex/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Stillnote.app`,
);
const helper = join(bundle, 'Contents/Resources/StillnoteCapture');
const probe = JSON.parse(execFileSync(helper, ['--self-test'], { encoding: 'utf8' }).trim());
assert.equal(probe.type, 'ready');
const dataDir = mkdtempSync(resolve('.test-data-package-'));
const desktop = await electron.launch({
  executablePath: join(bundle, 'Contents/MacOS/Stillnote'),
  env: {
    ...process.env,
    STILLNOTE_DATA_DIR: dataDir,
    STILLNOTE_DISABLE_CLAUDE: '1',
    STILLNOTE_MOCK_KEYCHAIN: '1',
    STILLNOTE_UI_LANGUAGE: 'en',
  },
  timeout: 30000,
});
try {
  const page = await desktop.firstWindow();
  await page.getByRole('button', { name: 'New note', exact: true }).waitFor();
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  await page.getByRole('textbox', { name: 'Meeting title' }).fill('Packaged application check');
  await page
    .getByRole('textbox', { name: 'My notes', exact: true })
    .fill('The packaged renderer and persistence bridge are available.');
  await page.getByRole('button', { name: 'Back to Home' }).click();
  // Back navigation waits for the in-flight draft write; observe the resulting view.
  await page.locator('.note-row').filter({ hasText: 'Packaged application check' }).waitFor();
  assert.equal(await page.locator('.note-row').count(), 1);
  const data = await page.evaluate(() => window.stillnote.call('state'));
  assert.equal(
    data.meetings[0].notes,
    'The packaged renderer and persistence bridge are available.',
  );
  console.log(
    JSON.stringify({
      packagedApp: 'passed',
      nativeHelper: probe.type,
      nativeLocales: probe.speechLocales,
      liveCaptureTested: false,
      liveChatGPTTested: false,
    }),
  );
} finally {
  await desktop.close();
  // The isolated notebook is only for this run.
  rmSync(dataDir, { recursive: true, force: true });
}
