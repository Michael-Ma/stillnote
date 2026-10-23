// README media from fictional fixtures: `npm run screenshots` captures docs/images/*.png and
// `npm run screenshots -- --demo` also records docs/images/demo.gif. The unpackaged app runs with
// the E2E test adapter, so no real account, microphone, calendar, notebook or AI is touched.
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../app/store.mjs';

const demo = process.argv.includes('--demo');
// Shoot in whichever whole-hour timezone it is early afternoon now, so the calendar and the
// note times read like a working day whenever this runs. Node and the app both follow TZ.
const offset = 14 - new Date().getUTCHours();
process.env.TZ = offset ? `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}` : 'UTC';
const today = (hours, minutes = 0, days = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hours, minutes, 0, 0);
  return d.toISOString();
};
const out = resolve('docs/images');
mkdirSync(out, { recursive: true });
const dataDir = mkdtempSync(resolve('.test-data-shots-'));
// Real pacing for the demo; a tenth of it for screenshots only.
const pace = (ms) => (demo ? ms : Math.round(ms / 10));

const transcript = [
  ['You', "Thanks for joining. Let's start with the onboarding review."],
  [
    'Meeting audio',
    'I tested the new flow with five people. Three of them missed the record button.',
  ],
  ['You', "Then let's move the record button into the dock, where people already look."],
  ['Meeting audio', "Agreed. I'll send the revised flow on Friday."],
  ['You', 'Sam, can you check the permission prompts before then?'],
  ['Meeting audio', "Yes, I'll review them on Thursday."],
].map(([speaker, text], i) => ({
  speaker,
  source: speaker === 'You' ? 'microphone' : 'system',
  text,
  // Lines arrive in real time in both modes, so the dock timer matches their timestamps.
  at: Math.round(1.4 + i * 2.3),
  afterMs: 1400 + i * 2300,
}));
// Written the way the enhance prompt asks: my rough-note lines stay as bullets, with what the
// transcript adds nested under them, and no citations.
const enhanced = [
  '## Onboarding',
  '- Onboarding: one decision at a time',
  '  - New users should finish setup without getting stuck',
  '- Tested the new flow with five people; three missed the record button',
  '',
  '## Record button',
  '- Record button moves to the dock',
  '  - Next to chat, where people already look',
  '- Permission prompts need a check before the revised flow ships',
  '',
  '## Next steps',
  '- **Alex**: send the revised flow, by Friday',
  '- **Sam**: review the permission prompts, by Thursday',
].join('\n');
const answer =
  'You decided to **move the record button into the dock** after three of five testers missed it [1]. Alex sends the revised flow on Friday, and Sam reviews the permission prompts on Thursday [1].';

const scenario = {
  connected: true,
  claude: {
    installed: true,
    loggedIn: true,
    ready: true,
    authMethod: 'claude.ai',
    subscriptionType: 'max',
    email: 'you@example.com',
    billing: 'subscription',
    usage: {
      status: 'allowed',
      sevenDay: { utilization: 0.38, resetsAt: Date.now() / 1000 + 3 * 86400 },
    },
  },
  devices: [
    { uid: 'builtin', name: 'MacBook Pro Microphone', isDefault: true, transport: 'built-in' },
    { uid: 'usb', name: 'USB Podcast Mic', isDefault: false, transport: 'usb' },
  ],
  calendar: [
    {
      id: 'cal-critique',
      title: 'Design critique',
      participants: 'Priya, Sam',
      start: today(15),
    },
    {
      id: 'cal-cedar',
      title: 'Customer discovery — Cedar',
      participants: 'Taylor, Alex',
      start: today(16, 30),
    },
    {
      id: 'cal-planning',
      title: 'Weekly planning',
      participants: 'Product team',
      start: today(10, 0, 1),
    },
  ],
  sessions: [{ mode: 'script', duration: 16, script: transcript }],
  responses: [
    { mode: 'success', paceMs: pace(70), text: enhanced },
    { mode: 'success', paceMs: pace(70), text: answer },
  ],
};
const scenarioPath = join(dataDir, 'scenario.json');
writeFileSync(scenarioPath, JSON.stringify(scenario));

