// Explicitly injected by the un-packaged app only in NODE_ENV=test. Never contacts
// an account, microphone, calendar, speech service, or network endpoint.
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  statSync,
  appendFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { consumeResponse } from '../../app/stream.mjs';
import { claudeModels } from '../../app/providers/claude-code.mjs';

export function wav(seconds = 2, frequency = 440) {
  const rate = 16000;
  const samples = Math.round(rate * seconds);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++)
    buffer.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * frequency * index) / rate) * 1200),
      44 + index * 2,
    );
  return buffer;
}

function responseChunks(mode, text) {
  const delta = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\r\n\r\n`;
  const complete = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
  let raw;
  if (mode === 'failed')
    raw =
      'data: {"type":"response.failed","response":{"error":{"message":"Fixture usage limit. Retry this request."}}}\n\n';
  else if (mode === 'empty') raw = complete;
  else if (mode === 'partial') raw = delta;
  else raw = delta + complete;
  // Split SSE framing and UTF-8 bytes as a regression against transport chunks.
  const bytes = Buffer.from(raw);
  return [bytes.subarray(0, 13), bytes.subarray(13, 61), bytes.subarray(61)];
}

export function createTestAdapter({ dataDir }) {
  if (process.env.NODE_ENV !== 'test' || dataDir !== process.env.STILLNOTE_DATA_DIR)
    throw new Error('The fixture adapter requires an explicit isolated test data directory.');
  writeFileSync(join(dataDir, 'adapter-ready.json'), JSON.stringify({ synthetic: true, dataDir }));
  const scenario = JSON.parse(readFileSync(process.env.STILLNOTE_E2E_SCENARIO_FILE, 'utf8'));
  const log = (event) =>
    appendFileSync(join(dataDir, 'adapter-events.jsonl'), JSON.stringify(event) + '\n');
  const counterPath = join(dataDir, 'fixture-counters.json');
  const counters = existsSync(counterPath)
    ? JSON.parse(readFileSync(counterPath, 'utf8'))
    : { session: 0, response: 0 };
  const next = (kind) => {
    const value = counters[kind]++;
    writeFileSync(counterPath, JSON.stringify(counters));
    return value;
  };
  return {
    createAuth() {
      writeFileSync(join(dataDir, 'adapter-auth-ready.json'), JSON.stringify({ synthetic: true }));
      let connected = scenario.connected !== false;
      const status = () => ({
        connected,
        sharing: connected,
        email: connected ? 'fixture@example.invalid' : undefined,
        active: connected ? 'fixture' : undefined,
        profiles: connected
          ? [{ id: 'fixture', email: 'fixture@example.invalid', connected: true }]
          : [],
      });
      return {
        load() {},
        status,
        cancel() {},
        async signIn() {
          connected = true;
          return status();
        },
        select() {
          return status();
        },
        disconnect() {
          connected = false;
          return status();
        },
        async models() {
          if (!connected) throw new Error('Connect your ChatGPT account in Settings to use AI.');
          return [{ id: 'fixture-model', name: 'Fixture model' }];
        },
        async respond({ input, onDelta, signal }) {
          const item = scenario.responses?.[next('response')] ?? { mode: 'success' };
          log({ type: 'ai-request', mode: item.mode, input });
          if (item.mode === 'wait-for-cancel') {
            onDelta('Unfinished fixture response');
            await new Promise((_, reject) => {
              if (signal.aborted) reject(signal.reason);
              else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          }
          const chunks = responseChunks(
            item.mode,
            item.text ?? 'Alex will ship the revised onboarding flow on Friday. [1]',
          );
          const body = (async function* () {
            for (const chunk of chunks) {
              signal.throwIfAborted();
              yield chunk;
            }
          })();
          return consumeResponse(body, onDelta);
        },
      };
    },
    // Never runs the developer's own Claude Code. scenario.claude overrides the status.
    createClaude() {
      const fixture = {
        id: 'claude',
        label: 'Claude',
        installed: false,
        checking: false,
        path: null,
        version: null,
        loggedIn: false,
        authMethod: null,
        subscriptionType: null,
        email: null,
        ready: false,
        billing: null,
        usage: null,
        signingIn: false,
        loginUrl: null,
        error: null,
        ...scenario.claude,
      };
      const status = () => ({ ...fixture });
      return {
        load() {},
        refresh: async () => status(),
        setPath: async () => status(),
        status,
        cancel() {},
        disconnect: status,
        async signIn() {
          throw new Error('Fixture Claude sign-in is unavailable.');
        },
        models: async () => claudeModels,
        async respond() {
          log({ type: 'claude-request' });
          throw new Error('Fixture Claude responses are not configured.');
        },
      };
    },
    createNative() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const emit = (value) => {
        log(value);
        child.stdout.write(JSON.stringify(value) + '\n');
      };
      let active;
      let installed = ['en-US'];
      let input = '';
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          input += chunk.toString();
          let newline;
          while ((newline = input.indexOf('\n')) !== -1) {
            const command = JSON.parse(input.slice(0, newline));
            input = input.slice(newline + 1);
            log({ type: 'native-command', ...command });
            // Real helper output arrives asynchronously after record IPC returns.
            setImmediate(() => handle(command));
          }
          callback();
        },
        final(callback) {
          setImmediate(() => child.emit('close', 0));
          callback();
        },
      });
      child.kill = () => child.emit('close', 0);
      function handle(command) {
        if (command.op === 'start') {
          const fixture = scenario.sessions?.[next('session')] ?? { mode: 'normal' };
          if (fixture.mode === 'start-error') {
            emit({ type: 'error', message: 'Fixture microphone permission denied.' });
            return;
          }
          active = {
            ...command,
            fixture,
            systemAudio: command.systemAudio && fixture.mode !== 'system-unavailable',
          };
          emit({
            type: 'started',
            systemAudio: active.systemAudio,
            engine: 'speechTranscriber',
            echoCancellation: command.echoCancellation !== 'off',
            sources: {
              microphone: {
                status: 'recording',
                device: { uid: command.inputDevice ?? 'fixture-mic', name: 'Fixture microphone' },
              },
              system: {
                status: active.systemAudio
                  ? 'recording'
                  : command.systemAudio
                    ? 'unavailable'
                    : 'disabled',
              },
            },
          });
          emit({ type: 'audio-level', source: 'microphone', rms: 0.1, peak: 0.2, seconds: 2 });
          if (fixture.mode === 'normal') {
            emit({
              type: 'segment',
              speaker: 'You',
              source: 'microphone',
              text: fixture.text ?? 'Alex will ship the revised onboarding flow on Friday.',
              timestamp: 0,
            });
            if (command.systemAudio)
              emit({
                type: 'segment',
                speaker: 'Meeting audio',
                source: 'system',
                text: 'Sam confirms the acceptance criteria.',
                timestamp: 0.5,
              });
          }
          if (fixture.mode === 'partial') {
            emit({ type: 'partial', speaker: 'You', text: 'A partially recognized', timestamp: 0 });
            emit({
              type: 'partial',
              speaker: 'You',
              text: 'A partially recognized sentence survives stop.',
              timestamp: 0,
            });
          }
          if (fixture.mode === 'recognition-error')
            emit({
              type: 'warning',
              message: 'Fixture speech recognition unavailable. Raw audio continues recording.',
            });
          if (fixture.mode === 'system-unavailable')
            emit({
              type: 'warning',
              message: 'Fixture meeting audio unavailable. Microphone capture continues.',
            });
        }
        if (command.op === 'start' && active)
          for (const event of active.fixture.events ?? [])
            emit({ ...event, recordingId: command.recordingId });
        if (command.op === 'stop') {
          if (!active) {
            emit({ type: 'stopped', duration: 0 });
            return;
          }
          const duration = active.fixture.duration ?? 2;
          mkdirSync(active.audioDir, { recursive: true });
          const tracks = (active.systemAudio ? ['microphone', 'system'] : ['microphone']).map(
            (source) => {
              const fileName = source + '.wav';
              const path = join(active.audioDir, fileName);
              writeFileSync(path, wav(duration, source === 'system' ? 660 : 440));
              return {
                source,
                fileName,
                duration,
                sampleRate: 16000,
                channels: 1,
                bytes: statSync(path).size,
              };
            },
          );
          active = undefined;
          emit({ type: 'stopped', duration, audio: { tracks, diagnostics: { fixture: true } } });
        }
        if (command.op === 'transcribe') {
          const segments = [
            {
              source: 'microphone',
              speaker: 'You',
              text: 'Recovered complete fixture sentence from saved audio.',
              timestamp: 0,
            },
          ];
          emit({ type: 'retranscription-completed', recordingId: command.recordingId, segments });
        }
        if (command.op === 'devices')
          emit({
            type: 'devices',
            inputs: [
              {
                uid: 'fixture-mic',
                name: 'Fixture microphone',
                isDefault: true,
                transport: 'built-in',
              },
            ],
          });
        if (command.op === 'languages')
          emit({
            type: 'languages',
            engine: 'speechTranscriber',
            supported: ['en-US', 'zh-CN', 'yue-CN'],
            installed,
          });
        if (command.op === 'install-language') {
          if (!['en-US', 'zh-CN', 'yue-CN'].includes(command.locale))
            emit({
              type: 'error',
              op: 'install-language',
              locale: command.locale,
              message: 'Unsupported fixture language.',
            });
          else {
            installed = [...new Set([...installed, command.locale])];
            emit({ type: 'language-progress', locale: command.locale, fraction: 1 });
            emit({ type: 'language-installed', locale: command.locale, installed });
          }
        }
        if (command.op === 'calendar') emit({ type: 'calendar', events: [] });
      }
      return child;
    },
  };
}
