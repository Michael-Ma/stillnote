// A small client for a remote MCP server over Streamable HTTP: JSON-RPC requests POSTed to one
// URL, answered as JSON or as a server-sent event stream. Only what importing needs: initialize,
// tools/list and tools/call. `token()` supplies the bearer token; a 401 is an AuthError, which
// the caller answers by refreshing the token once.
export class AuthError extends Error {}
const PROTOCOL = '2025-06-18';
const MAX_BYTES = 20_000_000;

// The JSON-RPC message answering request `id` in an event stream; other events (notifications,
// the server's own requests) are skipped.
async function fromStream(response, id) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '',
    total = 0;
  const answer = (event) => {
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return null;
    const message = JSON.parse(data);
    return message.id === id && ('result' in message || 'error' in message) ? message : null;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) throw new Error('The server’s answer is too large.');
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const message = answer(buffer.slice(0, at));
        buffer = buffer.slice(at + 2);
        if (message) return message;
      }
    }
    const message = answer(buffer);
    if (message) return message;
    throw new Error('The server ended its answer early.');
  } finally {
    reader.cancel().catch(() => {});
  }
}

// The text of a tool result: its text parts joined.
export const resultText = (result) =>
  (result?.content ?? [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');

export class McpSession {
  constructor(url, token, { fetch = globalThis.fetch, timeout = 90_000, version = '0' } = {}) {
    Object.assign(this, { url, token, fetch, timeout, version });
    this.next = 0;
  }
  async post(body) {
    const response = await this.fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${await this.token()}`,
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...(this.protocol ? { 'MCP-Protocol-Version': this.protocol } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });
    if (response.status === 401) throw new AuthError('Authorization expired.');
    return response;
  }
  async request(method, params) {
    const id = ++this.next;
    const response = await this.post({ jsonrpc: '2.0', id, method, params });
    // A server that forgot the session answers 404; the caller starts a new one.
    if (response.status === 404 && this.sessionId) {
      this.reset();
      throw new SessionExpired();
    }
    if (!response.ok) throw new Error(`The server answered ${response.status}.`);
    this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId;
    const message = (response.headers.get('content-type') ?? '').includes('text/event-stream')
      ? await fromStream(response, id)
      : await response.json();
    if (message.error) throw new Error(message.error.message || 'The server refused the request.');
    return message.result;
  }
  reset() {
    this.sessionId = undefined;
    this.protocol = undefined;
    this.ready = undefined;
  }
  connect() {
    return (this.ready ??= (async () => {
      try {
        const result = await this.request('initialize', {
          protocolVersion: PROTOCOL,
          capabilities: {},
          clientInfo: { name: 'Stillnote', version: this.version },
        });
        this.protocol = result?.protocolVersion ?? PROTOCOL;
        const response = await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
        await response.body?.cancel();
      } catch (error) {
        this.reset();
        throw error;
      }
    })());
  }
  // A request in a live session; a session the server forgot is started again once.
  async send(method, params) {
    for (let attempt = 0; ; attempt++) {
      await this.connect();
      try {
        return await this.request(method, params);
      } catch (error) {
        if (!(error instanceof SessionExpired) || attempt) throw error;
      }
    }
  }
  async listTools() {
    return (await this.send('tools/list', {}))?.tools ?? [];
  }
  async callTool(name, args = {}) {
    const result = await this.send('tools/call', { name, arguments: args });
    if (result?.isError) throw new Error(resultText(result) || `${name} failed.`);
    return result;
  }
}
class SessionExpired extends Error {}