const store = new Store(dataDir);
const folders = Object.fromEntries(
  ['Product', '1:1s', 'Customer conversations'].map((name) => [name, store.addFolder(name).id]),
);
const now = new Date();
for (const [title, participants, daysAgo, hourOfDay, minutes, folder, extra] of [
  ['Q4 roadmap review', 'Priya, Sam & Jordan', 0, 11, 45, 'Product', {}],
  [
    'Customer conversation — Cedar',
    'Taylor & Alex',
    0,
    9,
    40,
    'Customer conversations',
    { starred: true },
  ],
  ['1:1 — Alex', 'Alex', 1, 16, 30, '1:1s', {}],
  ['Research synthesis', 'Sam, Taylor & Jordan', 1, 10, 50, 'Product', {}],
  ['Pricing workshop', 'Jordan & Taylor', 4, 14, 60, null, {}],
  ['Hiring sync', 'Sam', 6, 13, 25, null, {}],
]) {
  const created = new Date(now);
  created.setDate(created.getDate() - daysAgo);
  created.setHours(hourOfDay, 0, 0, 0);
  const m = store.create({ title, participants, notes: 'Agenda and open questions.' });
  store.write({
    ...m,
    ...extra,
    createdAt: created.toISOString(),
    updatedAt: created.toISOString(),
    duration: minutes * 60,
    folderId: folder ? folders[folder] : null,
  });
}
for (const [key, value] of Object.entries({ provider: 'claude', calendarConnected: true }))
  store.setting(key, value);
store.close();

