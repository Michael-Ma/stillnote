import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft, Check, Home, Leaf, Plus, Square, X } from 'lucide-react';
import { IconButton, Rich } from './components/Content.jsx';
import { HomeFeed } from './components/HomeFeed.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { NoteToolbar, NoteView } from './components/NoteView.jsx';
import { EnhancePill, RecordPill } from './components/Dock.jsx';
import { TranscriptSheet } from './components/TranscriptSheet.jsx';
import { ChatPanel } from './components/ChatPanel.jsx';
import { SettingsDialog } from './components/SettingsDialog.jsx';
import { aiView, claudeModels, modelKey } from './ai-view.mjs';
import { meetingForEvent } from './reminders.mjs';
import { cleanError, date, time, duration, silentState } from './format.mjs';
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
    [partial, setPartial] = useState({}),
    [accountBusy, setAccountBusy] = useState(false),
    [chatgptModels, setChatgptModels] = useState([]),
    [calendarBusy, setCalendarBusy] = useState(false),
    [editingSummary, setEditingSummary] = useState(false),
    [elapsed, setElapsed] = useState(0),
    [audioLevels, setAudioLevels] = useState({}),
    [captureSources, setCaptureSources] = useState({}),
    [retryingRecording, setRetryingRecording] = useState(null),
    [saving, setSaving] = useState(false),
    [drafts, setDrafts] = useState({});
  const draftRef = useRef({}),
    timers = useRef({}),
    dialogRef = useRef(),
    searchRef = useRef(),
    busyRef = useRef(null),
    current = useRef({}),
    backdropDown = useRef(false),
    aiRequest = useRef({}),
    answerContexts = useRef(new Map()),
    messagesRequest = useRef(0);
  const error = errorState?.message ?? '';
  const setError = (message, permission) =>
    setErrorState(message ? { message: cleanError(message), owner: 'external', permission } : null);
  current.current = { selected, view, recording: data?.recording };
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
        } else setNotice({ text: 'Enhancing your recorded note.', id: e.id });
        setStream('');
      }
      if (e.type === 'ai-done' && busyRef.current === 'auto-enhance') {
        busyRef.current = null;
        setBusy(null);
        setStream('');
      }
      if (e.type === 'ai') setData((d) => (d ? { ...d, ai: e.ai } : d));
      if (e.type === 'meeting') updateMeeting(e.meeting);
      if (e.type === 'calendar') setData((d) => (d ? { ...d, calendar: e.events } : d));
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
        setAudioLevels((levels) => ({ ...levels, [e.source]: { ...e, receivedAt: Date.now() } }));
      if (e.type === 'recording-status') {
        if (e.recording) setData((d) => (d ? { ...d, recording: e.recording } : d));
        if (e.recording?.sources) setCaptureSources(e.recording.sources);
        else if (e.source) setCaptureSources((sources) => ({ ...sources, [e.source]: e }));
      }
      const recordingId = current.current.recording?.recordingId;
      setSilent((s) => silentState(s, e, recordingId));
      if (e.type === 'device-changed' && e.recordingId === current.current.recording?.recordingId) {
        setNotice(`Microphone changed to ${e.device.name}.`);
        setCaptureSources((sources) => ({
          ...sources,
          microphone: { ...sources.microphone, device: e.device },
        }));
      }
      if (e.type === 'started') {
        setAudioLevels({});
        setCaptureSources(e.recording?.sources ?? {});
      }
      if (['started', 'stopped'].includes(e.type) || (e.type === 'error' && 'recording' in e)) {
        current.current.recording = e.recording;
        setData((d) => (d ? { ...d, recording: e.recording, starting: false } : d));
      }
      if (e.type === 'partial') setPartial((p) => ({ ...p, [e.segmentId || e.speaker]: e }));
      if (e.type === 'segment')
        setPartial((p) => {
          const n = { ...p };
          delete n[e.segmentId || e.speaker];
          return n;
        });
      if (e.type === 'stopped') setPartial({});
      if (e.type === 'error' || e.type === 'warning') {
        const message = cleanError(e.message);
        if (message === 'Stopped.' || message.startsWith('Timed out after 5 minutes.'))
          setNotice(cleanError(e.message, busyRef.current ? aiErrorOptions() : {}));
        else setError(message, e.permission);
      }
      if (e.type === 'ai-delta') setStream((s) => s + e.delta);
    });
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(t);
  }, [notice]);
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
  }, [query, data?.meetings]);
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
        newNote();
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
  function draft(patch) {
    const id = selected;
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
  async function newNote(input = {}) {
    // A calendar occurrence keeps one note: opening it again returns to that note.
    const existing = input.eventKey && meetingForEvent(data?.meetings, input.eventKey);
    if (existing) {
      await openNote(existing);
      return existing.id;
    }
    return guard(async () => {
      await flushAll();
      const m = await call('create', input);
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
    setStream('');
    await guard(async () => {
      try {
        await flushAll();
        if (aiRequest.current.stopped) return;
        aiRequest.current.startedAt = Date.now();
        await fn();
      } catch (e) {
        const message = cleanError(e, aiErrorOptions());
        if (message === 'Stopped.' || message.startsWith('Timed out after 5 minutes.'))
          setNotice(message);
        else throw e;
      } finally {
        busyRef.current = null;
        setBusy(null);
        setStream('');
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
      } else setNotice(`Imported ${r.restored} new meetings. Existing meetings were preserved.`);
    });
  }
  async function record(meetingId = selected) {
    await guard(async () => {
      await flushAll();
      setElapsed(0);
      setAudioLevels({});
      setCaptureSources({});
      const r = await call('record', meetingId);
      setData((d) => ({ ...d, recording: r, starting: true }));
      setTab('notes');
    });
  }
  async function retryRecording(recordingId) {
    if (retryingRecording) return;
    const meetingId = selected;
    setRetryingRecording(recordingId);
    try {
      await guard(async () => {
        await flushAll();
        const result = await call('transcribe-recording', meetingId, recordingId);
        const updated = result?.meeting ?? result;
        if (updated?.id) updateMeeting(updated);
        setNotice('Transcription finished. Review the transcript before enhancing your notes.');
      });
    } finally {
      setRetryingRecording(null);
    }
  }
  async function calendar() {
    setCalendarBusy(true);
    await guard(async () => {
      const events = await call('calendar');
      setData((d) => ({ ...d, calendar: events }));
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
              [m.title, m.notes, m.summary, ...m.transcript.map((s) => s.text)]
                .join(' ')
                .toLowerCase()
                .includes(query.toLowerCase())
            : searchIds?.includes(m.id),
        ) ?? [],
    [data?.meetings, view, searchIds, query],
  );
  const title =
    view === 'home'
      ? 'Home'
      : view === 'chat'
        ? 'Chat'
        : view === 'all'
          ? 'My notes'
          : view === 'starred'
            ? 'Starred'
            : view === 'trash'
              ? 'Trash'
              : (data?.folders.find((f) => f.id === view.slice(7))?.name ?? 'Notes');
  if (!data)
    return (
      <div className="loading">
        <Leaf size={28} />
        {loading ? (
          <p>Opening your notebook…</p>
        ) : (
          <>
            <p role="alert">{error || 'Your notebook could not be opened.'}</p>
            <button className="primary" onClick={() => guard(load)}>
              Retry
            </button>
          </>
        )}
      </div>
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
  const level = Math.max(
    ...['microphone', 'system'].map((s) =>
      audioLevels[s] && Date.now() - audioLevels[s].receivedAt < 3000
        ? Math.sqrt(Math.max(0, Number(audioLevels[s].rms) || 0))
        : 0,
    ),
  );
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
        ...(meeting ? [['meeting', 'This meeting']] : []),
        ...(view.startsWith('folder:') ? [['folder', 'This folder']] : []),
        ['all', 'All my notes'],
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
        if (target) openNote(target, 'transcript').then(() => setView('all'));
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
                setNotice('Enhanced notes updated. The previous version is saved.');
              })
          : null
      }
    />
  );
  return (
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
                  aria-label="Back to Home"
                >
                  <ArrowLeft size={14} />
                  <Home size={14} />
                </button>
                <span className="save-state" aria-live="polite">
                  {saving ? (
                    'Saving…'
                  ) : Object.keys(drafts[selected] ?? {}).length ? (
                    'Unsaved'
                  ) : (
                    <>
                      <Check size={12} />
                      Saved
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
                    ? 'Finishing…'
                    : data.starting
                      ? 'Connecting…'
                      : `Listening · ${duration(elapsed)}`}
                </span>
                <button
                  onClick={() => guard(() => call('stop'))}
                  aria-label="Finish active recording"
                  disabled={data.recording.stopping}
                >
                  <Square size={10} fill="currentColor" />
                  Finish
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
                onExport={() =>
                  guard(async () => {
                    await flushAll();
                    const path = await call('export', selected);
                    if (path) setNotice(`Exported to ${path}`);
                  })
                }
              />
            ) : (
              <button className="quick-note" onClick={() => newNote()} aria-label="New note">
                <Plus size={14} />
                New note
              </button>
            )}
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            {errorState.permission === 'screen-recording' && (
              <button
                className="banner-action"
                onClick={() => guard(() => call('open-privacy', 'screen-recording'))}
              >
                Open Settings
              </button>
            )}
            <IconButton label="Dismiss error" className="small" onClick={() => setError('')}>
              <X size={14} />
            </IconButton>
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            <Check size={14} />
            {typeof notice === 'string' ? notice : notice.text}
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
                Open
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
                startMeeting={startMeeting}
                openNote={openNote}
                importFile={importFile}
                setQuery={setQuery}
              />
            )}
          </section>
          <div className={'dock-wrap' + (chatOpen ? ' capture-only' : '')}>
            {data.recording && (silent.microphone || silent.system) && (
              <div className="capture-warnings" role="status">
                {silent.microphone && (
                  <div className="capture-warning">
                    No sound from {silent.microphone}
                    <button className="text-button" onClick={() => settings('capture')}>
                      Change microphone
                    </button>
                  </div>
                )}
                {silent.system && <div className="capture-warning soft">No meeting audio yet</div>}
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
                    partial={partial}
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
                      retrying: retryingRecording,
                      locale: data.settings.locale ?? 'en-US',
                      autoLocales: data.settings.autoLocales,
                      disabled: !!data.recording || !!meeting.deletedAt || !!busy,
                    }}
                    onAddTranscript={() =>
                      setModal({ kind: 'transcript', text: '', speaker: 'Speaker' })
                    }
                    onEditSegment={(s) => setModal({ kind: 'segment', ...s })}
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
                  {meeting && !meeting.deletedAt && (
                    <RecordPill
                      recording={{ ...data.recording, starting: data.starting }}
                      active={activeRecord}
                      hasAudio={meeting.recordings?.length > 0 || meeting.transcript.length > 0}
                      elapsed={elapsed}
                      level={level}
                      sheetOpen={!!sheet}
                      disabled={!!data.recording || !!retryingRecording}
                      onStart={() => record()}
                      onStop={() => guard(() => call('stop'))}
                      onToggleSheet={() => setSheet((s) => (s ? null : 'transcript'))}
                    />
                  )}
                  <div className="dock-chat">
                    <button
                      className="dock-placeholder"
                      aria-label={meeting ? 'Chat with this meeting' : 'Chat with your notes'}
                      onClick={() => openChat()}
                    >
                      Ask anything
                      <kbd>⌘J</kbd>
                    </button>
                    <button
                      className="dock-recipe"
                      onClick={() => {
                        setQuestion(
                          meeting
                            ? 'Draft a concise follow-up email with the decisions and next steps.'
                            : 'List recent action items with their owners and due dates, citing the source meetings.',
                        );
                        openChat();
                      }}
                    >
                      <span className="slash" aria-hidden="true">
                        /
                      </span>
                      {meeting ? 'Write follow-up email' : 'List recent todos'}
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
                  settings: 'Settings',
                  folder: 'New folder',
                  transcript: 'Add a transcript',
                  segment: 'Edit transcript',
                  history: 'Previous summaries',
                  template: 'Create a template',
                }[modal?.kind]
              }
            </h2>
            <IconButton label="Close dialog" onClick={() => setModal(null)}>
              <X size={17} />
            </IconButton>
          </div>
          {error && (
            <div className="modal-error" role="alert">
              {error}
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
                    setNotice('Backup saved.');
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
                Folder name
                <input
                  autoFocus
                  required
                  maxLength={100}
                  value={modal.name}
                  onChange={(e) => setModal({ ...modal, name: e.target.value })}
                  placeholder="e.g. Customer conversations"
                />
              </label>
              <div className="modal-footer">
                <button className="primary" type="submit">
                  Create folder
                </button>
              </div>
            </form>
          ) : ['transcript', 'segment'].includes(modal?.kind) ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                guard(async () => {
                  const m =
                    modal.kind === 'segment'
                      ? await call('edit-segment', selected, modal.id, {
                          text: modal.text,
                          speaker: modal.speaker,
                        })
                      : await call('transcript', selected, {
                          text: modal.text,
                          speaker: modal.speaker,
                          timestamp: meeting.duration,
                        });
                  updateMeeting(m);
                  setModal(null);
                  setSheet('transcript');
                });
              }}
            >
              <label className="field">
                Speaker
                <input
                  value={modal.speaker}
                  onChange={(e) => setModal({ ...modal, speaker: e.target.value })}
                />
              </label>
              <label className="field">
                Transcript
                <textarea
                  autoFocus
                  required
                  rows={10}
                  value={modal.text}
                  onChange={(e) => setModal({ ...modal, text: e.target.value })}
                  placeholder="Paste what was said…"
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
                    Delete segment
                  </button>
                )}
                <button className="primary" type="submit">
                  Save transcript
                </button>
              </div>
            </form>
          ) : modal?.kind === 'template' ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                guard(async () => {
                  const item = { id: crypto.randomUUID(), name: modal.name, prompt: modal.prompt };
                  await setting('templates', [...(data.settings.templates ?? []), item]);
                  await load();
                  setModal(null);
                });
              }}
            >
              <label className="field">
                Name
                <input
                  required
                  maxLength={100}
                  value={modal.name}
                  onChange={(e) => setModal({ ...modal, name: e.target.value })}
                />
              </label>
              <label className="field">
                Instructions
                <textarea
                  required
                  rows={6}
                  value={modal.prompt}
                  onChange={(e) => setModal({ ...modal, prompt: e.target.value })}
                  placeholder="What should Stillnote focus on?"
                />
              </label>
              <div className="modal-footer">
                <button className="primary" type="submit">
                  Save template
                </button>
              </div>
            </form>
          ) : modal?.kind === 'history' ? (
            <div className="history-list">
              {meeting?.versions.map((v, i) => (
                <div className="history-item" key={i}>
                  <div>
                    <strong>
                      {date(v.at)} · {time(v.at)}
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
                      Restore this version
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
  );
}
createRoot(document.getElementById('root')).render(<App />);
