import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, SignJWT } from 'jose';
import { ChatGPT } from '../app/auth.mjs';
// Test-only reversible adapter. Production uses Electron safeStorage backed by macOS Keychain.
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s),
  decryptString: (b) => b.toString(),
};
async function fixture(t, openBrowser = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-auth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const auth = new ChatGPT(dir, encryption, openBrowser);
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  auth.metadata = async () => {
    auth.jwks = publicKey;
    return {};
  };
  const token = async (nonce, subject = 'user-test', client = 'oaiapp_test') =>
    new SignJWT({ nonce, email: 'test@example.invalid' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://auth.openai.com')
      .setSubject(subject)
      .setAudience(client)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  return { auth, dir, token };
}
test('ID token verification rejects wrong nonce, audience and account identity', async (t) => {
  const { auth, token } = await fixture(t);
  const good = await token('nonce');
  assert.equal((await auth.validate({ id_token: good }, 'oaiapp_test', 'nonce')).sub, 'user-test');
  await assert.rejects(auth.validate({ id_token: good }, 'oaiapp_test', 'wrong'), /did not match/);
  await assert.rejects(auth.validate({ id_token: good }, 'wrong', 'nonce'));
  await assert.rejects(
    auth.validate({ id_token: good }, 'oaiapp_test', 'nonce', 'other-user'),
    /different account/,
  );
});
test('OAuth uses PKCE, validates state, saves issued client and exposes no credentials', async (t) => {
  const { auth, token } = await fixture(t);
  let request;
  auth.token = async (form) => {
    assert.equal(form.client_id, 'oaiapp_test');
    assert.equal(form.code, 'code-test');
    assert.ok(form.code_verifier.length > 40);
    return {
      access_token: 'access-test',
      refresh_token: 'refresh-test',
      id_token: await token(request.searchParams.get('nonce')),
      scope: 'openid chatgpt.tokens.use.direct',
      expires_in: 3600,
    };
  };
  auth.openBrowser = async (url) => {
    request = new URL(url);
    assert.equal(request.origin, 'https://auth.openai.com');
    assert.equal(request.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.equal(request.searchParams.get('code_challenge_method'), 'S256');
    assert.match(request.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
    const cb = new URL(request.searchParams.get('redirect_uri'));
    cb.searchParams.set('state', 'invalid');
    assert.equal((await fetch(cb)).status, 400);
    cb.searchParams.set('state', request.searchParams.get('state'));
    cb.searchParams.set('code', 'code-test');
    cb.searchParams.set('client_id', 'oaiapp_test');
    assert.equal((await fetch(cb)).status, 200);
  };
  const status = await auth.signIn();
  assert.equal(status.sharing, true);
  assert.equal(status.email, 'test@example.invalid');
  assert.ok(!JSON.stringify(status).includes('access-test'));
  assert.equal(auth.current().clientId, 'oaiapp_test');
  const reopened = new ChatGPT(auth.dir, encryption, () => {});
  reopened.load();
  assert.equal(reopened.status().sharing, true);
  assert.equal(reopened.host, auth.host);
});
test('failed exchange preserves registration and retry reuses the issued client', async (t) => {
  const { auth } = await fixture(t);
  auth.token = async () => {
    throw new Error('exchange unavailable');
  };
  const clients = [];
  auth.openBrowser = async (url) => {
    const request = new URL(url);
    clients.push(request.searchParams.get('client_id'));
    const cb = new URL(request.searchParams.get('redirect_uri'));
    cb.searchParams.set('state', request.searchParams.get('state'));
    cb.searchParams.set('code', 'code-test');
    cb.searchParams.set('client_id', 'oaiapp_test');
    await fetch(cb);
  };
  await assert.rejects(auth.signIn(), /exchange unavailable/);
  await assert.rejects(auth.signIn(), /exchange unavailable/);
  assert.deepEqual(clients, ['dynamic_agent_client', 'oaiapp_test']);
  assert.equal(auth.profiles.length, 1);
  assert.equal(auth.status().connected, false);
});
test('identity-only connection cannot perform inference', async (t) => {
  const { auth } = await fixture(t);
  auth.profiles = [
    {
      id: 'test',
      clientId: 'oaiapp_test',
      scopes: ['openid'],
      tokens: { access_token: 'test' },
      expiresAt: Date.now() + 100000,
    },
  ];
  auth.active = 'test';
  assert.equal(auth.status().sharing, false);
  await assert.rejects(auth.access(), /not enabled/);
});
test('token rotation is serialized and checkpointed before validation', async (t) => {
  const { auth, token } = await fixture(t);
  const profile = {
    id: 'test',
    clientId: 'oaiapp_test',
    subject: 'user-test',
    scopes: ['chatgpt.tokens.use.direct'],
    tokens: { access_token: 'old', refresh_token: 'old-refresh' },
    expiresAt: 0,
  };
  auth.profiles = [profile];
  auth.active = 'test';
  let calls = 0;
  auth.token = async () => {
    calls++;
    return {
      access_token: 'new',
      refresh_token: 'rotated',
      id_token: await token(undefined),
      scope: 'chatgpt.tokens.use.direct',
      expires_in: 3600,
    };
  };
  const verify = auth.validate.bind(auth);
  let fail = true;
  auth.validate = async (...a) => {
    if (fail) throw new Error('temporary verification outage');
    return verify(...a);
  };
  await assert.rejects(auth.access(), /temporary/);
  assert.equal(profile.pendingRotation.refresh_token, 'rotated');
  assert.equal(profile.tokens.refresh_token, 'old-refresh');
  fail = false;
  const values = await Promise.all([auth.access(), auth.access()]);
  assert.deepEqual(values, ['new', 'new']);
  assert.equal(calls, 1);
  assert.equal(profile.tokens.refresh_token, 'rotated');
  assert.equal(profile.pendingRotation, undefined);
});

test('ID token verification pins RS256', async (t) => {
  const { auth } = await fixture(t);
  const { publicKey, privateKey } = await generateKeyPair('PS256');
  auth.metadata = async () => {
    auth.jwks = publicKey;
  };
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'PS256' })
    .setIssuer('https://auth.openai.com')
    .setSubject('user-test')
    .setAudience('test')
    .setExpirationTime('1h')
    .sign(privateKey);
  await assert.rejects(auth.validate({ id_token: token }, 'test'), /alg.*not allowed/);
});
for (const operation of ['models', 'respond']) {
  test(`ChatGPT ${operation} refreshes on 401 once and retries with the new token`, async (t) => {
    const { auth } = await fixture(t);
    auth.profiles = [
      {
        id: 'test',
        clientId: 'test',
        tokens: { access_token: 'old', refresh_token: 'refresh' },
        scopes: ['chatgpt.tokens.use.direct'],
        expiresAt: Date.now() + 3600000,
      },
    ];
    auth.active = 'test';
    let refreshes = 0;
    auth.token = async () => {
      refreshes++;
      return { access_token: 'new', refresh_token: 'rotated', expires_in: 3600 };
    };
    const headers = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      headers.push(options.headers.Authorization);
      if (headers.length === 1) return new Response('', { status: 401 });
      return operation === 'models'
        ? Response.json({ models: [{ slug: 'test-model', visibility: 'list' }] })
        : new Response(
            'data: {"type":"response.output_text.delta","delta":"Answer"}\n\ndata: {"type":"response.completed"}\n\n',
          );
    });
    const result =
      operation === 'models'
        ? await auth.models()
        : await auth.respond({ model: 'test-model', input: 'Question' });
    assert.deepEqual(headers, ['Bearer old', 'Bearer new']);
    assert.equal(refreshes, 1);
    assert.equal(
      operation === 'models' ? result[0].id : result,
      operation === 'models' ? 'test-model' : 'Answer',
    );
  });
  test(`ChatGPT ${operation} reports repeated 401 accurately without looping`, async (t) => {
    const { auth } = await fixture(t);
    auth.profiles = [
      {
        id: 'test',
        clientId: 'test',
        tokens: { access_token: 'old', refresh_token: 'refresh' },
        scopes: ['chatgpt.tokens.use.direct'],
        expiresAt: Date.now() + 3600000,
      },
    ];
    auth.active = 'test';
    let requests = 0,
      refreshes = 0;
    auth.token = async () => {
      refreshes++;
      return { access_token: 'new', expires_in: 3600 };
    };
    t.mock.method(globalThis, 'fetch', async () => {
      requests++;
      return new Response('', { status: 401 });
    });
    await assert.rejects(
      operation === 'models' ? auth.models() : auth.respond({ input: 'Question' }),
      /401.*after refreshing.*Reconnect/,
    );
    assert.equal(requests, 2);
    assert.equal(refreshes, 1);
  });
}
