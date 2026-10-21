// Stand-in for the `claude` CLI. FAKE_CLAUDE_MODE picks the print-mode behavior,
// FAKE_CLAUDE_AUTH the sign-in state, FAKE_CLAUDE_LOGIN the login outcome.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const env = process.env;
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const delta = (text) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
});
const result = (text, extra = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: text,
  ...extra,
});
const limit = (status) => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status,
    resetsAt: 1792706400,
    rateLimitType: 'seven_day',
    utilization: status === 'rejected' ? 1 : 0.4,
    unifiedWindows: {
      five_hour: { utilization: 0.03, resetsAt: 1792564200 },
      seven_day: { utilization: status === 'rejected' ? 1 : 0.4, resetsAt: 1792706400 },
    },
  },
});
async function stdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}
function log(extra) {
  if (env.FAKE_CLAUDE_LOG)
    appendFileSync(
      env.FAKE_CLAUDE_LOG,
      JSON.stringify({
        args,
        cwd: process.cwd(),
        apiKey: 'ANTHROPIC_API_KEY' in env,
        authToken: 'ANTHROPIC_AUTH_TOKEN' in env,
        ...extra,
      }) + '\n',
    );
}

if (args[0] === '--version') {
  log({});
  console.log('2.1.299 (Claude Code)');
} else if (args[0] === 'auth' && args[1] === 'status') {
  log({});
  if (env.FAKE_CLAUDE_STATUS_DELAY)
    await new Promise((resolve) => setTimeout(resolve, Number(env.FAKE_CLAUDE_STATUS_DELAY)));
  const auth = env.FAKE_CLAUDE_AUTH ?? 'subscription';
  if (auth === 'logged-out') {
    out({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' });
    process.exitCode = 1;
  } else
    out({
      loggedIn: true,
      authMethod: auth === 'api_key' ? 'api_key' : 'claude.ai',
      apiProvider: 'firstParty',
      email: 'fixture@example.invalid',
      subscriptionType: auth === 'api_key' ? null : 'max',
    });
} else if (args[0] === 'auth' && args[1] === 'login') {
  log({});
  const mode = env.FAKE_CLAUDE_LOGIN ?? 'success';
  console.log('Opening https://claude.ai/oauth/authorize?fixture=1 in your browser…');
  if (mode === 'success') setTimeout(() => {}, 30);
  else if (mode === 'fail') process.exitCode = 1;
  else setInterval(() => {}, 1000);
} else if (args[0] === '-p') {
  const prompt = await stdin();
  log({ prompt });
  const mode = env.FAKE_CLAUDE_MODE ?? 'success';
  if (mode === 'unknown-option') {
    process.stderr.write("error: unknown option '--safe-mode'\n");
    process.exit(1);
  }
  out({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] });
  if (mode === 'success') {
    // Split a line and a multibyte character across writes.
    const first = JSON.stringify(delta('会议 ✅ ')) + '\n' + JSON.stringify(delta('Alex ships'));
    const bytes = Buffer.from(first);
    const cut = bytes.indexOf(Buffer.from('✅')) + 1;
    process.stdout.write(bytes.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 20));
    process.stdout.write(bytes.subarray(cut));
    await new Promise((r) => setTimeout(r, 20));
    process.stdout.write('\n');
    out(limit('allowed'));
    out(result('会议 ✅ Alex ships'));
  } else if (mode === 'not-logged-in') {
    out(result('Not logged in · Please run /login', { is_error: true }));
    process.exitCode = 1;
  } else if (mode === 'limit') {
    out(limit('rejected'));
    out(result("You've hit your weekly limit · resets Oct 24, 5am", { is_error: true }));
    process.exitCode = 1;
  } else if (mode === 'empty') out(result(''));
  else if (mode === 'crash') {
    out(delta('Half an answer'));
    process.stderr.write('boom\n');
    process.exit(1);
  } else if (mode === 'cut') out(delta('Half an answer'));
  else if (mode === 'slow') {
    out(delta('Thinking'));
    setInterval(() => {}, 1000);
  }
} else {
  process.stderr.write(`error: unknown command ${args.join(' ')}\n`);
  process.exitCode = 1;
}
