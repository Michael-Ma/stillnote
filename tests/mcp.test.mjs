import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../app/store.mjs';

test('real MCP transport shares app search normalization and excludes Trash before limiting', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-mcp-'));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.create({ title: '项目进展 React 架构', notes: '老板说 "ship it" on Friday.' });
  store.create({ title: '日本語テスト', notes: '会議の計画' });
  store.create({ title: '한국어 프로젝트', notes: '회의 계획' });
  for (let i = 0; i < 55; i++) store.create({ title: `Limit row ${i}` });
  const trash = store.create({ title: '项目进展 React newest' });
  store.update(trash.id, { deletedAt: true });
  const queries = [
    '项目',
    '项目 React',
    '日本語',
    'テスト',
    '프로젝트',
    '계획',
    'React',
    '"ship it"',
    '!!!',
    '',
    'Limit',
  ];
  const input =
    queries
      .map((query, id) =>
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: 'search_meetings',
            arguments: { query, limit: 100 },
          },
        }),
      )
      .join('\n') +
    '\n' +
    JSON.stringify({
      jsonrpc: '2.0',
      id: 100,
      method: 'tools/call',
      params: {
        name: 'search_meetings',
        arguments: { query: '', limit: 1 },
      },
    }) +
    '\n';
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../scripts/mcp.mjs', import.meta.url))],
    {
      input,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, STILLNOTE_DATA_DIR: dir },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const replies = child.stdout.trim().split('\n').map(JSON.parse);
  for (const [id, query] of queries.entries()) {
    const response = replies.find((reply) => reply.id === id).result;
    assert.ok(!response.isError, JSON.stringify(response));
    const actual = JSON.parse(response.content[0].text).map((m) => m.id);
    const expected = store.search(query).map((m) => m.id);
    assert.ok(
      actual.every((id) => expected.includes(id)),
      query,
    );
    if (expected.length <= 50) assert.deepEqual(new Set(actual), new Set(expected), query);
    assert.ok(actual.length <= 50);
    assert.ok(!actual.includes(trash.id));
  }
  assert.equal(JSON.parse(replies.find((r) => r.id === 100).result.content[0].text).length, 1);
  assert.equal(JSON.parse(replies.find((r) => r.id === 10).result.content[0].text).length, 50);
});
