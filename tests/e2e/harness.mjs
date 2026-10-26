import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

export const root = resolve(import.meta.dirname, '../..');

export class Harness {
  constructor(output, name, scenario = {}) {
    this.name = name;
    this.output = join(output, name);
    mkdirSync(this.output, { recursive: true });
    this.dataDir = mkdtempSync(join(tmpdir(), 'stillnote-e2e-'));
    this.scenarioPath = join(this.dataDir, 'scenario.json');
    writeFileSync(this.scenarioPath, JSON.stringify(scenario));
    this.errors = [];
    this.events = [];
  }
  async launch() {
    this.desktop = await electron.launch({
      args: ['.'],
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        STILLNOTE_DATA_DIR: this.dataDir,
        STILLNOTE_MOCK_KEYCHAIN: '1',
        STILLNOTE_UI_LANGUAGE: this.uiLanguage ?? 'en',
        STILLNOTE_TEST_ADAPTER: join(root, 'tests/e2e/adapter.mjs'),
        STILLNOTE_E2E_SCENARIO_FILE: this.scenarioPath,
      },
      timeout: 30000,
    });
    this.page = await this.desktop.firstWindow();
    this.page.setDefaultTimeout(12000);
    this.page.on('pageerror', (e) => this.errors.push(e.message));
    await this.page.getByRole('button', { name: 'New note', exact: true }).waitFor();
    await this.page.evaluate(() => {
      window.__e2eEvents = [];
      window.stillnote.subscribe((event) => window.__e2eEvents.push(event));
    });
    const state = await this.state();
    assert.equal(state.dataDir, this.dataDir, 'The app must use the disposable test directory');
    assert.ok(
      existsSync(join(this.dataDir, 'adapter-ready.json')),
      'Test adapter was not loaded. Refusing capture or AI tests without an isolated adapter. Rebuild the app.',
    );
    assert.ok(
      existsSync(join(this.dataDir, 'adapter-auth-ready.json')),
      'Synthetic authentication was not injected. Refusing account operations.',
    );
    return this.page;
  }
  async call(name, ...args) {
    return this.page.evaluate(({ name, args }) => window.stillnote.call(name, ...args), {
      name,
      args,
    });
  }
  state() {
    return this.call('state');
  }
  // Polls the app's state until the predicate holds. (A string predicate handed to
  // waitForFunction evaluated to the function itself, which is truthy, so it never waited.)
  async waitForState(predicate, argument, timeout = 12000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const state = await this.state();
      if (predicate(state, argument)) return state;
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for state: ${predicate.toString().slice(0, 160)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  async create(title, notes = '') {
    const existing = (await this.state()).meetings.map((meeting) => meeting.id);
    // Like Granola, the note view has no New note button; start from Home.
    if (await this.page.getByRole('button', { name: 'Back to Home', exact: true }).count())
      await this.page.getByRole('button', { name: 'Back to Home', exact: true }).click();
    await this.page.getByRole('button', { name: 'New note', exact: true }).click();
    await this.waitForState(
      (state, ids) => state.meetings.some((meeting) => !ids.includes(meeting.id)),
      existing,
    );
    await this.page.waitForFunction(
      () => document.querySelector('[aria-label="Meeting title"]')?.value === 'Untitled meeting',
    );
    await this.page.getByRole('textbox', { name: 'Meeting title', exact: true }).fill(title);
    if (notes) await this.page.getByRole('textbox', { name: 'My notes', exact: true }).fill(notes);
    // Use the application's own save barrier before inspecting state.
    await this.page.getByRole('button', { name: 'Back to Home', exact: true }).click();
    await this.page
      .getByRole('textbox', { name: 'Meeting title', exact: true })
      .waitFor({ state: 'hidden' });
    const state = await this.waitForState(
      (s, title) => s.meetings.some((m) => m.title === title),
      title,
    );
    await this.open(title);
    return state.meetings.find((m) => m.title === title);
  }
  // Transcript and Recordings live in the sheet above the dock, opened from their dock buttons.
  // Recordings has a button only once a session is saved; before that, its tab is in the sheet.
  async sheet(tab) {
    const name = new RegExp(`^${tab}`);
    const dock = this.page.locator('.dock');
    if (!(await this.page.getByRole('tab', { name }).count())) {
      const button = dock.getByRole('button', { name });
      await ((await button.count()) ? button : dock.getByRole('button', { name: /^Transcript/ }))
        .first()
        .click();
    }
    await this.page.getByRole('tab', { name }).click();
  }
  async open(title) {
    if (await this.page.getByRole('button', { name: 'Back to Home', exact: true }).count()) {
      await this.page.getByRole('button', { name: 'Back to Home', exact: true }).click();
      await this.page
        .getByRole('textbox', { name: 'Meeting title', exact: true })
        .waitFor({ state: 'hidden' });
    }
    await this.page.locator('.note-row').filter({ hasText: title }).click();
    await this.page.getByRole('textbox', { name: 'Meeting title', exact: true }).waitFor();
  }
  async screenshot(name) {
    const path = join(this.output, name + '.png');
    await this.page.screenshot({ path, fullPage: true });
    return path;
  }
  // The floating panel window (reminders, detection, meeting end), once one has been shown,
  // with what it says on screen. Invisible and click-through in scripted runs, it is still
  // driven and photographed like the main window.
  async panel() {
    for (let i = 0; i < 100; i++) {
      const page = this.desktop.windows().find((w) => w.url().endsWith('/panel.html'));
      if (page) {
        this.panelPage ??= (page.on('pageerror', (e) => this.errors.push(e.message)), page);
        await page.locator('.panel').waitFor();
        return page;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The panel window never opened.');
  }
  async panelScreenshot(name) {
    const path = join(this.output, name + '.png');
    await (await this.panel()).locator('.panel').screenshot({ path });
    return path;
  }
  async saveDialog(path) {
    await this.desktop.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, path);
  }
  async openDialog(path) {
    await this.desktop.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, path);
  }
  async close() {
    if (!this.desktop) return;
    const desktop = this.desktop;
    await this.page.evaluate(() => window.stillnote.call('stop')).catch(() => {});
    await this.waitForState((s) => !s.recording && !s.starting).catch(() => {});
    this.events.push(
      ...(await this.page.evaluate(() => window.__e2eEvents?.splice(0) ?? []).catch(() => [])),
    );
    const exited = new Promise((resolve) => {
      const child = desktop.process();
      if (child.exitCode !== null) resolve();
      else child.once('exit', resolve);
    });
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    let timer;
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('App did not flush and close within 10 seconds')),
          10000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    this.desktop = null;
  }
  // Runs an action that should make Stillnote quit on its own, and waits for the process to end.
  async exitDuring(action) {
    const child = this.desktop.process();
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', resolve);
    });
    await action().catch(() => {});
    let timer;
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Stillnote did not quit within 15 seconds')),
          15000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    this.desktop = null;
  }
  async restart() {
    await this.close();
    return this.launch();
  }
  async dispose(failed = false) {
    if (this.page && !this.page.isClosed()) {
      this.events.push(
        ...(await this.page.evaluate(() => window.__e2eEvents?.splice(0) ?? []).catch(() => [])),
      );
      if (failed) await this.screenshot('failure').catch(() => {});
    }
    if (this.desktop) {
      await this.close().catch(async () => {
        await this.desktop?.close().catch(() => {});
      });
    }
    writeFileSync(join(this.output, 'events.json'), JSON.stringify(this.events, null, 2));
    writeFileSync(join(this.output, 'renderer-errors.json'), JSON.stringify(this.errors, null, 2));
    if (existsSync(join(this.dataDir, 'adapter-events.jsonl')))
      copyFileSync(
        join(this.dataDir, 'adapter-events.jsonl'),
        join(this.output, 'adapter-events.jsonl'),
      );
    copyFileSync(this.scenarioPath, join(this.output, 'scenario.json'));
    rmSync(this.dataDir, { recursive: true, force: true });
  }
  assertNoRendererErrors() {
    assert.deepEqual(this.errors, [], 'Unexpected renderer errors');
  }
}
