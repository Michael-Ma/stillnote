import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const templates = [
  {
    id: 'general',
    name: 'Meeting notes',
    prompt:
      'Create a concise overview, key discussion points, decisions, action items with owners and dates only when stated, and open questions.',
  },
  {
    id: 'one-on-one',
    name: '1:1',
    prompt:
      'Organize into check-in, progress, feedback, blockers, career development, and commitments. Preserve nuance and attribution.',
  },
  {
    id: 'customer',
    name: 'Customer discovery',
    prompt:
      'Organize customer context, existing workflow, pain points, direct quotes, objections, buying signals, and next steps. Separate facts from hypotheses.',
  },
  {
    id: 'standup',
    name: 'Team standup',
    prompt:
      'Group updates by speaker where known, completed work, next steps, blockers, and decisions.',
  },
  {
    id: 'interview',
    name: 'Interview',
    prompt:
      'Summarize the questions, candidate evidence, strengths, concerns, and unanswered questions. Do not infer protected characteristics or invent evaluations.',
  },
];
export const recipes = [
  {
    id: 'follow-up',
    name: 'Draft a follow-up',
    prompt: 'Draft a concise follow-up email with decisions and next steps. Do not send anything.',
  },
  {
    id: 'actions',
    name: 'Find action items',
    prompt:
      'List commitments, their stated owners and deadlines, and cite their source meetings. Mark unspecified owners or dates as unspecified.',
  },
  {
    id: 'brief',
    name: 'Prepare a brief',
    prompt:
      'Prepare a brief for my next conversation based on these meetings: previous decisions, unfinished commitments, important context, and questions to ask.',
  },
  {
    id: 'themes',
    name: 'Find common themes',
    prompt:
      'Identify recurring themes across the selected meetings, with supporting meeting citations. Separate strong patterns from isolated comments.',
  },
];
const text = (value, max = 2_000_000) => {
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid text value.');
  return value;
};
export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, 'notebook.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meetings(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, scope TEXT NOT NULL, data TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS meeting_search USING fts5(id UNINDEXED, title, content, tokenize='unicode61');`);
  }
  all(includeTrash = false) {
    return this.db
      .prepare('SELECT data FROM meetings')
      .all()
      .map((x) => ({ recordings: [], transcriptVersions: [], ...JSON.parse(x.data) }))
      .filter((m) => includeTrash || !m.deletedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  get(id) {
    const r = this.db.prepare('SELECT data FROM meetings WHERE id=?').get(id);
    if (!r) throw new Error('Meeting not found.');
    return { recordings: [], transcriptVersions: [], ...JSON.parse(r.data) };
  }
  create(input = {}) {
    const now = new Date().toISOString();
    const m = {
      id: randomUUID(),
      title: text(input.title ?? 'Untitled meeting', 300),
      createdAt: now,
      updatedAt: now,
      notes: '',
      summary: '',
      transcript: [],
      folderId: null,
      templateId: 'general',
      participants: '',
      starred: false,
      deletedAt: null,
      duration: 0,
      versions: [],
      recordings: [],
      transcriptVersions: [],
      ...Object.fromEntries(
        ['notes', 'participants']
          .filter((k) => typeof input[k] === 'string')
          .map((k) => [k, text(input[k])]),
      ),
    };
    return this.write(m);
  }
  write(m) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR REPLACE INTO meetings VALUES(?,?)').run(m.id, JSON.stringify(m));
      this.db.prepare('DELETE FROM meeting_search WHERE id=?').run(m.id);
      if (!m.deletedAt)
        this.db
          .prepare('INSERT INTO meeting_search(id,title,content) VALUES(?,?,?)')
          .run(m.id, m.title, [m.notes, m.summary, ...m.transcript.map((s) => s.text)].join('\n'));
      this.db.exec('COMMIT');
      return m;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  update(id, patch) {
    const m = this.get(id);
    for (const k of ['title', 'notes', 'summary', 'participants', 'templateId'])
      if (k in patch) m[k] = text(patch[k], k === 'title' ? 300 : 2_000_000);
    if ('folderId' in patch) {
      if (patch.folderId !== null && !this.folders().some((f) => f.id === patch.folderId))
        throw new Error('Folder not found.');
      m.folderId = patch.folderId;
    }
    if ('starred' in patch) m.starred = Boolean(patch.starred);
    if ('duration' in patch) {
      if (!Number.isFinite(patch.duration) || patch.duration < 0)
        throw new Error('Invalid duration.');
      m.duration = patch.duration;
    }
    if ('deletedAt' in patch) m.deletedAt = patch.deletedAt ? new Date().toISOString() : null;
    if ('summary' in patch && m.summary !== this.get(id).summary) {
      const old = this.get(id).summary;
      if (old) m.versions = [{ text: old, at: m.updatedAt }, ...m.versions].slice(0, 20);
    }
    m.updatedAt = new Date().toISOString();
    return this.write(m);
  }
  append(id, segment) {
    const m = this.get(id);
    if (segment.segmentId && segment.recordingId) {
      const existing = m.transcript.findIndex(
        (s) => s.segmentId === segment.segmentId && s.recordingId === segment.recordingId,
      );
      if (existing >= 0) m.transcript.splice(existing, 1);
    }
    const s = {
      id: randomUUID(),
      text: text(segment.text),
      speaker: text(segment.speaker ?? 'Speaker', 100),
      timestamp: Number(segment.timestamp) || 0,
      ...(segment.recordingId ? { recordingId: text(segment.recordingId, 100) } : {}),
      ...(segment.segmentId ? { segmentId: text(segment.segmentId, 200) } : {}),
      ...(['microphone', 'system'].includes(segment.source) ? { source: segment.source } : {}),
    };
    m.transcript.push(s);
    m.transcript.sort((a, b) => a.timestamp - b.timestamp);
    m.updatedAt = new Date().toISOString();
    return this.write(m);
  }
  beginRecording(id, input = {}) {
    const m = this.get(id);
    m.recordings.push({
      id: input.id ?? randomUUID(),
      startedAt: input.startedAt ?? new Date().toISOString(),
      locale: input.locale ?? 'en-US',
      baseDuration: m.duration,
      duration: 0,
      status: 'starting',
      tracks: [],
      diagnostics: {},
    });
    m.updatedAt = new Date().toISOString();
    return this.write(m);
  }
  finishRecording(id, recordingId, patch) {
    const m = this.get(id);
    const session = m.recordings.find((r) => r.id === recordingId);
    if (!session) throw new Error('Recording not found.');
    for (const key of ['status', 'tracks', 'diagnostics', 'sources'])
      if (key in patch) session[key] = patch[key];
    if ('duration' in patch) {
      if (!Number.isFinite(patch.duration) || patch.duration < 0)
        throw new Error('Invalid recording duration.');
      session.duration = patch.duration;
      m.duration = Math.max(m.duration, session.baseDuration + patch.duration);
    }
    m.updatedAt = new Date().toISOString();
    return this.write(m);
  }
  replaceRecordingTranscript(id, recordingId, segments, diagnostics) {
    const m = this.get(id),
      session = m.recordings.find((r) => r.id === recordingId);
    if (!session) throw new Error('Recording not found.');
    const replacement = segments
      .filter((segment) => typeof segment.text === 'string' && segment.text.trim())
      .map((segment) => ({
        id: randomUUID(),
        recordingId,
        ...(segment.segmentId ? { segmentId: text(segment.segmentId, 200) } : {}),
        ...(['microphone', 'system'].includes(segment.source) ? { source: segment.source } : {}),
        text: text(segment.text),
        speaker: text(segment.speaker ?? 'Speaker', 100),
        timestamp: session.baseDuration + Math.max(0, Number(segment.timestamp) || 0),
      }));
    if (!replacement.length)
      throw new Error('No transcript text was recovered. The existing transcript was preserved.');
    m.transcriptVersions = [
      {
        recordingId,
        at: new Date().toISOString(),
        segments: m.transcript.filter((segment) => segment.recordingId === recordingId),
      },
      ...m.transcriptVersions,
    ].slice(0, 20);
    m.transcript = [
      ...m.transcript.filter((segment) => segment.recordingId !== recordingId),
      ...replacement,
    ].sort((a, b) => a.timestamp - b.timestamp);
    session.diagnostics = diagnostics;
    session.lastTranscribedAt = new Date().toISOString();
    m.updatedAt = new Date().toISOString();
    return this.write(m);
  }
  editSegment(id, segmentId, patch) {
    const m = this.get(id);
    const i = m.transcript.findIndex((s) => s.id === segmentId);
    if (i < 0) throw new Error('Transcript segment not found.');
    if (patch.remove) m.transcript.splice(i, 1);
    else {
      if ('text' in patch) m.transcript[i].text = text(patch.text);
      if ('speaker' in patch) m.transcript[i].speaker = text(patch.speaker, 100);
    }
    m.updatedAt = new Date().toISOString();
    return this.write(m);
  }
  search(query) {
    const terms = text(query, 1000).trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return this.all();
    const match = terms.map((t) => '"' + t.replaceAll('"', '""') + '"*').join(' AND ');
    const ids = this.db
      .prepare('SELECT id FROM meeting_search WHERE meeting_search MATCH ? ORDER BY rank LIMIT 100')
      .all(match);
    // unicode61 keeps many CJK phrases together; supplement token search with literal substrings.
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(query)) {
      const known = new Set(ids.map((row) => row.id));
      for (const m of this.all()) {
        const haystack = [m.title, m.notes, m.summary, ...m.transcript.map((s) => s.text)].join(
          '\n',
        );
        if (!known.has(m.id) && terms.every((term) => haystack.includes(term)))
          ids.push({ id: m.id });
        if (ids.length >= 100) break;
      }
    }
    return ids.map((x) => this.get(x.id));
  }
  folders() {
    return this.db.prepare('SELECT * FROM folders ORDER BY name').all();
  }
  addFolder(name) {
    const f = { id: randomUUID(), name: text(name, 100).trim() };
    if (!f.name) throw new Error('Name your folder.');
    this.db.prepare('INSERT INTO folders VALUES(?,?)').run(f.id, f.name);
    return f;
  }
  settings() {
    return Object.fromEntries(
      this.db
        .prepare('SELECT * FROM settings')
        .all()
        .map((r) => [r.key, JSON.parse(r.data)]),
    );
  }
  setting(key, value) {
    validateSetting(key, value);
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, JSON.stringify(value));
    return this.settings();
  }
  messages(scope) {
    return this.db
      .prepare('SELECT data FROM messages WHERE scope=? ORDER BY rowid')
      .all(scope)
      .map((r) => JSON.parse(r.data));
  }
  message(scope, role, content, sources = []) {
    const m = { id: randomUUID(), role, content, createdAt: new Date().toISOString(), sources };
    this.db.prepare('INSERT INTO messages VALUES(?,?,?)').run(m.id, scope, JSON.stringify(m));
    return m;
  }
  backup() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      audioIncluded: false,
      meetings: this.all(true).map((m) => ({
        ...m,
        recordings: m.recordings.map(({ id, startedAt, duration, status }) => ({
          id,
          startedAt,
          duration,
          status,
          audioIncluded: false,
        })),
      })),
      folders: this.folders(),
      settings: this.settings(),
      messages: this.db
        .prepare('SELECT scope,data FROM messages')
        .all()
        .map((r) => ({ scope: r.scope, ...JSON.parse(r.data) })),
    };
  }
  restore(input) {
    if (input?.version !== 1 || !Array.isArray(input.meetings) || input.meetings.length > 10000)
      throw new Error('Not a Stillnote backup.');
    // Validate the entire import before a single mutation; credentials are never part of backups.
    const meetings = input.meetings.map((m) => {
      if (
        !m ||
        typeof m.id !== 'string' ||
        !Array.isArray(m.transcript) ||
        !Array.isArray(m.versions) ||
        !Number.isFinite(Date.parse(m.createdAt)) ||
        !Number.isFinite(Date.parse(m.updatedAt))
      )
        throw new Error('Invalid meeting in backup.');
      for (const k of ['title', 'notes', 'summary', 'participants', 'templateId']) text(m[k]);
      text(m.id, 100);
      text(m.title, 300);
      if (!Number.isFinite(m.duration) || m.duration < 0 || typeof m.starred !== 'boolean')
        throw new Error('Invalid meeting metadata.');
      if (m.folderId !== null) text(m.folderId, 100);
      if (m.deletedAt !== null && !Number.isFinite(Date.parse(m.deletedAt)))
        throw new Error('Invalid deletion date.');
      for (const version of m.versions) {
        text(version.text);
        if (!Number.isFinite(Date.parse(version.at))) throw new Error('Invalid summary version.');
      }
      for (const s of m.transcript) {
        text(s.id, 100);
        text(s.text);
        text(s.speaker, 100);
        if (!Number.isFinite(s.timestamp)) throw new Error('Invalid timestamp.');
      }
      // Imported metadata must never grant access to recordings already on this Mac.
      return {
        ...Object.fromEntries(
          [
            'id',
            'title',
            'notes',
            'summary',
            'participants',
            'templateId',
            'createdAt',
            'updatedAt',
            'duration',
            'starred',
            'folderId',
            'deletedAt',
            'versions',
          ].map((key) => [key, m[key]]),
        ),
        transcript: m.transcript.map(({ id, text, speaker, timestamp }) => ({
          id,
          text,
          speaker,
          timestamp,
        })),
        recordings: [],
        transcriptVersions: [],
      };
    });
    const folders = (input.folders ?? []).map((f) => ({
      id: text(f.id, 100),
      name: text(f.name, 100),
    }));
    const messages = (input.messages ?? []).map((m) => {
      text(m.id, 100);
      text(m.scope, 1000);
      text(m.content);
      if (!['user', 'assistant'].includes(m.role)) throw new Error('Invalid message.');
      if (!Array.isArray(m.sources)) throw new Error('Invalid message sources.');
      for (const source of m.sources) {
        text(source.id, 100);
        text(source.title, 300);
        if (!Number.isInteger(source.number) || source.number < 1)
          throw new Error('Invalid source number.');
      }
      return m;
    });
    const settings = Object.entries(input.settings ?? {}).map(([key, value]) => {
      validateSetting(key, value);
      return [key, value];
    });
    const additions = meetings.filter(
      (m) => !this.db.prepare('SELECT id FROM meetings WHERE id=?').get(m.id),
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const f of folders)
        this.db.prepare('INSERT OR IGNORE INTO folders VALUES(?,?)').run(f.id, f.name);
      for (const m of additions) {
        this.db.prepare('INSERT INTO meetings VALUES(?,?)').run(m.id, JSON.stringify(m));
        if (!m.deletedAt)
          this.db
            .prepare('INSERT INTO meeting_search VALUES(?,?,?)')
            .run(
              m.id,
              m.title,
              [m.notes, m.summary, ...m.transcript.map((s) => s.text)].join('\n'),
            );
      }
      for (const m of messages) {
        const { scope, ...data } = m;
        this.db
          .prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?)')
          .run(m.id, scope, JSON.stringify(data));
      }
      for (const [key, value] of settings)
        this.db
          .prepare('INSERT OR IGNORE INTO settings VALUES(?,?)')
          .run(key, JSON.stringify(value));
      this.db.exec('COMMIT');
      return additions.length;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
