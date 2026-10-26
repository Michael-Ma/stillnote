#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Harness, root } from '../tests/e2e/harness.mjs';
import { notebook } from '../tests/e2e/notebook.mjs';
import { capture, captureScenario } from '../tests/e2e/capture.mjs';
import { ai, aiScenario } from '../tests/e2e/ai.mjs';
import { recovery } from '../tests/e2e/recovery.mjs';
import { language, languageScenario } from '../tests/e2e/language.mjs';
import { reminders, remindersScenario } from '../tests/e2e/reminders.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--'))
    throw new Error(`Missing value for ${name}`);
  return args[index + 1];
};
if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/e2e.mjs [--suite notebook|capture|ai|recovery|reminders|language|all] [--no-build] [--output path]\nRuns deterministic Electron E2E tests with synthetic audio and AI. No real account or device is used.',
  );
  process.exit(0);
}
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve(option('--output') ?? join(root, 'output/e2e', runId));
mkdirSync(output, { recursive: true });
const suites = {
  language: {
    run: language,
    scenario: languageScenario,
    checks: [
      'switching to 简体中文 updates the window without a restart',
      'no English labels left on Home',
      'reminder notification in Chinese',
      'new note title and dock in Chinese',
      'switching back to English',
    ],
  },
  reminders: {
    run: reminders,
    scenario: remindersScenario,
    checks: [
      'calendar connection persisted',
      'only timed, starting meetings announced',
      'reminder opens a linked note and records',
      'no duplicate reminder',
      'Coming up reuses the linked note',
      'auto-record can be turned off',
    ],
  },
  recovery: {
    run: recovery,
    scenario: {},
    checks: [
      'startup interrupted-session detection',
      'stale WAV header repair',
      'recovered duration',
      'preserved notes/transcript',
      'recovered audio playback',
      'idempotent restart',
      'quit during recording saves it',
    ],
  },
  notebook: {
    run: notebook,
    scenario: { connected: false },
    checks: [
      'create/edit/save',
      'transcript entry',
      'dock Transcript button and ⌘⇧T open the sheet',
      'folder/star',
      'Markdown export',
      'backup',
      'idempotent restore',
      'invalid import atomicity',
      'text import',
      'trash/restore',
      'CJK search',
      'close/restart persistence',
      '1024px chat layout',
    ],
  },
  capture: {
    run: capture,
    scenario: captureScenario,
    checks: [
      'capture state',
      'closing during recording saves it',
      'two-source WAV artifacts',
      'persisted transcript',
      'transcript and recordings labelled in the dock',
      'audio decoding/playback',
      'restart playback',
      'last partial persisted once',
      'empty recognition retains audio',
      'coverage warning',
      'retry from saved audio',
      'recognition failure',
      'permission failure recovery',
      'multiple sessions',
      'unavailable system audio preserves microphone track',
      'screen-recording denial links to Settings',
    ],
  },
  ai: {
    run: ai,
    scenario: aiScenario,
    checks: [
      'failed/empty/incomplete response rejection',
      'cancel',
      'prior summary preserved',
      'retry recovery',
      'summary revision',
      'rough notes preserved',
      'cited chat',
      'summary/chat restart persistence',
    ],
  },
};
const selection = option('--suite') ?? 'all';
if (selection !== 'all' && !suites[selection]) throw new Error(`Unknown suite: ${selection}`);
const report = {
  version: 1,
  runId,
  startedAt: new Date().toISOString(),
  status: 'running',
  scope:
    'Deterministic Electron UI → preload → real IPC → SQLite/files/media protocol, with synthetic native and AI adapters',
  realMicrophoneTested: false,
  realSystemAudioTested: false,
  realSpeechRecognitionTested: false,
  realChatGPTTested: false,
  output,
  suites: [],
};
const save = () => writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
save();
try {
  if (!args.includes('--no-build')) {
    await new Promise((resolve, reject) => {
      const child = spawn('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Build exited with ${code}`)),
      );
    });
  }
  if (!existsSync(join(root, 'dist-electron/main.js')))
    throw new Error('Built app is missing. Run npm run build.');
  for (const [name, suite] of Object.entries(suites)) {
    if (selection !== 'all' && name !== selection) continue;
    console.log(`E2E ${name}: starting`);
    const harness = new Harness(output, name, suite.scenario);
    const started = performance.now();
    const result = {
      name,
      status: 'running',
      checks: suite.checks,
      artifactDirectory: harness.output,
    };
    report.suites.push(result);
    save();
    try {
      await suite.run(harness);
      result.status = 'passed';
    } catch (error) {
      result.status = 'failed';
      result.error = { message: error.message, stack: error.stack };
      console.error(`E2E ${name}: ${error.stack}`);
    } finally {
      result.durationMs = Math.round(performance.now() - started);
      await harness.dispose(result.status === 'failed');
      save();
    }
    console.log(`E2E ${name}: ${result.status} (${result.durationMs} ms)`);
  }
  report.status = report.suites.every((suite) => suite.status === 'passed') ? 'passed' : 'failed';
} catch (error) {
  report.status = 'failed';
  report.error = { message: error.message, stack: error.stack };
  console.error(error.stack);
} finally {
  report.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ status: report.status, report: join(output, 'report.json') }));
  if (report.status !== 'passed') process.exitCode = 1;
}
