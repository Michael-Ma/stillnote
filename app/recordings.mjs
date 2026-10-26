import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const files = { microphone: 'microphone.wav', system: 'system.wav' };

export function recordingDirectory(dataDir, meetingId, recordingId) {
  if (
    typeof dataDir !== 'string' ||
    !dataDir ||
    typeof meetingId !== 'string' ||
    typeof recordingId !== 'string' ||
    !UUID.test(meetingId) ||
    !UUID.test(recordingId)
  )
    throw new Error('Invalid recording location.');
  return join(resolve(dataDir), 'recordings', meetingId, recordingId);
}

// Every recording of one meeting, in one folder.
export function meetingAudioDirectory(dataDir, meetingId) {
  if (typeof dataDir !== 'string' || !dataDir || !UUID.test(String(meetingId)))
    throw new Error('Invalid recording location.');
  return join(resolve(dataDir), 'recordings', meetingId);
}

// Bytes in a folder and below; links are not followed.
export function directorySize(dir) {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) total += directorySize(path);
      else if (entry.isFile()) total += lstatSync(path).size;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return total;
}

function readAt(fd, length, position) {
  const buffer = Buffer.alloc(length);
  return readSync(fd, buffer, 0, length, position) === length ? buffer : null;
}

// A valid trailing chunk sequence distinguishes metadata from PCM after a data chunk.
function hasTrailingChunks(fd, offset, size) {
  let count = 0;
  while (offset + 8 <= size && count++ < 1000) {
    const header = readAt(fd, 8, offset);
    if (!header || !/^[\x20-\x7e]{4}$/.test(header.toString('ascii', 0, 4))) return false;
    const bytes = header.readUInt32LE(4);
    offset += 8 + bytes + (bytes % 2);
    if (offset > size) return false;
  }
  return count > 0 && offset === size;
}

function inspectWav(filePath) {
  if (!lstatSync(filePath).isFile()) return null;
  const fd = openSync(filePath, 'r');
  try {
    const size = statSync(filePath).size;
    const header = readAt(fd, 12, 0);
    if (
      !header ||
      header.toString('ascii', 0, 4) !== 'RIFF' ||
      header.toString('ascii', 8, 12) !== 'WAVE'
    )
      return null;
    let offset = 12,
      format,
      dataOffset,
      advertisedBytes,
      count = 0;
    while (offset + 8 <= size && count++ < 10000) {
      const chunk = readAt(fd, 8, offset);
      if (!chunk) return null;
      const kind = chunk.toString('ascii', 0, 4),
        length = chunk.readUInt32LE(4);
      if (kind === 'fmt ') {
        if (length < 16 || offset + 8 + length > size) return null;
        const info = readAt(fd, Math.min(length, 40), offset + 8);
        let encoding = info.readUInt16LE(0);
        if (encoding === 0xfffe) {
          if (
            length < 40 ||
            info.readUInt16LE(16) < 22 ||
            info.subarray(28, 40).toString('hex') !== '00001000800000aa00389b71'
          )
            return null;
          encoding = info.readUInt32LE(24);
        }
        const channels = info.readUInt16LE(2),
          sampleRate = info.readUInt32LE(4),
          byteRate = info.readUInt32LE(8),
          blockAlign = info.readUInt16LE(12),
          bits = info.readUInt16LE(14);
        if (
          ![1, 3].includes(encoding) ||
          channels < 1 ||
          channels > 64 ||
          sampleRate < 1000 ||
          sampleRate > 768000 ||
          ![8, 16, 24, 32, 64].includes(bits) ||
          (encoding === 3 && ![32, 64].includes(bits)) ||
          blockAlign !== (channels * bits) / 8 ||
          byteRate !== sampleRate * blockAlign
        )
          return null;
        format = { channels, sampleRate, blockAlign };
      } else if (kind === 'data') {
        if (!format) return null;
        dataOffset = offset + 8;
        advertisedBytes = length;
        break;
      }
      offset += 8 + length + (length % 2);
    }
    if (!format || dataOffset === undefined) return null;
    const remaining = size - dataOffset;
    const declaredEnd = dataOffset + advertisedBytes + (advertisedBytes % 2);
    const pcmBytes =
      advertisedBytes <= remaining &&
      (declaredEnd === size || hasTrailingChunks(fd, declaredEnd, size))
        ? advertisedBytes
        : remaining;
    const frames = Math.floor(pcmBytes / format.blockAlign);
    if (!frames) return null;
    return {
      duration: frames / format.sampleRate,
      sampleRate: format.sampleRate,
      channels: format.channels,
      bytes: size,
    };
  } finally {
    closeSync(fd);
  }
}