function validateSetting(key, value) {
  if (['model', 'claudeModel', 'locale'].includes(key)) text(value, 300);
  else if (key === 'provider') {
    if (!['chatgpt', 'claude'].includes(value)) throw new Error('Invalid AI provider.');
  } else if (key === 'claudePath') {
    if (value !== null && !(typeof value === 'string' && /^\/.{1,999}$/s.test(value)))
      throw new Error('Invalid Claude Code path.');
  } else if (['systemAudio', 'autoEnhance'].includes(key)) {
    if (typeof value !== 'boolean') throw new Error('Invalid preference.');
  } else if (['templates', 'recipes'].includes(key)) {
    if (!Array.isArray(value)) throw new Error('Invalid templates or recipes.');
    for (const item of value) {
      text(item.id, 100);
      text(item.name, 100);
      text(item.prompt, 10000);
    }
  } else throw new Error('Unknown setting.');
  if (JSON.stringify(value).length > 100000) throw new Error('Setting too large.');
}
export function markdown(m) {
  return `# ${m.title}\n\n${m.createdAt}\n${m.participants ? `\nParticipants: ${m.participants}\n` : ''}\n## My notes\n\n${m.notes}\n\n## Enhanced notes\n\n${m.summary}\n\n## Transcript\n\n${m.transcript.map((s) => `[${Math.floor(s.timestamp / 60)}:${String(Math.floor(s.timestamp % 60)).padStart(2, '0')}] ${s.speaker}: ${s.text}`).join('\n\n')}\n`;
}
export function context(meetings) {
  let used = 0;
  return meetings
    .map((m, i) => {
      const body = JSON.stringify({
        title: m.title,
        date: m.createdAt,
        notes: m.notes,
        summary: m.summary,
        transcript: m.transcript.map((s) => ({
          speaker: s.speaker,
          time: s.timestamp,
          text: s.text,
        })),
      });
      used += body.length;
      if (used > 350000)
        throw new Error('This selection is too large. Choose fewer meetings or a smaller folder.');
      return `SOURCE [${i + 1}] meeting_id=${m.id}\n${body}`;
    })
    .join('\n\n');
}
