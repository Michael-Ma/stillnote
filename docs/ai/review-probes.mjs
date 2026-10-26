// Audit probes for 0b6568b. These ASSERT CURRENT DEFECTS, not product correctness.
// Only disposable databases, fake providers/helpers and synthetic text are used.
// Run: node docs/ai/review-probes.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../../app/store.mjs';
import { createLiveArbiter } from '../../app/language-arbiter.mjs';
import { ClaudeCode, cliEnv } from '../../app/providers/claude-code.mjs';

const root = resolve(import.meta.dirname, '../..');
const dir = mkdtempSync(join(tmpdir(), 'stillnote-review-'));
const observations = {};
const environment = { ...process.env };
let db, hook, app, win;
const tick = () => new Promise((done) => setImmediate(done));
const until = async (check) => {
  const deadline = Date.now() + 3000;
  while (!(await check()) && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 10));
  assert.ok(await check(), 'Fixture did not reach expected state');
};
try {
  db = new Store(join(dir, 'store'));
  const meeting = db.create({ title: '项目进展', notes: '讨论项目计划和发布日期' });
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'search_meetings', arguments: { query: '项目' } },
  };
  const reply = spawnSync(process.execPath, [join(root, 'scripts/mcp.mjs')], {
    input: JSON.stringify(request) + '\n',
    encoding: 'utf8',
    env: { ...process.env, STILLNOTE_DATA_DIR: join(dir, 'store') },
  });
  const message = JSON.parse(reply.stdout.trim());
  const mcpMatches = JSON.parse(message.result.content[0].text);
  assert.equal(db.search('项目').length, 1);
  assert.equal(mcpMatches.length, 0);
  observations.mcpCjk = { applicationMatches: 1, mcpMatches: 0 };

  db.message('all', 'assistant', 'SYNTHETIC_PRIVATE_DETAIL [1]', [
    { id: meeting.id, title: meeting.title, number: 1 },
  ]);
  db.update(meeting.id, { deletedAt: true });
  db.deleteForever([meeting.id]);
  assert.equal(db.all(true).length, 0);
  assert.ok(JSON.stringify(db.backup()).includes('SYNTHETIC_PRIVATE_DETAIL'));
  observations.deletedEvidence = { noteRemoved: true, citedAnswerRetainedInChatAndBackup: true };
  db.close();
  db = undefined;

  const arbiter = createLiveArbiter({ locales: ['en-US', 'zh-CN'], startedAt: 0, stall: 15000 });
  const displayed = new Map();
  const apply = (actions) =>
    actions.forEach((a) => {
      if (a.type === 'partial') displayed.set(a.event.segmentId, a.event.text);
      if (a.type === 'discard') a.segmentIds.forEach((id) => displayed.delete(id));
      if (a.type === 'segment') displayed.delete(a.segment.segmentId);
    });
  apply(
    arbiter.push(
      {
        type: 'partial',
        locale: 'en-US',
        source: 'microphone',
        segmentId: 'stale',
        timestamp: 0,
        end: 1,
        text: 'Expired provisional fixture',
      },
      0,
    ),
  );
  const flushed = arbiter.flush(16000);
  apply(flushed);
  assert.equal(displayed.size, 1);
  assert.deepEqual(flushed, []);
  observations.autoFlush = {
    expiredPartialsStillHeldByCaller: displayed.size,
    discardActionsReturned: 0,
  };

  const binary = '/fixture/bin/claude',
    log = join(dir, 'claude-calls.jsonl');
  const env = { ...process.env, FAKE_CLAUDE_LOG: log };
  const claude = new ClaudeCode({
    workDir: join(dir, 'cli'),
    env,
    candidates: [binary],
    shell: null,
    executable: (p) => p === binary,
    spawn: (_cmd, args, opts) =>
      spawn(process.execPath, [join(root, 'tests/fixtures/fake-claude.mjs'), ...args], opts),
  });
  await claude.refresh();
  assert.equal(claude.status().billing, 'subscription');
  env.FAKE_CLAUDE_AUTH = 'api_key';
  await claude.respond({ model: 'haiku', input: 'Synthetic audit request' });
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter((c) => c.args[0] === 'auth' && c.args[1] === 'status').length, 1);
  assert.equal(calls.filter((c) => c.args[0] === '-p').length, 1);
  const routed = cliEnv(
    { ANTHROPIC_BASE_URL: 'https://example.invalid', CLAUDE_CODE_USE_BEDROCK: '1' },
    binary,
    dir,
  );
  assert.equal(routed.ANTHROPIC_BASE_URL, 'https://example.invalid');
  assert.equal(routed.CLAUDE_CODE_USE_BEDROCK, '1');
  observations.claude = {
    inferenceStartedAfterAuthChangedToApi: true,
    newStatusChecks: 0,
    customEndpointPreserved: true,
  };

  // The production main process, under the repo's existing fake Electron contract.
  const electron = await import('../../tests/fixtures/electron.mjs');
  ({ app } = electron);
  hook = registerHooks({
    resolve(specifier, context, next) {
      return next(
        specifier === 'electron'
          ? new URL('../../tests/fixtures/electron.mjs', import.meta.url).href
          : specifier,
        context,
      );
    },
  });
  const adapter = join(dir, 'adapter.mjs');
  writeFileSync(
    adapter,
    `import { createTestAdapter as baseFactory } from ${JSON.stringify(pathToFileURL(join(root, 'tests/e2e/adapter.mjs')).href)};
export function createTestAdapter(options) {
 const base=baseFactory(options), c=globalThis.__reviewControl={holdStop:false,busy:false,kills:0,cancels:0,spawns:0,joins:[],releaseStop:null};
 const originalOpen=base.openExternal;
 return {...base, openExternal:async url=>{c.joins.push(url);return originalOpen(url);}, createNative(){
  c.spawns++;const child=base.createNative(),write=child.stdin.write.bind(child.stdin),kill=child.kill.bind(child);
  child.kill=(...args)=>{c.kills++;return kill(...args);};
  child.stdin.write=(line,...args)=>{const cmd=JSON.parse(String(line));
   if(cmd.op==='transcribe'){c.busy=true;return true;}
   if(cmd.op==='cancel-transcribe'){c.cancels++;return true;}
   if(cmd.op==='start'&&c.busy){setImmediate(()=>child.stdout.write(JSON.stringify({type:'error',op:'start',recordingId:cmd.recordingId,message:'Helper is still transcribing'})+'\\n'));return true;}
   if(cmd.op==='stop'&&c.holdStop){c.releaseStop=()=>write(line,...args);return true;}
   return write(line,...args);
  };return child;
 }};
}`,
  );
  const dataDir = join(dir, 'main');
  const scenario = join(dir, 'scenario.json');
  writeFileSync(
    scenario,
    JSON.stringify({
      calendar: [
        {
          id: 'fixture-next',
          title: 'Synthetic next call',
          startIn: 30000,
          notes: 'https://meet.google.com/abc-defg-hij',
        },
      ],
    }),
  );
  Object.assign(process.env, {
    NODE_ENV: 'test',
    STILLNOTE_DATA_DIR: dataDir,
    STILLNOTE_TEST_ADAPTER: adapter,
    STILLNOTE_E2E_SCENARIO_FILE: scenario,
  });
  app.removeAllListeners();
  electron.ipcMain.handlers.clear();
  await import('../../app/main.mjs?review-probe');
  await until(() => {
    win = electron.BrowserWindow.instances.at(-1);
    return win?.loaded;
  });
  const call = (name, ...args) =>
    electron.ipcMain.handlers.get('stillnote:' + name)(
      { sender: win.webContents, senderFrame: win.webContents.mainFrame },
      ...args,
    );
  await call('setting', 'autoEnhance', false);
  const first = await call('create', { title: 'Synthetic first call' });
  await call('record', first.id);
  await until(async () => !(await call('state')).starting);
  await call('calendar');
  await until(() => globalThis.__stillnoteReminders?.length);
  const control = globalThis.__reviewControl;
  control.holdStop = true;
  globalThis.__stillnoteReminders[0].open();
  await tick();
  const during = await call('state');
  assert.equal(during.recording.id, first.id);
  assert.equal(during.recording.stopping, true);
  assert.equal(control.joins.length, 1);
  observations.handoff = {
    newCallOpenedBeforeOldStopAcknowledged: true,
    oldRecordingStillActive: true,
  };
  control.holdStop = false;
  control.releaseStop();
  await until(async () => !(await call('state')).recording);
  const saved = (await call('state')).meetings.find((m) => m.id === first.id);
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 90000 ? 20 : ms, ...args);
  try {
    await assert.rejects(
      call('transcribe-recording', first.id, saved.recordings[0].id),
      /timed out/i,
    );
  } finally {
    globalThis.setTimeout = originalTimeout;
  }
  assert.equal(control.cancels, 1);
  assert.equal(control.kills, 0);
  const next = await call('create', { title: 'After stalled retry' });
  await call('record', next.id);
  await tick();
  await tick();
  const failed = (await call('state')).meetings.find((m) => m.id === next.id);
  assert.equal(failed.recordings[0].status, 'startfailed');
  observations.retryTimeout = {
    cancelSent: true,
    helperReplaced: false,
    nextRecording: 'startfailed',
  };

  console.log(
    JSON.stringify({ auditedDefectsObserved: true, syntheticOnly: true, observations }, null, 2),
  );
} finally {
  db?.close();
  app?.emit('before-quit', { preventDefault() {} });
  await tick();
  win?.destroy();
  hook?.deregister();
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
  Object.assign(process.env, environment);
  rmSync(dir, { recursive: true, force: true });
}