const desktop = await electron.launch({
  args: ['.'],
  env: {
    ...process.env,
    NODE_ENV: 'test',
    STILLNOTE_DATA_DIR: dataDir,
    STILLNOTE_TEST_ADAPTER: resolve('tests/e2e/adapter.mjs'),
    STILLNOTE_E2E_SCENARIO_FILE: scenarioPath,
    STILLNOTE_MOCK_KEYCHAIN: '1',
  },
  timeout: 30000,
});
const child = desktop.process();
const page = await desktop.firstWindow();
page.setDefaultTimeout(20000);
const shot = async (name) => {
  console.log(`  ${name}.png`);
  await page.getByText('Unsaved', { exact: true }).waitFor({ state: 'hidden' });
  await page.screenshot({ path: join(out, name + '.png'), scale: 'css' });
};
const wait = (ms) => page.waitForTimeout(pace(ms));
const type = (locator, text) => locator.pressSequentially(text, { delay: demo ? 28 : 0 });
const button = (name) => {
  console.log(`  → ${name}`);
  return page.getByRole('button', { name, exact: true });
};
// Playwright's recordVideo stalls Electron's renderer, so the demo records a CDP screencast:
// one JPEG per painted frame, timed by the compositor, stitched into a GIF afterwards.
const framesDir = join(dataDir, 'frames');
const frames = [];
let cast;
async function startCast() {
  mkdirSync(framesDir);
  cast = await desktop.context().newCDPSession(page);
  cast.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = join(framesDir, `${String(frames.length).padStart(5, '0')}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, at: metadata.timestamp });
    cast.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cast.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 90,
    maxWidth: 1280,
    maxHeight: 800,
  });
}
try {
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1280, 800),
  );
  await page.getByText('Design critique', { exact: true }).waitFor();
  if (demo) await startCast();
  await wait(1500);
  await shot('home');

  // A new meeting: rough notes, then record while the transcript fills in.
  await button('New note').click();
  const title = page.getByRole('textbox', { name: 'Meeting title' });
  await title.fill('');
  await type(title, 'Weekly product sync');
  await page.getByRole('textbox', { name: 'Participants' }).fill('Alex, Sam');
  const notes = page.getByRole('textbox', { name: 'My notes', exact: true });
  await notes.click();
  await type(notes, 'Onboarding: one decision at a time\n');
  await button('Start recording').click();
  await wait(5200);
  await type(notes, 'Record button moves to the dock\n');
  await button('Show transcript').click();
  await page.getByText(transcript.at(-1).text, { exact: true }).waitFor();
  await wait(1200);
  await shot('recording');
  await button('Hide transcript').click();
  await type(notes, 'Alex sends revised flow Friday');
  await wait(800);
  await button('Stop recording').click();

  // Stopping enhances the notes: the user's own points stay dark, Claude's additions are lighter.
  await page.getByRole('heading', { name: 'Next steps' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.analyzing'));
  await wait(1800);
  await shot('note');

  await button('Show transcript').click();
  await wait(1000);
  await page.getByRole('tab', { name: 'Recordings' }).click();
  await wait(1200);
  await shot('recordings');
  await button('Close transcript').click();

  // Ask the meeting a question; the answer cites its source.
  await button('Chat with this meeting').click();
  await type(page.getByRole('textbox', { name: 'Ask a question' }), 'What did we decide?');
  await wait(400);
  await button('Send question').click();
  await page.locator('.source-chip').first().waitFor();
  await wait(2600);
  await shot('chat');
  if (demo) await cast.send('Page.stopScreencast');
  await button('Close chat').click();

  await button('Back to Home').click();
  await button('Settings').click();
  await page.getByRole('dialog').waitFor();
  await wait(600);
  await shot('settings-ai');
  await button('Recording').click();
  await wait(800);
  await shot('settings-recording');
  await page.keyboard.press('Escape');
  // Escape returns focus to the settings button; drop its focus ring before the dark shots.
  await page.evaluate(() => document.activeElement?.blur());

  await page.emulateMedia({ colorScheme: 'dark' });
  await wait(500);
  await shot('home-dark');
} catch (error) {
  await page
    .screenshot({ path: resolve('output/screenshot-failure.png') })
    .catch((e) => console.error(e.message));
  console.error('Capture failed (see output/screenshot-failure.png):', error.message);
  process.exitCode = 1;
} finally {
  // A failure mid-recording makes the app refuse to close; never wait on it forever.
  await Promise.race([desktop.close(), new Promise((done) => setTimeout(done, 5000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
if (process.exitCode) process.exit();
process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }));

if (demo) {
  // Each frame lasts until the next one painted; the last one holds for a moment before the loop.
  const list = frames.flatMap(({ file, at }, i) => [
    `file '${file}'`,
    `duration ${((frames[i + 1]?.at ?? at + 2.5) - at).toFixed(3)}`,
  ]);
  writeFileSync(join(framesDir, 'list.txt'), [...list, `file '${frames.at(-1).file}'`].join('\n'));
  const gif = join(out, 'demo.gif');
  const palette = join(framesDir, 'palette.png');
  const keyShots = ['home', 'recording', 'note', 'recordings', 'chat'];
  const ffmpeg = (args) =>
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  // One palette from the key screens: built from every frame, the greys crowd out the small
  // accents (calendar bars, citation chips); per-frame palettes keep them but weigh ~25x more.
  ffmpeg([
    ...keyShots.flatMap((name) => ['-i', join(out, name + '.png')]),
    '-filter_complex',
    `${keyShots.map((_, i) => `[${i}]`).join('')}vstack=inputs=${keyShots.length},scale=960:-1:flags=lanczos,palettegen=max_colors=256:reserve_transparent=0`,
    palette,
  ]);
  ffmpeg([
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    join(framesDir, 'list.txt'),
    '-i',
    palette,
    '-lavfi',
    '[0]fps=10,scale=960:-1:flags=lanczos[v];[v][1]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    '-loop',
    '0',
    gif,
  ]);
  console.log(
    `Demo: ${gif} (${(statSync(gif).size / 1e6).toFixed(1)} MB, ${frames.length} frames)`,
  );
}
console.log(`Screenshots saved to ${out} using fictional fixtures.`);
