import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpConnections, SOURCES } from '../app/mcp-auth.mjs';
import { fakeNotesApp } from './fixtures/mcp-server.mjs';

// Test-only reversible adapter. Production uses Electron safeStorage backed by macOS Keychain.
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s),
  decryptString: (b) => b.toString(),
};
const text = (value) => ({ content: [{ type: 'text', text: value }] });

async function fixture(t, options = {}) {
  const app = await fakeNotesApp(options);
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-mcp-'));
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let clock = 1_000_000;
  const opened = [];
  const make = () =>
    new McpConnections({
      path: join(dir, 'connections.enc'),
      encryption,
      // The "browser" follows the authorization redirect back to Stillnote's callback.
      openBrowser: async (url) => {
        opened.push(url);
        await fetch(url);
      },
      sources: {
        notes: { name: 'Notes', url: app.url, scope: 'default', tools: ['search', 'fetch'] },
      },
      now: () => clock,
      spacing: 0,
      loopbackHttp: true,
    });
  return { app, dir, opened, make, tick: (ms) => (clock += ms) };
}

test('connecting registers once, signs in with PKCE, and keeps tokens encrypted', async (t) => {
  const { app, dir, opened, make } = await fixture(t);
  const connections = make();
  assert.deepEqual(connections.status(), {
    notes: { name: 'Notes', connected: false, connecting: false },
  });
  const status = await connections.connect('notes');
  assert.equal(status.notes.connected, true);
  const url = new URL(opened[0]);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('resource'), app.url);
  assert.match(url.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const saved = JSON.parse(readFileSync(join(dir, 'connections.enc'), 'utf8'));
  assert.ok(app.access.has(saved.notes.tokens.access_token));
  // Signing in again reuses the registration (its port is free again).
  await connections.disconnect('notes');
  await connections.connect('notes');
  assert.equal(app.log.filter((line) => line === 'POST /register').length, 1);
  // A restarted app is still connected.
  const reopened = make();
  reopened.load();
  assert.equal(reopened.status().notes.connected, true);
});

test('only the listed tools are called, over JSON or an event stream, in one session', async (t) => {
  const { app, make } = await fixture(t, {
    tools: {
      search: async ({ query }) => text(`found ${query}`),
      fetch: async () => ({ ...text('page body'), stream: true }),
      write: async () => text('should never run'),
    },
  });
  const connections = make();
  await connections.connect('notes');
  const posts = () => app.log.filter((line) => line === 'POST /mcp').length;
  const before = posts();
  assert.equal(
    (await connections.tool('notes', 'search', { query: 'sync' })).content[0].text,
    'found sync',
  );
  assert.equal((await connections.tool('notes', 'fetch', {})).content[0].text, 'page body');
  await assert.rejects(connections.tool('notes', 'write', {}), /does not use this tool/);
  assert.ok(!app.log.some((line) => line.startsWith('tool write')));
  assert.equal(posts() - before, 4, 'initialize, initialized, 2 calls');
  // A forgotten session is started again.
  app.forgetSessions();
  assert.equal(
    (await connections.tool('notes', 'search', { query: 'again' })).content[0].text,
    'found again',
  );
  await assert.rejects(connections.tool('notes', 'missing'), /does not use this tool/);
  await assert.rejects(make().tool('other', 'search'), /Unknown app/);
});

test('an expiring token is refreshed once for concurrent calls, and rotated', async (t) => {
  const { app, make, tick } = await fixture(t, {
    tools: { search: async () => text('ok') },
    accessLifetime: 600,
  });
  const connections = make();
  await connections.connect('notes');
  const first = connections.saved.notes.tokens;
  tick(500_000);
  await Promise.all([1, 2, 3].map(() => connections.tool('notes', 'search', {})));
  assert.equal(app.log.filter((line) => line === 'POST /token').length, 2, 'sign-in + one refresh');
  assert.notEqual(connections.saved.notes.tokens.refresh_token, first.refresh_token);
  assert.ok(!app.refresh.has(first.refresh_token), 'the old refresh token was used up');
});

test('a token the server stops accepting is refreshed; a dead grant asks to reconnect', async (t) => {
  const { app, make } = await fixture(t, { tools: { search: async () => text('ok') } });
  const connections = make();
  await connections.connect('notes');
  app.access.clear();
  assert.equal((await connections.tool('notes', 'search', {})).content[0].text, 'ok');
  app.access.clear();
  app.failRefresh = { status: 503, body: {} };
  await assert.rejects(connections.tool('notes', 'search', {}), /failed \(503\)/);
  assert.equal(connections.status().notes.connected, true, 'a passing outage keeps the grant');
  app.failRefresh = { status: 400, body: { error: 'invalid_grant' } };
  await assert.rejects(connections.tool('notes', 'search', {}), /Reconnect Notes/);
  assert.equal(connections.status().notes.connected, false);
});

test('disconnecting revokes the grant and keeps the registration', async (t) => {
  const { app, make } = await fixture(t);
  const connections = make();
  await connections.connect('notes');
  const token = connections.saved.notes.tokens.refresh_token;
  await connections.disconnect('notes');
  assert.deepEqual(app.revoked, [token]);
  assert.equal(connections.saved.notes.client.id, 'client-1');
  await assert.rejects(connections.tool('notes', 'search', {}), /Connect Notes first/);
});

test('a declined or forged sign-in leaves Stillnote disconnected', async (t) => {
  const { app, make } = await fixture(t);
  const connections = make();
  app.deny = true;
  await assert.rejects(connections.connect('notes'), /declined/);
  app.deny = false;
  app.wrongState = true;
  const attempt = connections.connect('notes');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(connections.status().notes.connecting, true, 'a forged callback is ignored');
  connections.cancel('notes');
  await assert.rejects(attempt, /cancelled/);
  assert.equal(connections.status().notes.connected, false);
});

test('a callback reloaded during sign-in does not fail it', async (t) => {
  const { make } = await fixture(t);
  const connections = make();
  connections.openBrowser = async (url) => {
    const back = (await fetch(url, { redirect: 'manual' })).headers.get('location');
    const answers = await Promise.all([fetch(back), fetch(back)]);
    assert.deepEqual(answers.map((r) => r.status).sort(), [200, 409]);
  };
  assert.equal((await connections.connect('notes')).notes.connected, true);
});
test('sign-in metadata must come from the app’s own server over HTTPS', async (t) => {
  const { app, make } = await fixture(t);
  const connections = make();
  connections.loopbackHttp = false;
  await assert.rejects(connections.connect('notes'), /must use HTTPS/);
  assert.equal(connections.status().notes.connecting, false);
  const elsewhere = make();
  elsewhere.fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (url !== app.url) return response;
    return new Response(null, {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://attacker.example/x"' },
    });
  };
  await assert.rejects(elsewhere.connect('notes'), /Unexpected sign-in configuration/);
});

test('the real apps are fixed, and only their read tools are allowed', () => {
  assert.equal(SOURCES.granola.url, 'https://mcp.granola.ai/mcp');
  assert.equal(SOURCES.notion.url, 'https://mcp.notion.com/mcp');
  for (const source of Object.values(SOURCES))
    for (const tool of source.tools)
      assert.match(tool, /(^|-|_)(list|get|search|fetch|query)/, `${tool} reads, never writes`);
});
