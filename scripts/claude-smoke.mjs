// Opt-in live check: one tiny request through the Claude Code CLI on this Mac.
// Uses the developer's own Claude plan; never run in CI.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCode } from '../app/providers/claude-code.mjs';
const workDir = mkdtempSync(join(tmpdir(), 'stillnote-claude-smoke-'));
try {
  const claude = new ClaudeCode({ workDir });
  const status = await claude.refresh();
  console.log(JSON.stringify({ ...status, email: status.email ? '<redacted>' : null }));
  if (!status.ready) throw new Error(status.error ?? 'Claude is not signed in with a Claude plan.');
  const started = Date.now();
  process.stdout.write('Streaming: ');
  const text = await claude.respond({
    model: 'haiku',
    instructions: 'You are a careful meeting assistant. Use only the supplied notes.',
    input: [
      { role: 'developer', content: 'SOURCE [1]\nAlex will send the revised flow on Friday.' },
      { role: 'user', content: 'Who sends the revised flow, and when? One sentence, cite [1].' },
    ],
    onDelta: (delta) => process.stdout.write(delta),
  });
  const usage = claude.status().usage;
  console.log(
    `\n${JSON.stringify({ claudeCLI: 'passed', ms: Date.now() - started, chars: text.length, usage })}`,
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