export function inspectRecordingTracks(dir, advertisedTracks = []) {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return [];
  const tracks = [];
  for (const [source, fileName] of Object.entries(files)) {
    const filePath = join(dir, fileName);
    if (!existsSync(filePath)) continue;
    try {
      const info = inspectWav(filePath);
      if (!info) continue;
      const advertised = Array.isArray(advertisedTracks)
        ? advertisedTracks.find((track) => track.source === source)
        : null;
      const startOffset = Number(advertised?.startOffset);
      tracks.push({
        source,
        fileName,
        ...info,
        ...(Number.isFinite(startOffset) && startOffset >= 0 ? { startOffset } : {}),
      });
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  return tracks;
}

export function resolveRecordingTrack(dataDir, meetingId, recording, source) {
  if (!Object.hasOwn(files, source)) throw new Error('Unknown recording source.');
  const metadata = recording?.tracks?.find((track) => track.source === source);
  if (!metadata || metadata.fileName !== files[source])
    throw new Error('Recording track not found.');
  const root = realpathSync(dataDir);
  const dir = recordingDirectory(root, meetingId, recording.id);
  if (realpathSync(dir) !== dir) throw new Error('Unsafe recording location.');
  const filePath = join(dir, files[source]);
  const realFile = realpathSync(filePath);
  if (!realFile.startsWith(dir + sep) || realFile !== filePath || !lstatSync(filePath).isFile())
    throw new Error('Unsafe recording file.');
  return realFile;
}

export function repairRecordingTracks(dir) {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return [];
  for (const fileName of Object.values(files)) {
    const filePath = join(dir, fileName);
    if (!existsSync(filePath) || !lstatSync(filePath).isFile()) continue;
    const fd = openSync(filePath, 'r+');
    try {
      const header = readAt(fd, 44, 0),
        size = statSync(filePath).size;
      if (
        !header ||
        size > 0xffffffff ||
        header.toString('ascii', 0, 4) !== 'RIFF' ||
        header.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
        header.readUInt32LE(16) !== 16 ||
        header.readUInt16LE(20) !== 1 ||
        header.readUInt16LE(22) !== 1 ||
        header.readUInt32LE(24) !== 16000 ||
        header.readUInt32LE(28) !== 32000 ||
        header.readUInt16LE(32) !== 2 ||
        header.readUInt16LE(34) !== 16 ||
        header.toString('ascii', 36, 40) !== 'data'
      )
        continue;
      const audioBytes = Math.floor((size - 44) / 2) * 2;
      if (header.readUInt32LE(4) !== size - 8 || header.readUInt32LE(40) !== audioBytes) {
        const length = Buffer.alloc(4);
        length.writeUInt32LE(size - 8);
        writeSync(fd, length, 0, 4, 4);
        length.writeUInt32LE(audioBytes);
        writeSync(fd, length, 0, 4, 40);
      }
    } finally {
      closeSync(fd);
    }
  }
  return inspectRecordingTracks(dir);
}

export async function audioResponse(filePath, request) {
  const method = request?.method ?? 'GET';
  if (!['GET', 'HEAD'].includes(method))
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const file = await import('node:fs/promises').then(({ open }) => open(filePath, 'r'));
  let handedOff = false;
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Recording is not a regular file.');
    const size = info.size;
    const headers = new Headers({
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size),
      'Cache-Control': 'no-store',
    });
    let start = 0,
      end = size - 1,
      status = 200;
    // RFC 9110: HEAD ignores Range and describes the complete GET representation.
    const range = method === 'GET' ? request?.headers?.get?.('range') : null;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      let valid = !!match && !!(match[1] || match[2]);
      if (valid && !match[1]) {
        const suffix = Number(match[2]);
        valid = Number.isSafeInteger(suffix) && suffix > 0;
        start = Math.max(0, size - suffix);
      } else if (valid) {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
        valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end;
        end = Math.min(end, size - 1);
      }
      if (!valid || start >= size || size === 0) {
        headers.set('Content-Range', `bytes */${size}`);
        headers.set('Content-Length', '0');
        return new Response(null, { status: 416, headers });
      }
      status = 206;
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
      headers.set('Content-Length', String(end - start + 1));
    }
    if (method === 'HEAD' || size === 0) return new Response(null, { status, headers });
    const stream = file.createReadStream({ start, end, autoClose: true });
    handedOff = true;
    return new Response(Readable.toWeb(stream), { status, headers });
  } finally {
    if (!handedOff) await file.close();
  }
}

