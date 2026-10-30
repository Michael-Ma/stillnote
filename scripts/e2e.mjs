#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Harness, root } from '../tests/e2e/harness.mjs';
import { notebook } from '../tests/e2e/notebook.mjs';
import { images } from '../tests/e2e/images.mjs';
import { capture, captureScenario } from '../tests/e2e/capture.mjs';
import { ai, aiScenario } from '../tests/e2e/ai.mjs';
import { recovery } from '../tests/e2e/recovery.mjs';
import { language, languageScenario } from '../tests/e2e/language.mjs';
import { reminders, remindersScenario } from '../tests/e2e/reminders.mjs';
import { calls, callsScenario } from '../tests/e2e/calls.mjs';
import { meetingEnd, meetingEndScenario } from '../tests/e2e/meeting-end.mjs';

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
    'Usage: node scripts/e2e.mjs [--suite notebook|images|capture|ai|recovery|reminders|calls|language|meeting-end|all] [--no-build] [--output path]\nRuns deterministic Electron E2E tests with synthetic audio and AI. No real account or device is used.',
  );
  process.exit(0);
}
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve(option('--output') ?? join(root, 'output/e2e', runId));
mkdirSync(output, { recursive: true });
// A calendar link's answer: one meeting that starts in an hour.
function calendarFeed(title) {
  const stamp = (at) => new Date(at).toISOString().replace(/[-:]|\.\d{3}/g, '');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:e2e-linked',
    `SUMMARY:${title}`,
    `DTSTART:${stamp(Date.now() + 3_600_000)}`,
    `DTEND:${stamp(Date.now() + 5_400_000)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}
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
  calls: {
    run: calls,
    scenario: callsScenario,
    checks: [
      'Start Google Meet opens meet.google.com/new and records a new note',
      'the chevron starts Zoom and remembers it',
      'Join & record only for meetings with a call link',
      'reminder invites joining; its click records and joins',
      'meeting detected: one notification and in-app prompt per call',
      'no prompt while or after recording the same call',
      'detection can be turned off',
      'Start meeting, Join & record and the prompt in Chinese',
    ],
  },
  'meeting-end': {
    run: meetingEnd,
    scenario: meetingEndScenario,
    checks: [
      'the call app letting go of the microphone prompts with a countdown',
      'Keep recording carries on past the countdown',
      'the countdown stops the recording and trims the trailing silence',
      'Resume recording continues in the same note; a manual stop trims too',
      'Only ask waits for Stop now',
      'the prompt in Chinese',
    ],
  },
  images: {
    run: images,
    scenario: { connected: false },
    checks: [
      'a pasted image shows in place, on a line of its own, saved in the meeting’s folder',
      'Backspace deletes the whole image and Undo brings it back',
      'clicking an image shows it large',
      'a file that only claims to be an image is refused',
      'search ignores image addresses',
      'images survive a restart',
      'Markdown export embeds images; backups carry them',
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
    scenario: {
      connected: false,
      calendarFeed: calendarFeed('E2E linked standup'),
      calendar: [
        { id: 'mac-work', title: 'E2E Mac planning', startIn: 7_200_000, calendarId: 'work' },
        { id: 'mac-home', title: 'E2E Mac dentist', startIn: 10_800_000, calendarId: 'home' },
      ],
      calendars: [
        { id: 'work', name: 'Work', account: 'Google', color: '#3366cc' },
        { id: 'home', name: 'Family', account: 'iCloud', color: '#cc3366' },
      ],
      sources: {
        granola: {
          list_meetings: {
            meetings: [
              { id: 'g1', title: 'E2E Granola pricing review', date: '2026-10-21T10:00:00Z' },
            ],
          },
          get_meetings: {
            meetings: [
              { id: 'g1', private_notes: 'Seats question', summary: 'Ship the team plan' },
            ],
          },
          get_meeting_transcript: { transcript: '[0:05] Me: Shall we ship?\n[0:09] Them: Yes.' },
        },
        notion: {
          'notion-search': {
            results: [
              {
                id: '01234567-89ab-cdef-0123-456789abcdef',
                title: 'E2E Notion weekly sync',
                type: 'page',
                timestamp: '2026-10-22T10:00:00Z',
              },
            ],
          },
          'notion-fetch': {
            title: 'E2E Notion weekly sync',
            text: '<page><content>Decisions from Notion</content></page>',
          },
        },
      },
    },
    checks: [
      'create/edit/save',
      'transcript entry',
      'dock Transcript button and ⌘⇧T open the sheet',
      'folder/star',
      'Markdown export',
      'import from Granola',
      'calendar link without the Mac calendar',
      'calendars managed in Settings: connect, turn one off, disconnect',
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
      'speaker echo left out of the transcript',
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
