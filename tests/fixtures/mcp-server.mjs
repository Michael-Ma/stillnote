// A fake notes app for tests: an OAuth authorization server (discovery, dynamic registration,
// PKCE, rotating refresh tokens, revocation) and a Streamable HTTP MCP server on 127.0.0.1.
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

export async function fakeNotesApp({ tools = {}, accessLifetime = 3600 } = {}) {
  const log = [];
  const clients = new Map(),
    codes = new Map(),
    access = new Set(),
    refresh = new Set(),
    sessions = new Set();
  const app = { log, access, refresh, revoked: [], failRefresh: null, tools, accessLifetime };
  const issue = () => {
    const pair = { access_token: 'at-' + randomUUID(), refresh_token: 'rt-' + randomUUID() };
    access.add(pair.access_token);
    refresh.add(pair.refresh_token);
    return { ...pair, token_type: 'Bearer', expires_in: app.accessLifetime };
  };
  const body = (req) =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => resolve(data));
    });
  const json = (res, status, value, headers = {}) =>
    res
      .writeHead(status, { 'Content-Type': 'application/json', ...headers })
      .end(JSON.stringify(value));
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, app.origin);
    log.push(`${req.method} ${u.pathname}`);
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp')
      return json(res, 200, {
        resource: app.url,
        authorization_servers: [app.origin],
        scopes_supported: ['default'],
      });
    if (u.pathname === '/.well-known/oauth-authorization-server')
      return json(res, 200, {
        issuer: app.origin,
        authorization_endpoint: app.origin + '/authorize',
        token_endpoint: app.origin + '/token',
        registration_endpoint: app.origin + '/register',
        revocation_endpoint: app.origin + '/revoke',
        code_challenge_methods_supported: ['S256'],
      });
    if (u.pathname === '/register') {
      const request = JSON.parse(await body(req));
      const id = 'client-' + (clients.size + 1);
      clients.set(id, request);
      return json(res, 201, { client_id: id, ...request });
    }
    if (u.pathname === '/authorize') {
      const p = Object.fromEntries(u.searchParams);
      const client = clients.get(p.client_id);
      if (!client || !client.redirect_uris.includes(p.redirect_uri) || p.resource !== app.url)
        return res.writeHead(400).end('bad request');
      const code = 'code-' + randomUUID();
      codes.set(code, p);
      const back = new URL(p.redirect_uri);
      back.searchParams.set(app.deny ? 'error' : 'code', app.deny ? 'access_denied' : code);
      back.searchParams.set('state', app.wrongState ? 'not-the-state' : p.state);
      return res.writeHead(302, { Location: back.href }).end();
    }
    if (u.pathname === '/token') {
      const p = Object.fromEntries(new URLSearchParams(await body(req)));
      if (p.resource !== app.url) return json(res, 400, { error: 'invalid_target' });
      if (p.grant_type === 'authorization_code') {
        const grant = codes.get(p.code);
        codes.delete(p.code);
        const challenge = createHash('sha256')
          .update(p.code_verifier ?? '')
          .digest('base64url');
        if (
          !grant ||
          grant.client_id !== p.client_id ||
          grant.redirect_uri !== p.redirect_uri ||
          grant.code_challenge !== challenge
        )
          return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, issue());
      }
      if (p.grant_type === 'refresh_token') {
        if (app.failRefresh) return json(res, app.failRefresh.status, app.failRefresh.body);
        if (!refresh.delete(p.refresh_token)) return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, issue());
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (u.pathname === '/revoke') {
      app.revoked.push(Object.fromEntries(new URLSearchParams(await body(req))).token);
      return res.writeHead(200).end();
    }
    if (u.pathname === '/mcp' && req.method === 'POST') {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const message = JSON.parse(await body(req));
      if (!access.has(token))
        return res
          .writeHead(401, {
            'WWW-Authenticate': `Bearer resource_metadata="${app.origin}/.well-known/oauth-protected-resource/mcp"`,
          })
          .end();
      if (message.method === 'initialize') {
        const id = randomUUID();
        sessions.add(id);
        return json(
          res,
          200,
          {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'fake' },
            },
          },
          { 'Mcp-Session-Id': id },
        );
      }
      if (!sessions.has(req.headers['mcp-session-id'])) return res.writeHead(404).end();
      if (message.method === 'notifications/initialized') return res.writeHead(202).end();
      if (message.method === 'tools/list')
        return json(res, 200, {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: Object.keys(app.tools).map((name) => ({
              name,
              inputSchema: { type: 'object' },
            })),
          },
        });
      if (message.method === 'tools/call') {
        const tool = app.tools[message.params.name];
        log.push(`tool ${message.params.name} ${JSON.stringify(message.params.arguments)}`);
        const result = tool
          ? await tool(message.params.arguments)
          : { isError: true, content: [{ type: 'text', text: 'No such tool.' }] };
        const answer = { jsonrpc: '2.0', id: message.id, result };
        // Some answers come as an event stream, with a notification first.
        if (result.stream)
          return res
            .writeHead(200, { 'Content-Type': 'text/event-stream' })
            .end(
              `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n` +
                `event: message\ndata: ${JSON.stringify(answer)}\n\n`,
            );
        return json(res, 200, answer);
      }
      return json(res, 200, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Unknown method' },
      });
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  app.origin = `http://127.0.0.1:${server.address().port}`;
  app.url = app.origin + '/mcp';
  app.close = () => new Promise((resolve) => server.close(resolve));
  app.forgetSessions = () => sessions.clear();
  return app;
}
