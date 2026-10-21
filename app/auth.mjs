// Independent implementation of OpenAI's documented public OAuth protocol.
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { consumeResponse } from './stream.mjs';
const ISSUER = 'https://auth.openai.com',
  RESOURCE = 'https://api.openai.com/v1';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const secret = () => randomBytes(32).toString('base64url');
function same(a, b) {
  const x = Buffer.from(a ?? ''),
    y = Buffer.from(b ?? '');
  return x.length === y.length && timingSafeEqual(x, y);
}
export class ChatGPT {
  constructor(dir, encryption, openBrowser) {
    this.dir = dir;
    this.encryption = encryption;
    this.openBrowser = openBrowser;
    this.profiles = [];
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, 'accounts.enc');
    this.hostPath = join(dir, 'host.json');
    if (existsSync(this.hostPath)) this.host = JSON.parse(readFileSync(this.hostPath, 'utf8')).id;
    else {
      this.host = 'urn:uuid:' + randomUUID();
      writeFileSync(this.hostPath, JSON.stringify({ id: this.host }), { mode: 0o600 });
    }
  }
  load() {
    if (existsSync(this.path)) {
      if (!this.encryption.isEncryptionAvailable())
        throw new Error('macOS credential encryption is unavailable.');
      const saved = JSON.parse(this.encryption.decryptString(readFileSync(this.path)));
      this.profiles = saved.profiles;
      this.active = saved.active;
    }
  }
  save() {
    if (!this.encryption.isEncryptionAvailable())
      throw new Error('macOS credential encryption is unavailable.');
    writeFileSync(
      this.path + '.tmp',
      this.encryption.encryptString(
        JSON.stringify({ profiles: this.profiles, active: this.active }),
      ),
      { mode: 0o600 },
    );
    renameSync(this.path + '.tmp', this.path);
  }
  current() {
    return this.profiles.find((p) => p.id === this.active);
  }
  status() {
    const p = this.current();
    return {
      connected: !!p?.tokens,
      sharing: !!p?.tokens && p.scopes?.includes('chatgpt.tokens.use.direct'),
      email: p?.email,
      active: this.active,
      profiles: this.profiles.map((p) => ({
        id: p.id,
        email: p.email,
        label: p.label,
        connected: !!p.tokens,
      })),
    };
  }
  select(id) {
    if (this.pending || this.refreshing)
      throw new Error('Finish the current account operation first.');
    if (!this.profiles.some((p) => p.id === id)) throw new Error('Account not found.');
    this.active = id;
    this.save();
    return this.status();
  }
  async metadata() {
    if (!this.discovery) {
      const r = await fetch(ISSUER + '/.well-known/openid-configuration', {
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error('Could not load ChatGPT sign-in configuration.');
      const d = await r.json();
      if (d.issuer !== ISSUER || new URL(d.jwks_uri).origin !== ISSUER)
        throw new Error('Invalid sign-in configuration.');
      this.discovery = d;
      this.jwks = createRemoteJWKSet(new URL(d.jwks_uri));
    }
    return this.discovery;
  }
  async token(form) {
    const r = await fetch(ISSUER + '/api/accounts/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...form, resource: RESOURCE }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok)
      throw new Error(`ChatGPT authorization failed (${r.status}). Please reconnect your account.`);
    const t = await r.json();
    if (typeof t.access_token !== 'string' || !Number.isFinite(Number(t.expires_in)))
      throw new Error('Invalid authorization response.');
    return t;
  }
  async validate(t, clientId, nonce, subject) {
    await this.metadata();
    if (!t.id_token) throw new Error('Missing account identity. Please reconnect.');
    const { payload } = await jwtVerify(t.id_token, this.jwks, {
      issuer: ISSUER,
      algorithms: ['RS256'],
      audience: clientId,
    });
    if (nonce && !same(payload.nonce, nonce))
      throw new Error('Sign-in identity did not match this attempt.');
    if (!payload.sub || (subject && payload.sub !== subject))
      throw new Error('This sign-in belongs to a different account.');
    return payload;
  }
  async signIn(newProfile = false) {
    if (this.pending || this.refreshing)
      throw new Error('An account operation is already in progress.');
    const existing = newProfile
      ? undefined
      : (this.current() ?? this.profiles.find((p) => !p.subject));
    const state = secret(),
      nonce = secret(),
      verifier = secret();
    let server, timer;
    let settled = false;
    let finish;
    const result = new Promise((resolve, reject) => {
      finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server?.close();
        this.pending = undefined;
        error ? reject(error) : resolve(value);
      };
    });
    // Attach a rejection handler immediately; opening the browser may fail before awaiting result.
    result.catch(() => {});
    this.pending = () => finish(new Error('Sign-in cancelled.'));
    try {
      let consumed = false;
      server = createServer((req, res) => {
        void (async () => {
          const u = new URL(req.url, 'http://127.0.0.1');
          if (req.method !== 'GET' || u.pathname !== '/auth/callback') {
            res.writeHead(404).end();
            return;
          }
          if (!same(u.searchParams.get('state'), state)) {
            res.writeHead(400).end('Invalid sign-in state.');
            return;
          }
          if (consumed) {
            res.writeHead(409).end('Sign-in is already processing.');
            return;
          }
          consumed = true;
          try {
            if (u.searchParams.has('error')) throw new Error('ChatGPT sign-in was declined.');
            const clientId = u.searchParams.get('client_id') ?? existing?.clientId;
            if (
              !clientId ||
              clientId === 'dynamic_agent_client' ||
              (existing && clientId !== existing.clientId)
            )
              throw new Error('Incomplete account registration.');
            const code = u.searchParams.get('code');
            if (!code) throw new Error('Missing authorization code.');
            let p = existing;
            if (!p) {
              p = { id: randomUUID(), clientId, label: `Account ${this.profiles.length + 1}` };
              this.profiles.push(p);
            }
            this.save();
            const t = await this.token({
              grant_type: 'authorization_code',
              client_id: clientId,
              code,
              code_verifier: verifier,
              redirect_uri: redirect,
            });
            const identity = await this.validate(t, clientId, nonce, p.subject);
            if (settled) {
              res.writeHead(400).end('Sign-in expired. Return to Stillnote and retry.');
              return;
            }
            Object.assign(p, {
              subject: identity.sub,
              email: identity.email,
              scopes: (t.scope ?? '').split(' '),
              tokens: t,
              expiresAt: Date.now() + Number(t.expires_in) * 1000,
            });
            delete p.pendingRotation;
            this.active = p.id;
            this.save();
            res
              .writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'Content-Security-Policy': "default-src 'none'",
              })
              .end(
                '<h1>Connected to Stillnote</h1><p>You can close this tab and return to the app.</p>',
              );
            finish(null, this.status());
          } catch (e) {
            res
              .writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
              .end('Sign-in failed. Return to Stillnote to retry.');
            finish(e);
          }
        })().catch((e) => finish(e));
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const redirect = `http://127.0.0.1:${server.address().port}/auth/callback`;
      const url = new URL(ISSUER + '/api/accounts/authorize');
      for (const [k, v] of Object.entries({
        client_id: existing?.clientId ?? 'dynamic_agent_client',
        ext_agent_host_id: this.host,
        response_type: 'code',
        redirect_uri: redirect,
        scope: scopes,
        resource: RESOURCE,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      }))
        url.searchParams.set(k, v);
      if (!existing) url.searchParams.set('agent_name_hint', 'Stillnote');
      else {
        if (existing.tokens?.id_token)
          url.searchParams.set('id_token_hint', existing.tokens.id_token);
        if (existing.email) url.searchParams.set('login_hint', existing.email);
      }
      timer = setTimeout(() => finish(new Error('Sign-in timed out. Please try again.')), 600000);
      await this.openBrowser(url.href);
      return await result;
    } catch (e) {
      finish(e);
      throw e;
    }
  }
  cancel() {
    this.pending?.();
  }
  async access() {
    if (this.pending) throw new Error('Finish signing in first.');
    const p = this.current();
    if (!p?.tokens) throw new Error('Connect your ChatGPT account in Settings.');
    if (!p.scopes?.includes('chatgpt.tokens.use.direct'))
      throw new Error(
        'ChatGPT plan usage is not enabled for this connection. Reconnect and enable it in ChatGPT.',
      );
    if (p.expiresAt < Date.now() + 60000 || p.pendingRotation) {
      if (!this.refreshing)
        this.refreshing = (async () => {
          if (!p.tokens.refresh_token && !p.pendingRotation)
            throw new Error('Your session expired. Reconnect in Settings.');
          // Checkpoint a rotated refresh token before identity verification, so transient JWKS failures do not lose it.
          const t =
            p.pendingRotation ??
            (await this.token({
              grant_type: 'refresh_token',
              client_id: p.clientId,
              refresh_token: p.tokens.refresh_token,
            }));
          if (!p.pendingRotation) {
            p.pendingRotation = { ...t, receivedAt: Date.now() };
            this.save();
          }
          if (t.id_token) await this.validate(t, p.clientId, undefined, p.subject);
          p.tokens = { ...p.tokens, ...t };
          p.expiresAt = p.pendingRotation.receivedAt + Number(t.expires_in) * 1000;
          if (t.scope) p.scopes = t.scope.split(' ');
          delete p.pendingRotation;
          this.save();
        })().finally(() => {
          this.refreshing = undefined;
        });
      await this.refreshing;
    }
    if (!p.scopes.includes('chatgpt.tokens.use.direct'))
      throw new Error('ChatGPT plan usage was disabled.');
    return p.tokens.access_token;
  }
  async request(path, options = {}) {
    const profile = this.current();
    let token = await this.access();
    const request = () =>
      fetch(RESOURCE + path, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${token}` },
      });
    let response = await request();
    if (response.status === 401) {
      await response.body?.cancel();
      options.signal?.throwIfAborted();
      if (this.current() !== profile) throw new Error('ChatGPT account changed. Please retry.');
      // Another request may already have refreshed this rejected token.
      if (profile.tokens.access_token === token) profile.expiresAt = 0;
      token = await this.access();
      options.signal?.throwIfAborted();
      response = await request();
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw new Error(
        'ChatGPT authorization failed (401) after refreshing. Reconnect your account in Settings.',
      );
    }
    return response;
  }
  async models() {
    const r = await this.request('/models', { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`Could not load ChatGPT models (${r.status}).`);
    const d = await r.json();
    return (d.models ?? [])
      .filter((m) => m.visibility === 'list')
      .map((m) => ({ id: m.slug, name: m.display_name ?? m.slug }));
  }
  async respond({ model, input, instructions, onDelta, signal }) {
    const r = await this.request('/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input, instructions, store: false, stream: true }),
      signal,
    });
    if (!r.ok)
      throw new Error(
        r.status === 429
          ? 'ChatGPT plan usage limit reached. Open Manage usage in Settings.'
          : `ChatGPT request failed (${r.status}). Check your connection and selected model.`,
      );
    return consumeResponse(r.body, onDelta);
  }
  async disconnect() {
    this.cancel();
    if (this.refreshing) await this.refreshing.catch(() => {});
    const p = this.current();
    if (!p) return this.status();
    let revoked = true;
    try {
      if (p.tokens?.refresh_token) {
        const d = await this.metadata();
        if (new URL(d.revocation_endpoint).origin !== ISSUER) throw new Error();
        const r = await fetch(d.revocation_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: p.tokens.refresh_token,
            token_type_hint: 'refresh_token',
            client_id: p.clientId,
          }),
          signal: AbortSignal.timeout(15000),
        });
        revoked = r.ok;
      }
    } catch {
      revoked = false;
    }
    delete p.tokens;
    delete p.pendingRotation;
    p.scopes = [];
    this.save();
    return {
      ...this.status(),
      warning: revoked
        ? null
        : 'Signed out locally. Remote revocation was not confirmed; disconnect Stillnote in ChatGPT settings.',
    };
  }
}
