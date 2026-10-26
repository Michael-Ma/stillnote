import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startableServices } from './calls.mjs';

// Each template states the meeting's purpose, then its sections, as Granola's template guide
// suggests; enhance.mjs supplies the shared writing rules.
export const templates = [
  {
    id: 'general',
    name: 'Meeting notes',
    prompt:
      'Any meeting. Use topic sections in the order they came up, then Next steps. Pull decisions out as their own bullets so they are easy to find.',
  },
  {
    id: 'one-on-one',
    name: '1:1',
    prompt:
      'A recurring one-on-one. Sections: How things are going (only what was shared); Updates; Feedback, in both directions, keeping nuance and who gave it; Blockers and support needed; Growth (only if discussed); Next steps. Keep personal matters brief and neutral.',
  },
  {
    id: 'customer',
    name: 'Customer discovery',
    prompt:
      'A conversation to learn about a customer’s problem; focus on what they said, not on what I said. Sections: About them (company, role, team, current tools); Current workflow; Pain points, with impact, frequency, numbers and short exact quotes; What they have tried; Reactions to our product, including objections; Buying process (budget, decision makers, timeline) only as stated; Next steps. Mark my own interpretations “Hypothesis:” so they stay apart from what the customer said.',
  },
  {
    id: 'standup',
    name: 'Team standup',
    prompt:
      'A team standup. One section per person when names are clear, each with done, next and blocked bullets; otherwise one section per work item. Then Blockers that need help and Decisions. Be extremely brief.',
  },
  {
    id: 'interview',
    name: 'Interview',
    prompt:
      'A job interview where I am the interviewer. Sections: Background; Questions and answers, each question as a bullet with the evidence from the answer nested under it; Strengths; Concerns; Follow-up questions. Record evidence, not verdicts: no recommendation or score unless my notes give one. Never infer or mention age, gender, ethnicity, religion, health, family status or other protected characteristics.',
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
const portableSettings = new Set([
  'model',
  'claudeModel',
  'locale',
  'autoLocales',
  'uiLanguage',
  'echoCancellation',
  'systemAudio',
  'autoEnhance',
  'meetingReminders',
  'reminderAutoRecord',
  'meetingDetection',
  'openOnMeetingDetected',
  'callService',
  'templates',
  'recipes',
]);
export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, 'notebook.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meetings(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, scope TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_scope ON messages(scope);
      CREATE TABLE IF NOT EXISTS transcript_versions(id INTEGER PRIMARY KEY, meeting_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS transcript_versions_meeting ON transcript_versions(meeting_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS meeting_search USING fts5(id UNINDEXED, title, content, tokenize='unicode61');`);
    // Old indexes used unrelated FTS rowids. Rebuild once, atomically, from durable meetings.
    if (this.db.prepare('PRAGMA user_version').get().user_version < 1) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec('DELETE FROM meeting_search');
        for (const m of this.all(true)) this.index(m);
        this.db.exec('PRAGMA user_version=1; COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    // Earlier transcript versions move out of the meeting, which every new line rewrites; the
    // search index is rebuilt with CJK characters as separate tokens.
    if (this.db.prepare('PRAGMA user_version').get().user_version < 2) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of this.db.prepare('SELECT id, data FROM meetings').all()) {
          const stored = JSON.parse(row.data);
          if (!('transcriptVersions' in stored)) continue;
          const { transcriptVersions = [], ...m } = stored;
          for (const version of [...transcriptVersions].reverse())
            this.db
              .prepare('INSERT INTO transcript_versions(meeting_id, data) VALUES(?,?)')
              .run(row.id, JSON.stringify(version));
          this.db.prepare('UPDATE meetings SET data=? WHERE id=?').run(JSON.stringify(m), row.id);
        }
        this.db.exec('DELETE FROM meeting_search');
        for (const m of this.all(true)) this.index(m);
        this.db.exec('PRAGMA user_version=2; COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    // Recordings learn whether an earlier transcript can be restored.
    if (this.db.prepare('PRAGMA user_version').get().user_version < 3) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const latest = new Map();
        for (const row of this.db
          .prepare('SELECT meeting_id, data FROM transcript_versions ORDER BY id')
          .all()) {
          const { recordingId, at } = JSON.parse(row.data);
          latest.set(`${row.meeting_id}/${recordingId}`, at);
        }
        for (const row of this.db.prepare('SELECT id, data FROM meetings').all()) {
          const m = JSON.parse(row.data);
          let changed = false;
          for (const session of m.recordings ?? []) {
            const at = latest.get(`${row.id}/${session.id}`);
            if (at) {
              session.previousAt = at;
              changed = true;
            }
          }
          if (changed)
            this.db.prepare('UPDATE meetings SET data=? WHERE id=?').run(JSON.stringify(m), row.id);
        }
        this.db.exec('PRAGMA user_version=3; COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }
  all(includeTrash = false) {
    return this.db
      .prepare('SELECT data FROM meetings')
      .all()
      .map((x) => ({ recordings: [], ...JSON.parse(x.data) }))
      .filter((m) => includeTrash || !m.deletedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  get(id) {
    const r = this.db.prepare('SELECT data FROM meetings WHERE id=?').get(id);
    if (!r) throw new Error('Meeting not found.');
    return { recordings: [], ...JSON.parse(r.data) };
  }
  // A recording's earlier transcripts, newest first (each Retry keeps the one it replaced).
  transcriptVersions(id) {
    return this.db
      .prepare('SELECT data FROM transcript_versions WHERE meeting_id=? ORDER BY id DESC')
      .all(id)
      .map((row) => JSON.parse(row.data));
  }
  create(input = {}, transcript = []) {
    const now = new Date().toISOString();
    const m = {
      id: randomUUID(),
      title: text(input.title ?? 'Untitled meeting', 300),
      createdAt: now,
      updatedAt: now,
      notes: '',
      summary: '',
      transcript,
      folderId: null,
      templateId: 'general',
      participants: '',
      starred: false,
      deletedAt: null,
      duration: 0,
      versions: [],
      recordings: [],
      ...Object.fromEntries(
        ['notes', 'participants']
          .filter((k) => typeof input[k] === 'string')
          .map((k) => [k, text(input[k])]),
      ),
      // The calendar occurrence this note belongs to (see app/reminders.mjs eventKey).
      ...(typeof input.eventKey === 'string' ? { eventKey: text(input.eventKey, 1100) } : {}),
    };
    return this.write(m);
  }
  index(m) {
    const { rowid } = this.db.prepare('SELECT rowid FROM meetings WHERE id=?').get(m.id);
    this.db.prepare('DELETE FROM meeting_search WHERE rowid=?').run(rowid);
    if (!m.deletedAt)
      this.db
        .prepare('INSERT INTO meeting_search(rowid,id,title,content) VALUES(?,?,?,?)')
        .run(
          rowid,
          m.id,
          searchable(m.title),
          searchable([m.notes, m.summary, ...m.transcript.map((s) => s.text)].join('\n')),
        );
  }
  // `alongside` runs in the same transaction (rows that belong with this write).
  write(m, alongside = () => {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'INSERT INTO meetings VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        )
        .run(m.id, JSON.stringify(m));
      this.index(m);
      alongside();
      this.db.exec('COMMIT');
      return m;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  update(id, patch, { summarySource = 'edited' } = {}) {
    const m = this.get(id);
    const previous = {
      text: m.summary,
      at: m.summaryAt ?? m.updatedAt,
      source: m.summarySource ?? 'ai',
    };
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
    if (
      'summary' in patch &&
      (m.summary !== previous.text || patch.snapshotSummary === true || summarySource === 'ai')
    ) {
      if (
        previous.text &&
        (summarySource === 'ai' || patch.snapshotSummary === true || previous.source === 'ai')
      )
        m.versions = [{ text: previous.text, at: previous.at }, ...m.versions].slice(0, 20);
      m.summarySource = summarySource;
      m.summaryAt = new Date().toISOString();
    }
    m.updatedAt = new Date().toISOString();
    return this.write(m);
  }
  importFile(path, raw) {
    checkImportSize(path, typeof raw === 'string' ? raw.length : Infinity);
    if (extname(path).toLowerCase() === '.json') return { restored: this.restore(JSON.parse(raw)) };
    if (raw.length > 2_000_000)
      throw new Error('Transcript exceeds the 2,000,000-character import limit.');
    const title = text(basename(path, extname(path)), 300);
    const segment = { id: randomUUID(), text: raw, speaker: 'Imported transcript', timestamp: 0 };
    return { meeting: this.create({ title }, [segment]) };
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
      ...segmentLocale(segment),
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
      ...(Array.isArray(input.locales) && input.locales.length > 1
        ? { locales: input.locales }
        : {}),
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
  // `language` is what the retry used ({ locale, locales }); the recording's label follows it.
  replaceRecordingTranscript(id, recordingId, segments, diagnostics, language) {
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
        ...segmentLocale(segment),
        text: text(segment.text),
        speaker: text(segment.speaker ?? 'Speaker', 100),
        timestamp: session.baseDuration + Math.max(0, Number(segment.timestamp) || 0),
      }));
    if (!replacement.length)
      throw new Error('No transcript text was recovered. The existing transcript was preserved.');
    const replaced = {
      recordingId,
      at: new Date().toISOString(),
      segments: m.transcript.filter((segment) => segment.recordingId === recordingId),
      edited: Boolean(session.edited),
    };
    session.edited = false;
    session.previousAt = replaced.at;
    m.transcript = [
      ...m.transcript.filter((segment) => segment.recordingId !== recordingId),
      ...replacement,
    ].sort((a, b) => a.timestamp - b.timestamp);
    session.diagnostics = diagnostics;
    session.lastTranscribedAt = new Date().toISOString();
    if (language?.locale) {
      session.locale = language.locale;
      if (language.locales?.length > 1) session.locales = language.locales;
      else delete session.locales;
    }
    m.updatedAt = new Date().toISOString();
    // The replaced transcript is kept (the latest 20 per meeting) beside the meeting, not in it.
    return this.write(m, () => {
      this.db
        .prepare('INSERT INTO transcript_versions(meeting_id, data) VALUES(?,?)')
        .run(id, JSON.stringify(replaced));
      this.db
        .prepare(
          'DELETE FROM transcript_versions WHERE meeting_id=? AND id NOT IN (SELECT id FROM transcript_versions WHERE meeting_id=? ORDER BY id DESC LIMIT 20)',
        )
        .run(id, id);
    });
  }
  editSegment(id, segmentId, patch) {
    const m = this.get(id);
    const i = m.transcript.findIndex((s) => s.id === segmentId);
    if (i < 0) throw new Error('Transcript segment not found.');
    // A recording whose transcript was corrected by hand is not retried without asking.
    const session = m.recordings.find((r) => r.id === m.transcript[i].recordingId);
    if (session) session.edited = true;
    if (patch.remove) m.transcript.splice(i, 1);
    else {
      if ('text' in patch) m.transcript[i].text = text(patch.text);
      if ('speaker' in patch) m.transcript[i].speaker = text(patch.speaker, 100);
    }
    m.updatedAt = new Date().toISOString();
    return this.write(m);
  }
  // Gone for good, from Trash only: the note, its search entry, earlier transcripts and its chat.
  // The database file is then rebuilt, so neither the deleted text nor older versions of it stay
  // behind in free pages, the search index or the journal (about 0.3 s for a 27 MB notebook).
  deleteForever(ids) {
    const notes = ids.map((id) => this.get(id));
    if (notes.some((m) => !m.deletedAt))
      throw new Error('Move a note to Trash before deleting it forever.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const { id } of notes) {
        const { rowid } = this.db.prepare('SELECT rowid FROM meetings WHERE id=?').get(id);
        this.db.prepare('DELETE FROM meeting_search WHERE rowid=?').run(rowid);
        this.db.prepare('DELETE FROM transcript_versions WHERE meeting_id=?').run(id);
        this.db.prepare('DELETE FROM messages WHERE scope=?').run(`meeting:${id}`);
        this.db.prepare('DELETE FROM meetings WHERE id=?').run(id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    // The search index keeps deleted words in its segments until they are merged.
    this.db.exec(
      "INSERT INTO meeting_search(meeting_search) VALUES('optimize'); VACUUM; PRAGMA wal_checkpoint(TRUNCATE)",
    );
    return notes.length;
  }
  // Swaps a recording's transcript with the one its last Retry (or restore) replaced, so a restore
  // is undone by restoring again.
  restoreTranscript(id, recordingId) {
    const m = this.get(id),
      session = m.recordings.find((r) => r.id === recordingId);
    if (!session) throw new Error('Recording not found.');
    const row = this.db
      .prepare('SELECT id, data FROM transcript_versions WHERE meeting_id=? ORDER BY id DESC')
      .all(id)
      .find((r) => JSON.parse(r.data).recordingId === recordingId);
    if (!row) throw new Error('There is no earlier transcript for this recording.');
    const previous = JSON.parse(row.data);
    const current = {
      recordingId,
      at: new Date().toISOString(),
      segments: m.transcript.filter((segment) => segment.recordingId === recordingId),
      edited: Boolean(session.edited),
    };
    m.transcript = [
      ...m.transcript.filter((segment) => segment.recordingId !== recordingId),
      ...previous.segments,
    ].sort((a, b) => a.timestamp - b.timestamp);
    session.edited = Boolean(previous.edited);
    session.previousAt = current.at;
    m.updatedAt = new Date().toISOString();
    return this.write(m, () => {
      this.db.prepare('DELETE FROM transcript_versions WHERE id=?').run(row.id);
      this.db
        .prepare('INSERT INTO transcript_versions(meeting_id, data) VALUES(?,?)')
        .run(id, JSON.stringify(current));
    });
  }
  // Matching meetings' ids, best first. The search box wants every word (the last one may be
  // unfinished); `any` is for questions, where any word or pair of CJK characters may match and
  // relevance decides.
  search(query, { any = false } = {}) {
    const terms = text(query, 1000).trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return this.all().map(({ id }) => ({ id }));
    const phrase = (tokens, prefix) =>
      '"' + tokens.join(' ').replaceAll('"', '""') + '"' + (prefix ? '*' : '');
    const parts = terms.flatMap((term) => {
      const tokens = searchable(term)
        .trim()
        .split(/\s+/)
        .filter((token) => /[\p{L}\p{N}]/u.test(token));
      if (!tokens.length) return [];
      if (!any) return [phrase(tokens, !cjkCharacter.test(tokens.at(-1)))];
      const out = [];
      let run = [];
      const pairs = () => {
        if (run.length === 1) out.push(phrase(run, false));
        for (let i = 0; i + 1 < run.length; i++) out.push(phrase(run.slice(i, i + 2), false));
        run = [];
      };
      for (const token of tokens)
        if (cjkCharacter.test(token)) run.push(token);
        else {
          pairs();
          out.push(phrase([token], true));
        }
      pairs();
      return out;
    });
    if (!parts.length) return [];
    return this.db
      .prepare('SELECT id FROM meeting_search WHERE meeting_search MATCH ? ORDER BY rank LIMIT 500')
      .all(parts.join(any ? ' OR ' : ' AND '))
      .map(({ id }) => ({ id }));
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
    return {
      inputDevice: null,
      echoCancellation: 'auto',
      locale: 'en-US',
      ...Object.fromEntries(
        this.db
          .prepare('SELECT * FROM settings')
          .all()
          .map((r) => [r.key, JSON.parse(r.data)]),
      ),
    };
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
      // Earlier transcript versions (kept beside each meeting) stay on this Mac: a restore never
      // brings them back, and after a few retries they are most of a notebook's size.
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
      settings: Object.fromEntries(
        Object.entries(this.settings()).filter(([key]) => portableSettings.has(key)),
      ),
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
    const folders = (input.folders ?? []).map((f) => ({
      id: text(f.id, 100),
      name: text(f.name, 100),
    }));
    const knownFolders = new Set([...folders, ...this.folders()].map((f) => f.id));
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
            'deletedAt',
          ].map((key) => [key, m[key]]),
        ),
        folderId: knownFolders.has(m.folderId) ? m.folderId : null,
        // The calendar occurrence keeps a restored Mac from creating a second note for it.
        ...(typeof m.eventKey === 'string' ? { eventKey: text(m.eventKey, 1100) } : {}),
        versions: m.versions.slice(0, 20).map(({ text, at }) => ({ text, at })),
        summarySource: m.summarySource === 'edited' ? 'edited' : 'ai',
        summaryAt: Number.isFinite(Date.parse(m.summaryAt)) ? m.summaryAt : m.updatedAt,
        transcript: m.transcript.map((s) => ({
          id: s.id,
          text: s.text,
          speaker: s.speaker,
          timestamp: s.timestamp,
          ...(['microphone', 'system'].includes(s.source) ? { source: s.source } : {}),
          ...segmentLocale(s),
        })),
        recordings: [],
      };
    });
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
      return {
        id: m.id,
        scope: m.scope,
        role: m.role,
        content: m.content,
        createdAt: Number.isFinite(Date.parse(m.createdAt))
          ? m.createdAt
          : new Date().toISOString(),
        sources: m.sources.map(({ id, title, number }) => ({ id, title, number })),
      };
    });
    const settings = Object.entries(input.settings ?? {})
      .filter(([key]) => portableSettings.has(key))
      .map(([key, value]) => {
        validateSetting(key, value);
        return [key, value];
      });
    // A meeting listed twice (a hand-edited or merged backup) is restored once.
    const seen = new Set();
    const unique = meetings.filter((m) => !seen.has(m.id) && seen.add(m.id));
    const additions = unique.filter(
      (m) => !this.db.prepare('SELECT id FROM meetings WHERE id=?').get(m.id),
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const f of folders)
        this.db.prepare('INSERT OR IGNORE INTO folders VALUES(?,?)').run(f.id, f.name);
      for (const m of additions) {
        this.db.prepare('INSERT INTO meetings VALUES(?,?)').run(m.id, JSON.stringify(m));
        this.index(m);
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
const isLocale = (value) =>
  typeof value === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(value);
export function validateLocale(value) {
  if (!isLocale(value)) throw new Error('Invalid recognition language.');
}
// Chinese, Japanese and Korean text has no spaces between words, so each character is indexed as
// a token of its own and searched as a phrase; "React" inside a Chinese sentence is then a word.
const cjkCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const searchable = (value) =>
  value.replace(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
    ' $& ',
  );
// A backup holds the whole notebook; any other import is one transcript. Checked against the file
// size before reading, and against the text after.
export function checkImportSize(path, size) {
  if (extname(path).toLowerCase() === '.json') {
    if (size > 250_000_000) throw new Error('Backup exceeds the 250 MB import limit.');
  } else if (size > 30_000_000) throw new Error('File exceeds the 30 MB import limit.');
}
// Segments remember which language produced them (Auto picks one per sentence).
const segmentLocale = (segment) => (isLocale(segment.locale) ? { locale: segment.locale } : {});
export function validateSetting(key, value) {
  if (['model', 'claudeModel'].includes(key)) text(value, 300);
  else if (key === 'locale') {
    // 'auto' picks between the two `autoLocales` sentence by sentence.
    if (value !== 'auto') validateLocale(value);
  } else if (key === 'autoLocales') {
    if (!Array.isArray(value) || value.length !== 2 || value[0] === value[1])
      throw new Error('Choose two different languages for Auto.');
    value.forEach(validateLocale);
  } else if (key === 'uiLanguage') {
    if (!['system', 'en', 'zh-Hans'].includes(value))
      throw new Error('Invalid interface language.');
  } else if (key === 'inputDevice') {
    if (
      value !== null &&
      (typeof value !== 'string' ||
        !value.trim() ||
        value.length > 1000 ||
        /[\x00-\x1f]/.test(value))
    )
      throw new Error('Invalid input device.');
  } else if (key === 'echoCancellation') {
    if (!['auto', 'on', 'off'].includes(value))
      throw new Error('Invalid echo cancellation preference.');
  } else if (key === 'provider') {
    if (!['chatgpt', 'claude'].includes(value)) throw new Error('Invalid AI provider.');
  } else if (key === 'claudePath') {
    if (value !== null && !(typeof value === 'string' && /^\/.{1,999}$/s.test(value)))
      throw new Error('Invalid Claude Code path.');
  } else if (key === 'callService') {
    // The service the Start meeting button opens.
    if (!startableServices.includes(value)) throw new Error('Invalid meeting service.');
  } else if (
    [
      'systemAudio',
      'autoEnhance',
      'meetingReminders',
      'reminderAutoRecord',
      'meetingDetection',
      'openOnMeetingDetected',
      'calendarConnected',
    ].includes(key)
  ) {
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
function sourceBlock(m, number, transcript = true) {
  return `SOURCE [${number}] meeting_id=${m.id}\n${JSON.stringify({
    title: m.title,
    date: m.createdAt,
    notes: m.notes,
    summary: m.summary,
    ...(transcript
      ? {
          transcript: m.transcript.map((s) => ({
            speaker: s.speaker,
            time: s.timestamp,
            text: s.text,
          })),
        }
      : { transcriptOmitted: true }),
  })}`;
}
export function context(meetings) {
  const blocks = meetings.map((m, i) => sourceBlock(m, i + 1));
  if (blocks.join('\n\n').length > 350000)
    throw new Error(
      `Meeting “${meetings.find((m, i) => blocks[i].length > 350000)?.title ?? meetings[0]?.title}” is too large for AI context (350,000 characters). Shorten its notes or transcript before trying again.`,
    );
  return blocks.join('\n\n');
}
export function chatContext(meetings, matches = [], { single = false, budget = 350000 } = {}) {
  if (single) {
    const source = context(meetings);
    return {
      source,
      sources: meetings.map((m, i) => ({ id: m.id, title: m.title, number: i + 1 })),
      context: { included: meetings.length, total: meetings.length },
    };
  }
  const rank = new Map(matches.map((m, i) => [m.id, i]));
  const ranked = [...meetings].sort(
    (a, b) =>
      (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) ||
      b.createdAt.localeCompare(a.createdAt) ||
      a.id.localeCompare(b.id),
  );
  const included = new Map();
  let used = 0;
  // Reserve summaries and notes before spending space on any full transcript.
  for (const [i, m] of ranked.entries()) {
    if (!(m.notes.trim() || m.summary.trim())) continue;
    const block = sourceBlock(m, i + 1, false);
    const cost = block.length + (included.size ? 2 : 0);
    if (used + cost > budget) continue;
    included.set(m.id, { m, block, full: false });
    used += cost;
  }
  for (const [i, m] of ranked.entries()) {
    const item = included.get(m.id);
    if (!item && (m.notes.trim() || m.summary.trim())) continue;
    const block = sourceBlock(m, i + 1);
    const cost = item ? block.length - item.block.length : block.length + (included.size ? 2 : 0);
    if (used + cost > budget) continue;
    used += cost;
    included.set(m.id, { m, block, full: true });
  }
  const selected = ranked.filter((m) => included.has(m.id));
  return {
    // Final numbering can only shorten the reserved blocks, never exceed the budget.
    source: selected.map((m, i) => sourceBlock(m, i + 1, included.get(m.id).full)).join('\n\n'),
    sources: selected.map((m, i) => ({ id: m.id, title: m.title, number: i + 1 })),
    context: { included: selected.length, total: meetings.length },
  };
}

export function chatHistory(messages, budget = 60000) {
  const history = [];
  let used = 0;
  for (const m of messages.slice(-12).reverse()) {
    const content =
      m.role === 'assistant'
        ? m.content.replace(/\[(\d+)\]/g, (match, number) => {
            const previous = m.sources?.find((source) => source.number === Number(number));
            return previous
              ? `(previous source: ${previous.title}; meeting_id=${previous.id})`
              : match;
          })
        : m.content;
    if (used + content.length > budget) break;
    used += content.length;
    history.unshift({ role: m.role, content });
  }
  return history;
}
