// Stillnote's own connections to the notes apps it imports from, through their official MCP
// servers. The servers are fixed, and only their read tools listed here are ever called.
//
// Sign-in follows the MCP authorization flow: the server names its authorization server
// (RFC 9728), whose metadata (RFC 8414) offers dynamic client registration (RFC 7591); Stillnote
// registers itself once with a loopback callback and signs in in the system browser with PKCE.
// Tokens are encrypted with the macOS-backed safeStorage and never reach the renderer.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { AuthError, McpSession } from './mcp-client.mjs';

export const SOURCES = {
  granola: {
    name: 'Granola',
    url: 'https://mcp.granola.ai/mcp',
    scope: 'openid email profile offline_access',
    tools: [
      'list_meetings',
      'get_meetings',
      'get_meeting_transcript',
      'list_meeting_folders',
      'get_account_info',
    ],
  },
  notion: {
    name: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    scope: 'default',
    tools: ['notion-search', 'notion-fetch', 'notion-query-meeting-notes', 'notion-get-self'],
  },
};
const secret = () => randomBytes(32).toString('base64url');
const same = (a, b) => {
  const x = Buffer.from(a ?? ''),
    y = Buffer.from(b ?? '');
  return x.length === y.length && timingSafeEqual(x, y);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class McpConnections {
  constructor({
    path,
    encryption,
    openBrowser,
    fetch = globalThis.fetch,
    sources = SOURCES,
    now = Date.now,
    spacing = 650,
    version = '0',
    loopbackHttp = false,
  }) {
    Object.assign(this, { path, encryption, openBrowser, fetch, sources, now, spacing, version });
    // Tests run their authorization server on 127.0.0.1 without TLS; real servers need HTTPS.
    this.loopbackHttp = loopbackHttp;
    this.saved = {};
    this.pending = {};
    this.refreshing = {};
    this.sessions = {};
    this.last = {};
  }
  source(id) {
    const source = Object.hasOwn(this.sources, id) && this.sources[id];
    if (!source) throw new Error('Unknown app.');
    return source;
  }
  load() {
    if (!existsSync(this.path)) return;
    if (!this.encryption.isEncryptionAvailable())
      throw new Error('macOS credential encryption is unavailable.');
    this.saved = JSON.parse(this.encryption.decryptString(readFileSync(this.path)));
  }
  save() {
    if (!this.encryption.isEncryptionAvailable())
      throw new Error('macOS credential encryption is unavailable.');
    writeFileSync(this.path + '.tmp', this.encryption.encryptString(JSON.stringify(this.saved)), {
      mode: 0o600,
    });
    renameSync(this.path + '.tmp', this.path);
  }
  status() {
    return Object.fromEntries(
      Object.entries(this.sources).map(([id, source]) => [
        id,
        { name: source.name, connected: !!this.saved[id]?.tokens, connecting: !!this.pending[id] },
      ]),
    );
  }
  secure(url) {
    const u = new URL(url);
    if (u.protocol === 'https:' || (this.loopbackHttp && u.hostname === '127.0.0.1')) return u.href;
    throw new Error('The sign-in server must use HTTPS.');
  }
  async json(url, init) {
    const response = await this.fetch(url, { signal: AbortSignal.timeout(20_000), ...init });
    if (!response.ok) throw new Error(`Sign-in setup failed (${response.status}).`);
    return response.json();
  }
  // The server's authorization server and its endpoints.
  async discover(source) {
    const probe = await this.fetch(source.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
      signal: AbortSignal.timeout(20_000),
    });
    await probe.body?.cancel();
    const named = /resource_metadata="([^"]+)"/.exec(probe.headers.get('www-authenticate') ?? '');
    const metadataUrl =
      named?.[1] ?? new URL('/.well-known/oauth-protected-resource', source.url).href;
    // The server describes itself, not some other site.
    if (new URL(metadataUrl).origin !== new URL(source.url).origin)
      throw new Error('Unexpected sign-in configuration.');
    const resource = await this.json(this.secure(metadataUrl));
    if (resource.resource && resource.resource !== source.url)
      throw new Error('Unexpected sign-in configuration.');
    const issuer = this.secure(resource.authorization_servers?.[0] ?? '').replace(/\/$/, '');
    const u = new URL(issuer);
    const server = await this.json(
      `${u.origin}/.well-known/oauth-authorization-server${u.pathname === '/' ? '' : u.pathname}`,
    );
    if (String(server.issuer).replace(/\/$/, '') !== issuer)
      throw new Error('Unexpected sign-in configuration.');
    if (server.code_challenge_methods_supported?.includes('S256') === false)
      throw new Error('This app’s sign-in does not support secure browser sign-in.');
    if (!server.registration_endpoint)
      throw new Error('This app’s sign-in does not accept new apps.');
    return {
      resource: resource.resource ?? source.url,
      authorization: this.secure(server.authorization_endpoint),
      token: this.secure(server.token_endpoint),
      registration: this.secure(server.registration_endpoint),
      ...(server.revocation_endpoint
        ? { revocation: this.secure(server.revocation_endpoint) }
        : {}),
    };
  }
  async register(endpoints, source, redirect) {
    const client = await this.json(endpoints.registration, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Stillnote',
        redirect_uris: [redirect],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: source.scope,
      }),
    });
    if (typeof client.client_id !== 'string' || !client.client_id)
      throw new Error('This app did not accept Stillnote’s registration.');
    return {
      id: client.client_id,
      ...(typeof client.client_secret === 'string' ? { secret: client.client_secret } : {}),
      redirect,
      registration: endpoints.registration,
    };
  }
  async token(id, form) {
    const { endpoints, client } = this.saved[id];
    const response = await this.fetch(endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        ...form,
        client_id: client.id,
        ...(client.secret ? { client_secret: client.secret } : {}),
        resource: endpoints.resource,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`${this.source(id).name} sign-in failed (${response.status}).`);
      error.grant = body.error;
      throw error;
    }
    if (typeof body.access_token !== 'string') throw new Error('Invalid sign-in response.');
    return body;
  }
  keep(id, t) {
    const saved = this.saved[id];
    saved.tokens = {
      access_token: t.access_token,
      ...((t.refresh_token ?? saved.tokens?.refresh_token)
        ? { refresh_token: t.refresh_token ?? saved.tokens.refresh_token }
        : {}),
    };
    saved.expiresAt = this.now() + (Number(t.expires_in) || 3600) * 1000;
    this.save();
  }
  // The callback server on the port the client was registered with, when that port is free.
  async listen(server, port) {
    for (const candidate of port ? [port, 0] : [0]) {
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(candidate, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
          });
        });
        return server.address().port;
      } catch (error) {
        if (error.code !== 'EADDRINUSE' || !candidate) throw error;
      }
    }
  }
  async connect(id) {
    const source = this.source(id);
    if (this.pending[id]) throw new Error(`Already connecting to ${source.name}.`);
    const state = secret(),
      verifier = secret();
    let server, timer, finish;
    const done = new Promise((resolve, reject) => {
      finish = (error, value) => {
        if (!this.pending[id]) return;
        clearTimeout(timer);
        server?.close();
        delete this.pending[id];
        error ? reject(error) : resolve(value);
      };
    });
    done.catch(() => {});
    this.pending[id] = () => finish(new Error('Sign-in cancelled.'));
    try {
      const endpoints = await this.discover(source);
      let redirect,
        consumed = false;
      server = createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (req.method !== 'GET' || u.pathname !== '/callback') return res.writeHead(404).end();
        if (!same(u.searchParams.get('state'), state))
          return res.writeHead(400).end('Invalid sign-in state.');
        // A reloaded callback must not spend the code twice and fail a sign-in in progress.
        if (consumed) return res.writeHead(409).end('Sign-in is already processing.');
        consumed = true;
        const page = (status, text) =>
          res
            .writeHead(status, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'Content-Security-Policy': "default-src 'none'",
            })
            .end(`<h1>${text}</h1><p>You can close this tab and return to Stillnote.</p>`);
        const code = u.searchParams.get('code');
        if (u.searchParams.has('error') || !code) {
          page(400, 'Sign-in was not completed');
          return finish(new Error(`${source.name} sign-in was declined.`));
        }
        this.token(id, {
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
        })
          .then((t) => {
            this.keep(id, t);
            delete this.sessions[id];
            page(200, `Connected ${source.name} to Stillnote`);
            finish(null, this.status());
          })
          .catch((error) => {
            page(400, 'Sign-in failed');
            finish(error);
          });
      });
      const previous = this.saved[id]?.client;
      const port = await this.listen(server, previous && Number(new URL(previous.redirect).port));
      redirect = `http://127.0.0.1:${port}/callback`;
      // One registration is kept and reused: registering again would orphan earlier grants.
      const client =
        previous?.redirect === redirect && previous.registration === endpoints.registration
          ? previous
          : await this.register(endpoints, source, redirect);
      this.saved[id] = { ...this.saved[id], endpoints, client };
      this.save();
      const url = new URL(endpoints.authorization);
      for (const [key, value] of Object.entries({
        response_type: 'code',
        client_id: client.id,
        redirect_uri: redirect,
        scope: source.scope,
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource: endpoints.resource,
      }))
        url.searchParams.set(key, value);
      timer = setTimeout(() => finish(new Error('Sign-in timed out. Please try again.')), 600_000);
      await this.openBrowser(url.href);
      return await done;
    } catch (error) {
      finish(error);
      throw error;
    }
  }
  cancel(id) {
    this.pending[id]?.();
  }
  async disconnect(id) {
    this.source(id);
    this.cancel(id);
    const saved = this.saved[id];
    const token = saved?.tokens?.refresh_token ?? saved?.tokens?.access_token;
    if (saved?.endpoints?.revocation && token)
      await this.fetch(saved.endpoints.revocation, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, client_id: saved.client.id }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    // The registration stays for the next sign-in; the grant does not.
    if (saved) {
      delete saved.tokens;
      delete saved.expiresAt;
      this.save();
    }
    delete this.sessions[id];
    return this.status();
  }
  async accessToken(id) {
    const saved = this.saved[id];
    if (!saved?.tokens) throw new Error(`Connect ${this.source(id).name} first.`);
    return saved.expiresAt - this.now() > 120_000 ? saved.tokens.access_token : this.refresh(id);
  }
  // One refresh at a time per app: a refresh token is rotated on use, and replaying an old one can
  // revoke the whole grant.
  refresh(id) {
    return (this.refreshing[id] ??= this.refreshNow(id).finally(() => delete this.refreshing[id]));
  }
  async refreshNow(id) {
    const name = this.source(id).name;
    const saved = this.saved[id];
    const forget = () => {
      delete saved.tokens;
      delete saved.expiresAt;
      delete this.sessions[id];
      this.save();
      return new Error(`Reconnect ${name} to keep importing.`);
    };
    if (!saved?.tokens) throw new Error(`Connect ${name} first.`);
    if (!saved.tokens.refresh_token) throw forget();
    try {
      this.keep(
        id,
        await this.token(id, {
          grant_type: 'refresh_token',
          refresh_token: saved.tokens.refresh_token,
        }),
      );
    } catch (error) {
      if (['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(error.grant))
        throw forget();
      throw error;
    }
    return saved.tokens.access_token;
  }
  session(id) {
    return (this.sessions[id] ??= new McpSession(this.source(id).url, () => this.accessToken(id), {
      fetch: this.fetch,
      version: this.version,
    }));
  }
  // Calls are spaced out to stay inside the apps' rate limits.
  async pace(id) {
    const wait = (this.last[id] ?? 0) + this.spacing - this.now();
    this.last[id] = this.now() + Math.max(0, wait);
    if (wait > 0) await sleep(wait);
  }
  // A request with a fresh token after a 401; refused twice means the grant is gone.
  async authorized(id, run) {
    try {
      return await run(this.session(id));
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
    }
    await this.refresh(id);
    try {
      return await run(this.session(id));
    } catch (error) {
      if (error instanceof AuthError)
        throw new Error(`Reconnect ${this.source(id).name} to keep importing.`);
      throw error;
    }
  }
  async tool(id, name, args = {}) {
    if (!this.source(id).tools.includes(name)) throw new Error('Stillnote does not use this tool.');
    await this.pace(id);
    return this.authorized(id, (session) => session.callTool(name, args));
  }
  async tools(id) {
    this.source(id);
    return this.authorized(id, (session) => session.listTools());
  }
}