export function assessCoverage(segments, duration, sourceStats = {}) {
  const text = (Array.isArray(segments) ? segments : [])
    .map((segment) => (typeof segment.text === 'string' ? segment.text : ''))
    .join(' ')
    .trim();
  const transcriptCharacters = [...text.replace(/\s/g, '')].length;
  const transcriptWords = text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  const audioDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const lowCoverage =
    audioDuration >= 30 && transcriptCharacters < Math.max(20, audioDuration * 0.5);
  const reasons = lowCoverage
    ? [
        transcriptCharacters === 0
          ? 'No transcript text is available for this recording. Listen to the saved audio to review coverage.'
          : 'Very little transcript text is available for the recording length. Listen to the saved audio to check coverage before relying on enhanced notes.',
      ]
    : [];
  return {
    lowCoverage,
    transcriptWords,
    transcriptCharacters,
    audioDuration,
    reasons,
    sourceStats,
  };
}

export function contextHints(meeting, folderName = '') {
  const terms =
    (meeting.notes ?? '').match(
      /\p{Lu}[\p{L}\p{M}]{2,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,8}/gu,
    ) ?? [];
  const hints = [
    ...(meeting.title ?? '').split(/\s+/),
    ...(meeting.participants ?? '').split(/,|&| and /i),
    folderName,
    ...[...new Set(terms)].slice(0, 50),
  ];
  const seen = new Set();
  return hints
    .map((hint) => hint.trim().slice(0, 100))
    .filter((hint) => {
      const key = hint.toLowerCase();
      if (!hint || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 100);
}

// Persist every phrase, but send the latest complete meeting at most once per 250 ms.
export function meetingEvents(get, emit) {
  const pending = new Map();
  return {
    schedule(id) {
      if (pending.has(id)) return;
      pending.set(
        id,
        setTimeout(() => {
          pending.delete(id);
          emit({ type: 'meeting', meeting: get(id) });
        }, 250),
      );
    },
    flush(id, meeting = get(id)) {
      clearTimeout(pending.get(id));
      pending.delete(id);
      emit({ type: 'meeting', meeting });
    },
  };
}

export function helperRequests(send) {
  const pending = new Map();
  const replies = {
    devices: 'devices',
    languages: 'languages',
    'language-installed': 'install-language',
  };
  return {
    request(op, fields = {}, timeout = 10000) {
      // Asking again while the reply is on its way (Settings reopened) shares that reply.
      const current = pending.get(op);
      if (current)
        return current.locale === fields.locale
          ? current.promise
          : Promise.reject(new Error(`${op} is already in progress.`));
      let entry;
      const promise = new Promise((resolve, reject) => {
        const settle = (fn) => (value) => {
          clearTimeout(timer);
          pending.delete(op);
          fn(value);
        };
        const timer = setTimeout(
          () => pending.get(op)?.reject(new Error(`${op} timed out. Please try again.`)),
          timeout,
        );
        entry = { resolve: settle(resolve), reject: settle(reject), locale: fields.locale };
        pending.set(op, entry);
        try {
          send({ op, ...fields });
        } catch (error) {
          pending.get(op)?.reject(error);
        }
      });
      entry.promise = promise;
      return promise;
    },
    receive(event) {
      const op = event.type === 'error' ? event.op : replies[event.type];
      const wait = pending.get(op);
      if (!wait || (wait.locale && event.locale !== wait.locale)) return false;
      if (event.type === 'error') wait.reject(new Error(event.message));
      else wait.resolve(event);
      return true;
    },
    reject(error) {
      for (const wait of pending.values()) wait.reject(error);
    },
  };
}
