import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft, AudioLines, Check, Home, Leaf, Plus, Square, X } from 'lucide-react';
import { IconButton, Rich } from './components/Content.jsx';
import { HomeFeed } from './components/HomeFeed.jsx';
import { StartMeeting } from './components/StartMeeting.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { NoteToolbar, NoteView } from './components/NoteView.jsx';
import { EnhancePill, RecordPill } from './components/Dock.jsx';
import { MeetingEndPrompt } from './components/MeetingEndPrompt.jsx';
import { TranscriptSheet } from './components/TranscriptSheet.jsx';
import { isCapturing, playableTracks } from './components/RecordingAudio.jsx';
import { ChatPanel } from './components/ChatPanel.jsx';
import { SettingsDialog } from './components/SettingsDialog.jsx';
import { aiView, claudeModels, modelKey } from './ai-view.mjs';
import { eventKey, eventNote, meetingForEvent } from './reminders.mjs';
import { callTitle } from './calls.mjs';
import {
  cleanError,
  date,
  time,
  duration,
  silentState,
  fileSize,
  speakerLabel,
  storedSpeaker,
} from './format.mjs';
import { liveValue } from './live-values.mjs';
import { tidyNotes } from './meeting-context.mjs';
import { withoutImages } from './note-images.mjs';
import { resolveLanguage, translator } from './i18n/index.mjs';
import { I18nProvider } from './i18n/react.jsx';
import './style.css';
import stillnoteIcon from '../assets/icon-small.png';
const api = window.stillnote;
function App() {
  const [data, setData] = useState(null),
    [selected, setSelected] = useState(null),
    [view, setView] = useState('home'),
    [query, setQuery] = useState(''),
    [searchIds, setSearchIds] = useState(null),
    [tab, setTab] = useState('notes'),
    [sheet, setSheet] = useState(null),
    [searchOpen, setSearchOpen] = useState(false),
    [errorState, setErrorState] = useState(null),
    [loading, setLoading] = useState(true),
    [silent, setSilent] = useState({}),
    [aiTarget, setAiTarget] = useState(null),
    [notice, setNotice] = useState(''),
    [modal, setModal] = useState(null),
    [chatOpen, setChatOpen] = useState(false),
    [question, setQuestion] = useState(''),
    [chatScope, setChatScope] = useState('meeting'),
    [messages, setMessages] = useState([]),
    [busy, setBusy] = useState(null),
    [stream, setStream] = useState(''),
    // Live transcript lines and audio levels change several times a second; only the transcript
    // and the meters subscribe to them (see live-values.mjs).
    [partials] = useState(() => liveValue({})),
    [accountBusy, setAccountBusy] = useState(false),
    [chatgptModels, setChatgptModels] = useState([]),
    [calendarBusy, setCalendarBusy] = useState(false),
    [editingSummary, setEditingSummary] = useState(false),
    [elapsed, setElapsed] = useState(0),
    [audioLevels] = useState(() => liveValue({})),
    [captureSources, setCaptureSources] = useState({}),
    [retryingRecording, setRetryingRecording] = useState(null),
    [saving, setSaving] = useState(false),
    [drafts, setDrafts] = useState({}),
    // "Meeting detected": the in-app twin of the notification, until acted on or dismissed.
    [detected, setDetected] = useState(null),
    // "The meeting seems to be over" for the recording in progress: { reason, deadline, … }.
    [endPrompt, setEndPrompt] = useState(null),
    // A Start, Join or Take notes click in progress: the buttons wait, so a double click opens
    // one call and one note.
    [callPending, setCallPending] = useState(false);
  const draftRef = useRef({}),
    timers = useRef({}),
    dialogRef = useRef(),
    searchRef = useRef(),
    busyRef = useRef(null),
    current = useRef({}),
    backdropDown = useRef(false),
    aiRequest = useRef({}),
    answerContexts = useRef(new Map()),
    messagesRequest = useRef(0),
    // Streamed AI text is drawn in batches, not once per token.
    pendingDelta = useRef(''),
    deltaTimer = useRef(0),
    newNoteRef = useRef(),
    callPendingRef = useRef(false);
  // Interface language: the setting, else the first macOS language Stillnote has.
  const language = resolveLanguage(
    data?.settings.uiLanguage,
    data?.systemLanguages ?? navigator.languages,
  );
  const t = useMemo(() => translator(language), [language]);
  function resetStream() {
    clearTimeout(deltaTimer.current);
    deltaTimer.current = 0;
    pendingDelta.current = '';
    setStream('');
  }
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  const error = errorState?.message ?? '';
  const setError = (message, permission) =>
    setErrorState(message ? { message: cleanError(message), owner: 'external', permission } : null);
  // `t` rides along so the once-registered event subscription speaks the current language.
  current.current = { selected, view, recording: data?.recording, chatOpen, t, record };
  const call = async (name, ...args) => api.call(name, ...args);
  const updateMeeting = (m) =>
    setData((d) =>
      d
        ? {
            ...d,
            meetings: d.meetings.some((x) => x.id === m.id)
              ? d.meetings.map((x) => (x.id === m.id ? m : x))
              : [m, ...d.meetings],
          }
        : d,
    );
  const guard = async (fn) => {
    setErrorState((e) => (e?.owner === 'guard' ? null : e));
    try {
      return await fn();
    } catch (e) {
      setErrorState({ message: cleanError(e), owner: 'guard' });
      return null;
    }
  };
  const load = async () => {
    setLoading(true);
    try {
      const d = await call('state');
      setData(d);
      current.current.recording = d.recording;
      if (d.startupError) setError(d.startupError);
      return d;
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    guard(load);
    return api.subscribe((e) => {
      if (e.type === 'flush-before-close')
        guard(async () => {
          await flushAll();
          await call('finish-close');
        });
      if (e.type === 'auto-enhance-start') {
        busyRef.current = 'auto-enhance';
        setBusy('enhance');
        aiRequest.current = { startedAt: Date.now() };
        setAiTarget({ id: e.id });
        if (
          current.current.selected === e.id ||
          (!current.current.selected && current.current.view === 'home')
        ) {
          setSelected(e.id);
          setTab('summary');
          setSheet(null);
        } else setNotice({ text: current.current.t('Enhancing your recorded note.'), id: e.id });
        resetStream();
      }
      if (e.type === 'ai-done' && busyRef.current === 'auto-enhance') {
        busyRef.current = null;
        setBusy(null);
        resetStream();
      }
      if (e.type === 'ai') setData((d) => (d ? { ...d, ai: e.ai } : d));
      if (e.type === 'meeting') updateMeeting(e.meeting);
      if (e.type === 'meetings-deleted')
        setData((d) =>
          d ? { ...d, meetings: d.meetings.filter((m) => !e.ids.includes(m.id)) } : d,
        );
      // A calendar that loads is connected; Settings words the reminder switch from that.
      if (e.type === 'calendar')
        setData((d) =>
          d
            ? { ...d, calendar: e.events, settings: { ...d.settings, calendarConnected: true } }
            : d,
        );
      if (e.type === 'meeting-detected') setDetected({ event: e.event, at: Date.now() });
      if (e.type === 'meeting-end') setEndPrompt(e);
      if (['meeting-end-cleared', 'stopped'].includes(e.type)) setEndPrompt(null);
      // Stopped by meeting-end detection, or a long silence at the end removed: say so, with a way
      // to carry on recording into the same note.
      if (e.type === 'meeting-end-stopped' || e.type === 'silence-trimmed') {
        const { t } = current.current;
        const trimmed = e.removed
          ? t('Removed {time} of silence at the end.', { time: duration(e.removed) })
          : '';
        setNotice(
          e.type === 'silence-trimmed'
            ? trimmed
            : {
                text: [t('Recording stopped: the meeting seemed to be over.'), trimmed]
                  .filter(Boolean)
                  .join(' '),
                action: {
                  label: t('Resume recording'),
                  run: () => {
                    setSelected(e.id);
                    setView('all');
                    setTab('notes');
                    void current.current.record(e.id);
                  },
                },
              },
        );
      }
      if (['open-meeting', 'started'].includes(e.type)) setDetected(null);
      // A clicked meeting reminder: open its note and, if enabled, start recording.
      if (e.type === 'open-meeting')
        guard(async () => {
          await flushAll();
          setSelected(e.id);
          setView('all');
          setQuery('');
          setTab('notes');
          setSheet(null);
          setChatOpen(false);
          setEditingSummary(false);
          if (e.record) await record(e.id);
        });
      if (e.type === 'audio-level')
        audioLevels.set((levels) => ({ ...levels, [e.source]: { ...e, receivedAt: Date.now() } }));
      if (e.type === 'recording-status') {
        if (e.recording)
          setData((d) =>
            d ? { ...d, recording: e.recording, starting: e.starting ?? d.starting } : d,
          );
        if (e.recording?.sources) setCaptureSources(e.recording.sources);
        else if (e.source) setCaptureSources((sources) => ({ ...sources, [e.source]: e }));
      }
      const recordingId = current.current.recording?.recordingId;
      setSilent((s) => silentState(s, e, recordingId));
      if (e.type === 'device-changed' && e.recordingId === current.current.recording?.recordingId) {
        setNotice(current.current.t('Microphone changed to {device}.', { device: e.device.name }));
        setCaptureSources((sources) => ({
          ...sources,
          microphone: { ...sources.microphone, device: e.device },
        }));
      }
      if (e.type === 'started') {
        audioLevels.set({});
        setCaptureSources(e.recording?.sources ?? {});
      }
      if (
        ['started', 'stopped'].includes(e.type) ||
        (e.type === 'error' && 'recording' in e && (!e.op || e.op === 'start'))
      ) {
        current.current.recording = e.recording;
        setData((d) => (d ? { ...d, recording: e.recording, starting: false } : d));
      }
      if (e.type === 'partial') partials.set((p) => ({ ...p, [e.segmentId || e.speaker]: e }));
      if (e.type === 'segment')
        partials.set((p) => {
          const n = { ...p };
          delete n[e.segmentId || e.speaker];
          return n;
        });
      if (e.type === 'stopped') partials.set({});
      // Provisional text withdrawn: revised away, or (Auto) in a language that lost the sentence.
      if (e.type === 'partial-discard')
        partials.set((p) => {
          const n = { ...p };
          for (const id of e.segmentIds ?? []) delete n[id];
          return n;
        });
      if (e.type === 'error' || e.type === 'warning') {
        const message = cleanError(e.message);
        if (message === 'Stopped.' || message.startsWith('Timed out after 5 minutes.'))
          setNotice(
            current.current.t(cleanError(e.message, busyRef.current ? aiErrorOptions() : {})),
          );
        else setError(message, e.permission);
      }
      if (e.type === 'ai-delta') {
        pendingDelta.current += e.delta;
        deltaTimer.current ||= setTimeout(() => {
          const delta = pendingDelta.current;
          pendingDelta.current = '';
          deltaTimer.current = 0;
          setStream((s) => s + delta);
        }, 50);
      }
    });
  }, []);
  useEffect(() => {
    // A notice with an action (Undo) stays a little longer.
    const t = setTimeout(() => setNotice(''), notice?.action ? 10000 : 5000);
    return () => clearTimeout(t);
  }, [notice]);
  // A detected meeting nobody acted on stops asking after ten minutes.
  useEffect(() => {
    if (!detected) return;
    const t = setTimeout(() => setDetected(null), 10 * 60_000);
    return () => clearTimeout(t);
  }, [detected]);
  useEffect(() => {
    if (modal) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [modal?.kind]);
  useEffect(() => {
    const t = setInterval(() => {
      if (data?.recording) setElapsed((Date.now() - data.recording.startedAt) / 1000);
    }, 1000);
    return () => clearInterval(t);
  }, [data?.recording]);
  useEffect(() => {
    let valid = true;
    const t = setTimeout(() => {
      if (!query.trim()) {
        setSearchIds(null);
        return;
      }
      call('search', query)
        .then((ms) => {
          if (valid) setSearchIds(ms.map((m) => m.id));
        })
        .catch((e) => setError(e.message));
    }, 150);
    return () => {
      valid = false;
      clearTimeout(t);
    };
    // Results refresh as notes change, but not on every transcript line while recording.
  }, [query, data?.recording ? null : data?.meetings]);
  useEffect(() => {
    const key = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        setChatOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchRef.current?.focus());
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        // The latest newNote: the first render's would title the note in the wrong language.
        newNoteRef.current();
      }
      // ⌘⇧T toggles the open note's transcript like its Transcript button in the dock, and
      // brings it back from behind the chat.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key?.toLowerCase() === 't') {
        e.preventDefault();
        const { selected, chatOpen } = current.current;
        if (selected && !dialogRef.current?.open) {
          setChatOpen(false);
          setSheet((s) => (s === 'transcript' && !chatOpen ? null : 'transcript'));
        }
      }
      if (e.key === 'Escape' && !dialogRef.current?.open) setSheet(null);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const ai = useMemo(() => aiView(data), [data?.ai, data?.account]);
  useEffect(() => {
    if (ai.chatgpt.ready)
      call('account', 'models')
        .then(setChatgptModels)
        .catch(() => setChatgptModels([]));
    else setChatgptModels([]);
  }, [ai.chatgpt.ready, ai.chatgpt.active]);
  const rawMeeting = data?.meetings.find((m) => m.id === selected),
    meeting = rawMeeting ? { ...rawMeeting, ...drafts[selected] } : null;
  const scope =
    chatScope === 'meeting' && meeting
      ? `meeting:${meeting.id}`
      : view.startsWith('folder:') && chatScope === 'folder'
        ? view
        : 'all';
  current.current.scope = scope;
  const withAnswerContext = (rows) =>
    rows.map((m) =>
      answerContexts.current.has(m.id) ? { ...m, context: answerContexts.current.get(m.id) } : m,
    );
  useEffect(() => {
    let valid = true;
    const request = ++messagesRequest.current;
    setMessages([]);
    if (chatOpen)
      guard(async () => {
        const rows = await call('messages', scope);
        if (valid && request === messagesRequest.current) setMessages(withAnswerContext(rows));
      });
    return () => {
      valid = false;
    };
  }, [chatOpen, scope]);
  async function flush(id) {
    clearTimeout(timers.current[id]);
    const patch = draftRef.current[id];
    if (!patch) return;
    delete draftRef.current[id];
    setSaving(true);
    try {
      const m = await call('update', id, patch);
      updateMeeting(m);
      setDrafts((d) => {
        const n = { ...d };
        if (!draftRef.current[id]) delete n[id];
        return n;
      });
    } catch (e) {
      draftRef.current[id] = { ...patch, ...draftRef.current[id] };
      throw e;
    } finally {
      setSaving(false);
    }
  }
  async function flushAll() {
    for (const id of Object.keys(draftRef.current)) await flush(id);
  }
  function draft(patch, id = selected) {
    draftRef.current[id] = { ...draftRef.current[id], ...patch };
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
    clearTimeout(timers.current[id]);
    timers.current[id] = setTimeout(() => guard(() => flush(id)), 350);
  }
  async function patch(p) {
    return guard(async () => {
      await flush(selected);
      const m = await call('update', selected, p);
      updateMeeting(m);
      return m;
    });
  }
  newNoteRef.current = newNote;
  async function newNote(input = {}) {
    // A calendar occurrence keeps one note: opening it again returns to that note.
    const existing = input.eventKey && meetingForEvent(data?.meetings, input.eventKey);
    if (existing) {
      await openNote(existing);
      return existing.id;
    }
    return guard(async () => {
      await flushAll();
      // A new note's placeholder title is written in the interface language.
      const m = await call('create', { title: t('Untitled meeting'), ...input });
      updateMeeting(m);
      setSelected(m.id);
      setView('all');
      setQuery('');
      setTab('notes');
      setSheet(null);
      setChatOpen(false);
      return m.id;
    });
  }
  // "Start now" on a calendar meeting: open (or create) its note and record right away.
  async function startMeeting(input) {
    const id = await newNote(input);
    if (id && current.current.recording?.id !== id) await record(id);
  }
  // Start a meeting: the main process opens a new Google Meet or Zoom call, then it is recorded
  // in a new note named after the service and the time.
  async function oneCall(work) {
    if (callPendingRef.current) return;
    callPendingRef.current = true;
    setCallPending(true);
    try {
      await work();
    } finally {
      callPendingRef.current = false;
      setCallPending(false);
    }
  }
  function startCall(service) {
    return oneCall(async () => {
      const settings = await guard(() => call('start-call', service));
      if (!settings) return;
      setData((d) => ({ ...d, settings }));
      const id = await newNote({ title: callTitle(service, Date.now(), t) });
      if (id) await record(id);
    });
  }
  // Join & record: open the event's call, then record in its note.
  function joinMeeting(event) {
    return oneCall(async () => {
      if (await guard(() => call('join-call', eventKey(event))))
        await startMeeting(eventNote(event, t));
    });
  }
  // "Take notes" on a detected meeting: record into the calendar meeting under way, or a new note.
  function takeDetectedNotes() {
    return oneCall(async () => {
      const event = detected?.event;
      setDetected(null);
      if (event) return startMeeting(eventNote(event, t));
      const id = await newNote({ title: callTitle(null, Date.now(), t) });
      if (id) await record(id);
    });
  }
  async function openNote(m, panel = null) {
    await guard(async () => {
      await flushAll();
      setSelected(m.id);
      setTab(m.summary ? 'summary' : 'notes');
      setSheet(panel);
      setEditingSummary(false);
    });
  }
  async function navigate(v) {
    await guard(async () => {
      await flushAll();
      setView(v);
      setSelected(null);
      setQuery('');
      setSheet(null);
      setChatOpen(false);
    });
  }
  async function account(action, id) {
    setAccountBusy(true);
    await guard(async () => {
      const result = await call('account', action, id);
      if (result?.warning) setError(result.warning);
      if (action === 'connect' && result?.sharing)
        await call('ai-provider', 'use', 'chatgpt').catch(() => {});
      await load();
    });
    setAccountBusy(false);
  }
  const applyAi = (result) => {
    if (result && typeof result === 'object' && 'provider' in result)
      setData((d) => ({ ...d, ai: result }));
  };
  const aiActions = {
    use: (provider) => guard(async () => applyAi(await call('ai-provider', 'use', provider))),
    refresh: () => guard(async () => applyAi(await call('ai-provider', 'refresh'))),
    claudeSignIn: () => guard(async () => applyAi(await call('ai-provider', 'claude-sign-in'))),
    claudeCancel: () => guard(async () => applyAi(await call('ai-provider', 'claude-cancel'))),
    installHelp: () => guard(() => call('ai-provider', 'install-help')),
    terminal: (step) =>
      guard(async () => applyAi(await call('ai-provider', 'claude-terminal', step))),
    chatgptSignIn: () => account('connect'),
  };
  async function settings(initialSection = 'ai') {
    setModal({
      kind: 'settings',
      initialSection: typeof initialSection === 'string' ? initialSection : 'ai',
    });
    guard(() => call('ai-provider', 'refresh').then(applyAi));
  }
  async function setting(key, value) {
    const s = await call('setting', key, value);
    setData((d) => ({ ...d, settings: s }));
  }
  const hasContent = !!meeting && (!!meeting.notes.trim() || meeting.transcript.length > 0);
  const activeRecord = !!data && data.recording?.id === selected;
  const enhanceDisabled =
    !!busy || !!retryingRecording || activeRecord || !!meeting?.deletedAt || !hasContent;
  function aiErrorOptions() {
    return {
      stopped: aiRequest.current.stopped,
      timedOut: !aiRequest.current.stopped && Date.now() - aiRequest.current.startedAt >= 300000,
    };
  }
  async function cancelAi() {
    aiRequest.current.stopped = true;
    await guard(() => call('cancel-ai'));
  }
  async function runAi(kind, target, fn) {
    busyRef.current = kind;
    aiRequest.current = {};
    setBusy(kind);
    setAiTarget(target);
    resetStream();
    await guard(async () => {
      try {
        await flushAll();
        if (aiRequest.current.stopped) return;
        aiRequest.current.startedAt = Date.now();
        await fn();
      } catch (e) {
        const message = cleanError(e, aiErrorOptions());
        if (message === 'Stopped.' || message.startsWith('Timed out after 5 minutes.'))
          setNotice(t(message));
        else throw e;
      } finally {
        busyRef.current = null;
        setBusy(null);
        resetStream();
      }
    });
  }
  async function enhance() {
    if (busyRef.current) return;
    setTab('summary');
    setSheet(null);
    setEditingSummary(false);
    if (!ai.ready) return;
    await runAi('enhance', { id: selected }, async () => {
      const r = await call('ai', { kind: 'enhance', id: selected });
      updateMeeting(r.meeting);
    });
  }
  async function ask(prompt = question) {
    if (busyRef.current || !prompt.trim()) return;
    await runAi('chat', { scope }, async () => {
      const ids =
        chatScope === 'meeting' && selected
          ? [selected]
          : chatScope === 'folder' && view.startsWith('folder:')
            ? data.meetings
                .filter((m) => m.folderId === view.slice(7) && !m.deletedAt)
                .map((m) => m.id)
            : data.meetings.filter((m) => !m.deletedAt).map((m) => m.id);
      const r = await call('ai', { kind: 'chat', ids, question: prompt, scope });
      const answerId = r.message?.id ?? r.messages.findLast((m) => m.role === 'assistant')?.id;
      if (answerId && r.context) answerContexts.current.set(answerId, r.context);
      const request = ++messagesRequest.current;
      if (current.current.scope === scope) {
        setMessages(withAnswerContext(r.messages));
        setQuestion((q) => (q === prompt ? '' : q));
      } else {
        const activeScope = current.current.scope;
        const rows = await call('messages', activeScope);
        if (current.current.scope === activeScope && request === messagesRequest.current)
          setMessages(withAnswerContext(rows));
      }
    });
  }
  async function importFile() {
    await guard(async () => {
      await flushAll();
      const r = await call('import');
      if (!r) return;
      await load();
      if (r.meeting) {
        setSelected(r.meeting.id);
        setTab('notes');
        setSheet('transcript');
        setView('all');
      } else
        setNotice(
          t.count(
            r.restored,
            'Imported {n} new meeting. Existing meetings were preserved.',
            'Imported {n} new meetings. Existing meetings were preserved.',
          ),
        );
    });
  }
  async function record(meetingId = selected) {
    await guard(async () => {
      await flushAll();
      setElapsed(0);
      audioLevels.set({});
      setCaptureSources({});
      const r = await call('record', meetingId);
      setData((d) => ({ ...d, recording: r, starting: true }));
      setTab('notes');
    });
  }
  async function retryRecording(recordingId, confirmed = false) {
    if (retryingRecording) return;
    const meetingId = selected;
    // Hand corrections would be replaced: ask first. The current version stays restorable.
    const session = meeting?.recordings.find((r) => r.id === recordingId);
    if (session?.edited && !confirmed) {
      setModal({
        kind: 'confirm',
        title: t('Transcribe again?'),
        message: t(
          'You edited this transcript. Transcribing again replaces your edits; the current version is kept, and Restore previous transcript brings it back.',
        ),
        confirmLabel: t('Transcribe again'),
        onConfirm: () => retryRecording(recordingId, true),
      });
      return;
    }
    setRetryingRecording(recordingId);
    try {
      await guard(async () => {
        await flushAll();
        const result = await call('transcribe-recording', meetingId, recordingId);
        const updated = result?.meeting ?? result;
        if (updated?.id) updateMeeting(updated);
        setNotice(t('Transcription finished. Review the transcript before enhancing your notes.'));
      });
    } finally {
      setRetryingRecording(null);
    }
  }
  // Delete forever, from Trash, after a confirmation that says what goes with the notes.
  async function deleteForever(notes) {
    const ids = notes.map((m) => m.id);
    const bytes = await guard(() => call('deletion-size', ids));
    if (bytes === undefined) return;
    const one = notes.length === 1;
    const message = [
      one
        ? t('Its notes, transcript and chat are deleted from Stillnote.')
        : t.count(
            notes.length,
            'The note in Trash is deleted from Stillnote, with its transcript and chat.',
            'All {n} notes in Trash are deleted from Stillnote, with their transcripts and chats.',
          ),
      t('Notebook and folder chats, and existing backups, may still contain quoted content.'),
      bytes > 0 &&
        t('{size} of saved audio moves to the macOS Trash.', { size: fileSize(bytes, t.locale) }),
    ]
      .filter(Boolean)
      .join(t.locale.startsWith('zh') ? '' : ' ');
    setModal({
      kind: 'confirm',
      destructive: true,
      title: one
        ? t('Delete “{title}” forever?', { title: notes[0].title || t('New note') })
        : t('Empty Trash?'),
      message,
      confirmLabel: one ? t('Delete forever') : t('Empty Trash'),
      onConfirm: () =>
        guard(async () => {
          const deleted = await call('delete-forever', ids);
          setData((d) => ({ ...d, meetings: d.meetings.filter((m) => !deleted.includes(m.id)) }));
          if (deleted.includes(current.current.selected)) {
            setSelected(null);
            setView('trash');
          }
          setNotice(
            t.count(deleted.length, 'Deleted {n} note forever.', 'Deleted {n} notes forever.'),
          );
        }),
    });
  }
  // Swaps the transcript back to the one the last Retry replaced; doing it again undoes it.
  async function restoreTranscript(recordingId) {
    const meetingId = selected;
    await guard(async () => {
      await flushAll();
      updateMeeting(await call('restore-transcript', meetingId, recordingId));
      setNotice({
        text: t('Previous transcript restored.'),
        action: {
          label: t('Undo'),
          run: () =>
            guard(async () =>
              updateMeeting(await call('restore-transcript', meetingId, recordingId)),
            ),
        },
      });
    });
  }
  async function calendar() {
    setCalendarBusy(true);
    await guard(async () => {
      const events = await call('calendar');
      setData((d) => ({
        ...d,
        calendar: events,
        settings: { ...d.settings, calendarConnected: true },
      }));
    });
    setCalendarBusy(false);
  }
  function openChat(nextScope) {
    setChatScope(
      nextScope ?? (meeting ? 'meeting' : view.startsWith('folder:') ? 'folder' : 'all'),
    );
    setSheet(null);
    setChatOpen(true);
  }
  const visible = useMemo(
    () =>
      data?.meetings
        .filter((m) => (view === 'trash' ? !!m.deletedAt : !m.deletedAt))
        .filter((m) =>
          view === 'starred'
            ? m.starred
            : view.startsWith('folder:')
              ? m.folderId === view.slice(7)
              : true,
        )
        .filter((m) =>
          !query.trim() || view === 'trash'
            ? !query.trim() ||
              [
                m.title,
                withoutImages(m.notes, ''),
                withoutImages(m.summary, ''),
                ...m.transcript.map((s) => s.text),
              ]
                .join(' ')
                .toLowerCase()
                .includes(query.toLowerCase())
            : searchIds?.includes(m.id),
        ) ?? [],
    [data?.meetings, view, searchIds, query],
  );
  const title =
    view === 'home'
      ? t('Home')
      : view === 'chat'
        ? t('Chat')
        : view === 'all'
          ? t('My notes')
          : view === 'starred'
            ? t('Starred')
            : view === 'trash'
              ? t('Trash')
              : (data?.folders.find((f) => f.id === view.slice(7))?.name ?? t('Notes'));
  if (!data)
    return (
      <I18nProvider t={t}>
        <div className="loading">
          <Leaf size={28} />
          {loading ? (
            <p>{t('Opening your notebook…')}</p>
          ) : (
            <>
              <p role="alert">{error ? t(error) : t('Your notebook could not be opened.')}</p>
              <button className="primary" onClick={() => guard(load)}>
                {t('Retry')}
              </button>
            </>
          )}
        </div>
      </I18nProvider>
    );
  const templates = data.templates;
  const modelGroups = [
    ai.claude.ready && { provider: 'claude', models: claudeModels },
    ai.chatgpt.ready && chatgptModels.length && { provider: 'chatgpt', models: chatgptModels },
  ].filter(Boolean);
  const activeModels = ai.provider === 'claude' ? claudeModels : chatgptModels;
  const savedModel = data.settings[modelKey(ai.provider)];
  const currentModel = activeModels.some((m) => m.id === savedModel)
    ? savedModel
    : activeModels[0]?.id;
  const globalChat = chatOpen && !meeting;
  const chat = (
    <ChatPanel
      global={globalChat}
      messages={messages}
      busy={busy === 'chat' && aiTarget?.scope !== scope ? 'other' : busy}
      stream={aiTarget?.scope === scope ? stream : ''}
      question={question}
      setQuestion={setQuestion}
      onAsk={() => ask()}
      onCancel={cancelAi}
      onClose={() => {
        setChatOpen(false);
        if (view === 'chat') setView('home');
      }}
      scope={chatScope}
      scopes={[
        ...(meeting ? [['meeting', t('This meeting')]] : []),
        ...(view.startsWith('folder:') ? [['folder', t('This folder')]] : []),
        ['all', t('All my notes')],
      ]}
      setScope={setChatScope}
      ai={ai}
      aiActions={aiActions}
      modelOptions={modelGroups}
      modelValue={`${ai.provider}:${currentModel}`}
      onModel={(value) =>
        guard(async () => {
          const split = value.indexOf(':');
          const provider = value.slice(0, split);
          if (provider !== ai.provider) applyAi(await call('ai-provider', 'use', provider));
          await setting(modelKey(provider), value.slice(split + 1));
        })
      }
      onSource={(m, number) => {
        const source = m.sources?.find((s) => s.number === number);
        const target = data.meetings.find((n) => n.id === source?.id);
        if (!target) return;
        // The transcript sheet sits where the chat panel is; the citation shows the transcript.
        setChatOpen(false);
        openNote(target, 'transcript').then(() => setView('all'));
      }}
      onOpenSource={(s) => {
        const target = data.meetings.find((m) => m.id === s.id);
        if (target) openNote(target).then(() => setView('all'));
      }}
      onApply={
        chatScope === 'meeting' && meeting
          ? (m) =>
              guard(async () => {
                if (!(await patch({ summary: m.content, snapshotSummary: true }))) return;
                setTab('summary');
                setNotice(t('Enhanced notes updated. The previous version is saved.'));
              })
          : null
      }
    />
  );
  return (
    <I18nProvider t={t}>
      <div
        className={
          'app' +
          (chatOpen ? ' chat-open' : '') +
          (meeting ? ' meeting-open' : '') +
          (globalChat ? ' chat-global' : '')
        }
      >
        <Sidebar
          view={view}
          chatOpen={chatOpen}
          folders={data.folders}
          query={query}
          onQuery={(value) => {
            setQuery(value);
            setSelected(null);
            setChatOpen(false);
            if (!['home', 'all', 'trash'].includes(view) && !view.startsWith('folder:'))
              setView('all');
          }}
          searchRef={searchRef}
          searchOpen={searchOpen || !!query}
          setSearchOpen={setSearchOpen}
          navigate={navigate}
          openChat={() =>
            guard(async () => {
              await flushAll();
              setSelected(null);
              setView('chat');
              setChatScope('all');
              setChatOpen(true);
            })
          }
          newFolder={() => setModal({ kind: 'folder', name: '' })}
          importFile={importFile}
          openSettings={settings}
          ai={ai}
          icon={stillnoteIcon}
        />
        <main className="workspace">
          <header className="topbar">
            <div className="topbar-left">
              {meeting ? (
                <>
                  <button
                    className="home-back"
                    onClick={() => navigate('home')}
                    aria-label={t('Back to Home')}
                  >
                    <ArrowLeft size={14} />
                    <Home size={14} />
                  </button>
                  <span className="save-state" aria-live="polite">
                    {saving ? (
                      t('Saving…')
                    ) : Object.keys(drafts[selected] ?? {}).length ? (
                      t('Unsaved')
                    ) : (
                      <>
                        <Check size={12} />
                        {t('Saved')}
                      </>
                    )}
                  </span>
                </>
              ) : (
                <span className="workspace-label">{view === 'home' ? '' : title}</span>
              )}
            </div>
            <div className="top-actions">
              {data.recording && !activeRecord && (
                <div className="global-recording" role="status">
                  <span className="rec-dot live" />
                  <span>
                    {data.recording.stopping
                      ? t('Finishing…')
                      : data.starting
                        ? t('Connecting…')
                        : t('Listening · {time}', { time: duration(elapsed) })}
                  </span>
                  <button
                    onClick={() => guard(() => call('stop'))}
                    aria-label={t('Finish active recording')}
                    disabled={data.recording.stopping}
                  >
                    <Square size={10} fill="currentColor" />
                    {t('Finish')}
                  </button>
                </div>
              )}
              {meeting ? (
                <NoteToolbar
                  meeting={meeting}
                  tab={tab}
                  setTab={(t) => {
                    setTab(t);
                    setEditingSummary(false);
                  }}
                  templates={templates}
                  patch={patch}
                  activeRecord={activeRecord}
                  onDeleteForever={() => deleteForever([meeting])}
                  onExport={() =>
                    guard(async () => {
                      await flushAll();
                      const path = await call('export', selected);
                      if (path) setNotice(t('Exported to {path}', { path }));
                    })
                  }
                />
              ) : (
                <>
                  <StartMeeting
                    service={data.settings.callService}
                    disabled={
                      !!data.recording || data.starting || callPending || !!retryingRecording
                    }
                    onStart={startCall}
                  />
                  <button
                    className="quick-note"
                    onClick={() => newNote()}
                    aria-label={t('New note')}
                  >
                    <Plus size={14} />
                    {t('New note')}
                  </button>
                </>
              )}
            </div>
          </header>
          {error && (
            <div className="error-banner" role="alert">
              <span>{t(error)}</span>
              {errorState.permission === 'screen-recording' && (
                <button
                  className="banner-action"
                  onClick={() => guard(() => call('open-privacy', errorState.permission))}
                >
                  {t('Open Settings')}
                </button>
              )}
              <IconButton label={t('Dismiss error')} className="small" onClick={() => setError('')}>
                <X size={14} />
              </IconButton>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              <Check size={14} />
              {typeof notice === 'string' ? notice : notice.text}
              {notice.action && (
                <button
                  className="text-button"
                  onClick={() => {
                    notice.action.run();
                    setNotice('');
                  }}
                >
                  {notice.action.label}
                </button>
              )}
              {notice.id && (
                <button
                  className="text-button"
                  onClick={async () => {
                    const target = data.meetings.find((m) => m.id === notice.id);
                    if (target) {
                      await openNote(target);
                      setTab('summary');
                      setNotice('');
                    }
                  }}
                >
                  {t('Open')}
                </button>
              )}
            </div>
          )}
          <div className="workspace-body">
            <section className="main-content">
              {globalChat ? (
                chat
              ) : meeting ? (
                <NoteView
                  meeting={meeting}
                  folders={data.folders}
                  tab={tab}
                  draft={draft}
                  onSaveImage={(bytes) => guard(() => call('save-image', meeting.id, bytes))}
                  onDeleteForever={() => deleteForever([meeting])}
                  onTidyContext={() => {
                    // The invite as it arrived comes back with Undo.
                    const before = meeting.notes,
                      id = meeting.id;
                    draft({ notes: tidyNotes(before, t) }, id);
                    setNotice({
                      text: t('Meeting context tidied.'),
                      action: { label: t('Undo'), run: () => draft({ notes: before }, id) },
                    });
                  }}
                  patch={patch}
                  busy={aiTarget?.id === selected ? busy : null}
                  stream={aiTarget?.id === selected ? stream : ''}
                  editingSummary={editingSummary}
                  setEditingSummary={setEditingSummary}
                  onEnhance={enhance}
                  enhanceDisabled={enhanceDisabled}
                  onCancel={cancelAi}
                  showCancel={chatOpen}
                  onHistory={() => setModal({ kind: 'history' })}
                  onSource={() => setSheet('transcript')}
                  coverage={{
                    onListen: () => setSheet('recordings'),
                    onRetry: retryRecording,
                    retrying: retryingRecording,
                    disabled: !!data.recording || !!meeting.deletedAt || !!busy,
                  }}
                  activeRecord={activeRecord}
                  ai={ai}
                  aiActions={aiActions}
                />
              ) : (
                <HomeFeed
                  data={data}
                  visible={visible}
                  view={view}
                  query={query}
                  title={title}
                  calendarBusy={calendarBusy}
                  calendar={calendar}
                  newNote={newNote}
                  startMeeting={(input) => oneCall(() => startMeeting(input))}
                  joinMeeting={joinMeeting}
                  callPending={callPending}
                  onEmptyTrash={() => deleteForever(data.meetings.filter((m) => m.deletedAt))}
                  openNote={openNote}
                  importFile={importFile}
                  setQuery={setQuery}
                />
              )}
            </section>
            <div className={'dock-wrap' + (chatOpen ? ' capture-only' : '')}>
              {detected && !data.recording && (
                <div className="meeting-prompt" role="status">
                  <span className="meeting-prompt-mark" aria-hidden="true">
                    <AudioLines size={16} />
                  </span>
                  <span className="meeting-prompt-text">
                    <strong>{t('Meeting detected — take notes?')}</strong>
                    <small>
                      {detected.event?.title || t('Another app is using your microphone.')}
                    </small>
                  </span>
                  <button
                    className="banner-action"
                    disabled={callPending}
                    onClick={takeDetectedNotes}
                  >
                    {t('Take notes')}
                  </button>
                  <IconButton
                    label={t('Dismiss')}
                    className="small"
                    onClick={() => setDetected(null)}
                  >
                    <X size={14} />
                  </IconButton>
                </div>
              )}
              {endPrompt &&
                data.recording?.recordingId === endPrompt.recordingId &&
                !data.recording.stopping && (
                  <MeetingEndPrompt
                    prompt={endPrompt}
                    onKeep={() =>
                      guard(async () => {
                        await call('keep-recording');
                        setEndPrompt(null);
                      })
                    }
                    onStop={() => guard(() => call('stop'))}
                  />
                )}
              {data.recording && (silent.microphone || silent.system) && (
                <div className="capture-warnings" role="status">
                  {silent.microphone && (
                    <div className="capture-warning">
                      {silent.microphone === true
                        ? t('No sound from the microphone')
                        : t('No sound from {device}', { device: silent.microphone })}
                      <button className="text-button" onClick={() => settings('capture')}>
                        {t('Change microphone')}
                      </button>
                    </div>
                  )}
                  {silent.system && (
                    <div className="capture-warning soft">{t('No meeting audio yet')}</div>
                  )}
                </div>
              )}
              {!chatOpen && (
                <>
                  {meeting && sheet && (
                    <TranscriptSheet
                      meeting={meeting}
                      tab={sheet}
                      setTab={setSheet}
                      onClose={() => setSheet(null)}
                      activeRecord={activeRecord}
                      partials={partials}
                      capture={{
                        levels: audioLevels,
                        sources: { ...data.recording?.sources, ...captureSources },
                        systemAudioRequested: data.settings.systemAudio ?? true,
                        starting: data.starting,
                        engine: data.recording?.engine,
                      }}
                      recordings={{
                        call,
                        onRetry: retryRecording,
                        onRestore: restoreTranscript,
                        retrying: retryingRecording,
                        locale: data.settings.locale,
                        autoLocales: data.settings.autoLocales,
                        disabled: !!data.recording || !!meeting.deletedAt || !!busy,
                      }}
                      onAddTranscript={() =>
                        setModal({
                          kind: 'transcript',
                          meetingId: meeting.id,
                          text: '',
                          speaker: speakerLabel('Speaker', t),
                        })
                      }
                      onEditSegment={(s) =>
                        setModal({
                          kind: 'segment',
                          meetingId: meeting.id,
                          ...s,
                          speaker: speakerLabel(s.speaker, t),
                        })
                      }
                    />
                  )}
                  {meeting &&
                    !sheet &&
                    ((busy === 'enhance' && aiTarget?.id === selected) ||
                      (!meeting.summary && hasContent && !activeRecord && !meeting.deletedAt)) && (
                      <EnhancePill
                        busy={busy === 'enhance' && aiTarget?.id === selected}
                        disabled={enhanceDisabled}
                        onEnhance={enhance}
                        onCancel={cancelAi}
                      />
                    )}
                  <div className="dock">
                    {meeting && (
                      <RecordPill
                        recording={{ ...data.recording, starting: data.starting }}
                        active={activeRecord}
                        canRecord={!meeting.deletedAt}
                        hasAudio={meeting.recordings?.length > 0 || meeting.transcript.length > 0}
                        elapsed={elapsed}
                        levels={audioLevels}
                        sheet={sheet}
                        lines={meeting.transcript.length}
                        saved={
                          meeting.recordings?.filter(
                            (r) => !isCapturing(r) && playableTracks(r).length > 0,
                          ).length ?? 0
                        }
                        disabled={!!data.recording || !!retryingRecording}
                        onStart={() => record()}
                        onStop={() => guard(() => call('stop'))}
                        onSheet={(panel) => setSheet((s) => (s === panel ? null : panel))}
                      />
                    )}
                    <div className="dock-chat">
                      <button
                        className="dock-placeholder"
                        aria-label={
                          meeting ? t('Chat with this meeting') : t('Chat with your notes')
                        }
                        onClick={() => openChat()}
                      >
                        {t('Ask anything')}
                        <kbd>⌘J</kbd>
                      </button>
                      <button
                        className="dock-recipe"
                        onClick={() => {
                          setQuestion(
                            meeting
                              ? t(
                                  'Draft a concise follow-up email with the decisions and next steps.',
                                )
                              : t(
                                  'List recent action items with their owners and due dates, citing the source meetings.',
                                ),
                          );
                          openChat();
                        }}
                      >
                        <span className="slash" aria-hidden="true">
                          /
                        </span>
                        {meeting ? t('Write follow-up email') : t('List recent todos')}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
            {chatOpen && !globalChat && chat}
          </div>
        </main>
        <dialog
          ref={dialogRef}
          className={modal?.kind === 'settings' ? 'settings-dialog' : ''}
          onCancel={() => setModal(null)}
          onMouseDown={(e) => {
            backdropDown.current = e.target === e.currentTarget;
          }}
          onClick={(e) => {
            if (backdropDown.current && e.target === e.currentTarget) setModal(null);
            backdropDown.current = false;
          }}
          aria-labelledby="modal-title"
        >
          <div className="modal-inner">
            <div className="modal-header">
              <h2 id="modal-title">
                {
                  {
                    settings: t('Settings'),
                    folder: t('New folder'),
                    transcript: t('Add a transcript'),
                    segment: t('Edit transcript'),
                    history: t('Previous summaries'),
                    template: t('Create a template'),
                    confirm: modal?.title,
                  }[modal?.kind]
                }
              </h2>
              <IconButton label={t('Close dialog')} onClick={() => setModal(null)}>
                <X size={17} />
              </IconButton>
            </div>
            {error && (
              <div className="modal-error" role="alert">
                {t(error)}
              </div>
            )}
            {modal?.kind === 'settings' ? (
              <SettingsDialog
                initialSection={modal.initialSection}
                call={call}
                subscribe={api.subscribe}
                data={data}
                ai={ai}
                accountBusy={accountBusy}
                account={account}
                aiActions={aiActions}
                models={{ chatgpt: chatgptModels, claude: claudeModels }}
                setting={setting}
                guard={guard}
                onUsage={() => guard(() => call('usage'))}
                onBackup={() =>
                  guard(async () => {
                    await flushAll();
                    const p = await call('backup');
                    if (p) {
                      setNotice(t('Backup saved.'));
                      setModal(null);
                    }
                  })
                }
                onReveal={() => guard(() => call('reveal'))}
                onTemplate={() => setModal({ kind: 'template', name: '', prompt: '' })}
              />
            ) : modal?.kind === 'folder' ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  guard(async () => {
                    const f = await call('folder', modal.name);
                    setData((d) => ({ ...d, folders: [...d.folders, f] }));
                    setModal(null);
                  });
                }}
              >
                <label className="field">
                  {t('Folder name')}
                  <input
                    autoFocus
                    required
                    maxLength={100}
                    value={modal.name}
                    onChange={(e) => setModal({ ...modal, name: e.target.value })}
                    placeholder={t('e.g. Customer conversations')}
                  />
                </label>
                <div className="modal-footer">
                  <button className="primary" type="submit">
                    {t('Create folder')}
                  </button>
                </div>
              </form>
            ) : ['transcript', 'segment'].includes(modal?.kind) ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  guard(async () => {
                    // The meeting the dialog was opened for, even if a reminder opened another since.
                    const target = data.meetings.find((m) => m.id === modal.meetingId);
                    const speaker = storedSpeaker(modal.speaker, t);
                    const m =
                      modal.kind === 'segment'
                        ? await call('edit-segment', modal.meetingId, modal.id, {
                            text: modal.text,
                            speaker,
                          })
                        : await call('transcript', modal.meetingId, {
                            text: modal.text,
                            speaker,
                            timestamp: target?.duration ?? 0,
                          });
                    updateMeeting(m);
                    setModal(null);
                    setSheet('transcript');
                  });
                }}
              >
                <label className="field">
                  {t('Speaker')}
                  <input
                    value={modal.speaker}
                    onChange={(e) => setModal({ ...modal, speaker: e.target.value })}
                  />
                </label>
                <label className="field">
                  {t('Transcript')}
                  <textarea
                    autoFocus
                    required
                    rows={10}
                    value={modal.text}
                    onChange={(e) => setModal({ ...modal, text: e.target.value })}
                    placeholder={t('Paste what was said…')}
                  />
                </label>
                <div className="modal-footer">
                  {modal.kind === 'segment' && (
                    <button
                      type="button"
                      className="text-button danger"
                      onClick={() =>
                        guard(async () => {
                          updateMeeting(
                            await call('edit-segment', selected, modal.id, { remove: true }),
                          );
                          setModal(null);
                        })
                      }
                    >
                      {t('Delete segment')}
                    </button>
                  )}
                  <button className="primary" type="submit">
                    {t('Save transcript')}
                  </button>
                </div>
              </form>
            ) : modal?.kind === 'template' ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  guard(async () => {
                    const item = {
                      id: crypto.randomUUID(),
                      name: modal.name,
                      prompt: modal.prompt,
                    };
                    await setting('templates', [...(data.settings.templates ?? []), item]);
                    await load();
                    setModal(null);
                  });
                }}
              >
                <label className="field">
                  {t('Name')}
                  <input
                    required
                    maxLength={100}
                    value={modal.name}
                    onChange={(e) => setModal({ ...modal, name: e.target.value })}
                  />
                </label>
                <label className="field">
                  {t('Instructions')}
                  <textarea
                    required
                    rows={6}
                    value={modal.prompt}
                    onChange={(e) => setModal({ ...modal, prompt: e.target.value })}
                    placeholder={t('What should Stillnote focus on?')}
                  />
                </label>
                <div className="modal-footer">
                  <button className="primary" type="submit">
                    {t('Save template')}
                  </button>
                </div>
              </form>
            ) : modal?.kind === 'confirm' ? (
              <div className="confirm-body">
                <p>{modal.message}</p>
                <div className="modal-footer">
                  <button className="secondary" onClick={() => setModal(null)}>
                    {t('Cancel')}
                  </button>
                  <button
                    autoFocus
                    className={'primary' + (modal.destructive ? ' destructive' : '')}
                    onClick={() => {
                      const run = modal.onConfirm;
                      setModal(null);
                      run();
                    }}
                  >
                    {modal.confirmLabel}
                  </button>
                </div>
              </div>
            ) : modal?.kind === 'history' ? (
              <div className="history-list">
                {meeting?.versions.map((v, i) => (
                  <div className="history-item" key={i}>
                    <div>
                      <strong>
                        {date(v.at, t.locale)} · {time(v.at, t.locale)}
                      </strong>
                      <button
                        className="text-button"
                        onClick={() =>
                          guard(async () => {
                            if (!(await patch({ summary: v.text, snapshotSummary: true }))) return;
                            setModal(null);
                          })
                        }
                      >
                        {t('Restore this version')}
                      </button>
                    </div>
                    <Rich text={v.text} />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </dialog>
      </div>
    </I18nProvider>
  );
}
createRoot(document.getElementById('root')).render(<App />);
