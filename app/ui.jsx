import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { IconButton, Rich } from './components/Content.jsx';
import { HomeFeed } from './components/HomeFeed.jsx';
import { date, time, duration } from './format.mjs';
import {
  Plus,
  Search,
  NotebookPen,
  Folder,
  Star,
  CalendarDays,
  Settings,
  ArrowUpRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Download,
  Upload,
  Mic,
  Square,
  Sparkles,
  MessageCircle,
  MoreHorizontal,
  Trash2,
  RotateCcw,
  X,
  Check,
  FileText,
  Headphones,
  Leaf,
  Command,
  ArrowLeft,
  Clock,
  Copy,
  History,
  SlidersHorizontal,
  LoaderCircle,
  StopCircle,
  BookOpen,
  Link,
  PanelRightClose,
  Home,
  Lock,
  Users,
  AudioLines,
} from 'lucide-react';
import './style.css';
const api = window.stillnote;
function App() {
  const [data, setData] = useState(null),
    [selected, setSelected] = useState(null),
    [view, setView] = useState('home'),
    [query, setQuery] = useState(''),
    [searchIds, setSearchIds] = useState(null),
    [tab, setTab] = useState('notes'),
    [error, setError] = useState(''),
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
    [models, setModels] = useState([]),
    [calendarBusy, setCalendarBusy] = useState(false),
    [editingSummary, setEditingSummary] = useState(false),
    [elapsed, setElapsed] = useState(0),
    [saving, setSaving] = useState(false),
    [drafts, setDrafts] = useState({});
  const draftRef = useRef({}),
    timers = useRef({}),
    dialogRef = useRef(),
    searchRef = useRef(),
    busyRef = useRef(null),
    bottomRef = useRef();
  const call = async (name, ...args) => api.call(name, ...args);
  const updateMeeting = (m) =>
    setData((d) => ({
      ...d,
      meetings: d.meetings.some((x) => x.id === m.id)
        ? d.meetings.map((x) => (x.id === m.id ? m : x))
        : [m, ...d.meetings],
    }));
  const guard = async (fn) => {
    setError('');
    try {
      return await fn();
    } catch (e) {
      setError(e.message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
      return null;
    }
  };
  const load = async () => {
    const d = await call('state');
    setData(d);
    if (d.startupError) setError(d.startupError);
    return d;
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
        setSelected(e.id);
        setTab('summary');
        setStream('');
      }
      if (e.type === 'ai-done' && busyRef.current === 'auto-enhance') {
        busyRef.current = null;
        setBusy(null);
        setStream('');
      }
      if (e.type === 'meeting') updateMeeting(e.meeting);
      if (['started', 'stopped'].includes(e.type) || (e.type === 'error' && 'recording' in e))
        setData((d) => (d ? { ...d, recording: e.recording, starting: false } : d));
      if (e.type === 'partial') setPartial((p) => ({ ...p, [e.speaker]: e }));
      if (e.type === 'segment')
        setPartial((p) => {
          const n = { ...p };
          delete n[e.speaker];
          return n;
        });
      if (e.type === 'stopped') setPartial({});
      if (e.type === 'error' || e.type === 'warning') setError(e.message);
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
        searchRef.current?.focus();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        newNote();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const rawMeeting = data?.meetings.find((m) => m.id === selected),
    meeting = rawMeeting ? { ...rawMeeting, ...drafts[selected] } : null;
  const scope =
    chatScope === 'meeting' && meeting
      ? `meeting:${meeting.id}`
      : view.startsWith('folder:') && chatScope === 'folder'
        ? view
        : 'all';
  useEffect(() => {
    let valid = true;
    if (chatOpen)
      guard(async () => {
        const rows = await call('messages', scope);
        if (valid) setMessages(rows);
      });
    return () => {
      valid = false;
    };
  }, [chatOpen, scope]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, stream]);
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
    await guard(async () => {
      await flushAll();
      const m = await call('create', input);
      updateMeeting(m);
      setSelected(m.id);
      setView('all');
      setQuery('');
      setTab('notes');
      setChatOpen(false);
    });
  }
  async function openNote(m) {
    await guard(async () => {
      await flushAll();
      setSelected(m.id);
      setTab(m.summary ? 'summary' : 'notes');
      setEditingSummary(false);
    });
  }
  async function navigate(v) {
    await guard(async () => {
      await flushAll();
      setView(v);
      setSelected(null);
      setQuery('');
      setChatOpen(false);
    });
  }
  async function account(action, id) {
    setAccountBusy(true);
    await guard(async () => {
      const account = await call('account', action, id);
      setData((d) => ({ ...d, account }));
      setModels([]);
      if (account.warning) setError(account.warning);
      if (account.sharing) {
        const models = await call('account', 'models');
        setModels(models);
      }
    });
    setAccountBusy(false);
  }
  async function settings() {
    setModal({ kind: 'settings' });
    if (data?.account.sharing) guard(async () => setModels(await call('account', 'models')));
  }
  async function setting(key, value) {
    const s = await call('setting', key, value);
    setData((d) => ({ ...d, settings: s }));
  }
  async function enhance() {
    if (busyRef.current) return;
    await guard(async () => {
      await flushAll();
      busyRef.current = 'enhance';
      setBusy('enhance');
      setStream('');
      setTab('summary');
      try {
        const r = await call('ai', { kind: 'enhance', id: selected });
        updateMeeting(r.meeting);
      } finally {
        setBusy(null);
        busyRef.current = null;
        setStream('');
      }
    });
  }
  async function ask(prompt = question) {
    if (busyRef.current || !prompt.trim()) return;
    await guard(async () => {
      await flushAll();
      const ids =
        chatScope === 'meeting' && selected
          ? [selected]
          : chatScope === 'folder' && view.startsWith('folder:')
            ? data.meetings
                .filter((m) => m.folderId === view.slice(7) && !m.deletedAt)
                .map((m) => m.id)
            : data.meetings.filter((m) => !m.deletedAt).map((m) => m.id);
      busyRef.current = 'chat';
      setBusy('chat');
      setStream('');
      try {
        const r = await call('ai', { kind: 'chat', ids, question: prompt, scope });
        setMessages(r.messages);
        setQuestion('');
      } finally {
        busyRef.current = null;
        setBusy(null);
        setStream('');
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
        setTab('transcript');
        setView('all');
      } else setNotice(`Imported ${r.restored} new meetings. Existing meetings were preserved.`);
    });
  }
  async function record() {
    await guard(async () => {
      await flushAll();
      setElapsed(0);
      const r = await call('record', selected);
      setData((d) => ({ ...d, recording: r, starting: true }));
      setTab('notes');
    });
  }
  async function calendar() {
    setCalendarBusy(true);
    await guard(async () => {
      const events = await call('calendar');
      setData((d) => ({ ...d, calendar: events }));
    });
    setCalendarBusy(false);
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
              : view === 'calendar'
                ? 'Your week'
                : view === 'recipes'
                  ? 'Recipes'
                  : (data?.folders.find((f) => f.id === view.slice(7))?.name ?? 'Notes');
  if (!data)
    return (
      <div className="loading">
        <Leaf size={32} />
        <p>Opening your notebook…</p>
      </div>
    );
  const activeRecord = data.recording?.id === selected;
  return (
    <div
      className={
        'app ' +
        (chatOpen ? 'chat-open ' : '') +
        (meeting ? 'meeting-open ' : '') +
        (chatOpen && !meeting ? 'chat-global' : '')
      }
    >
      <aside className="sidebar">
        <div className="window-space" />
        <label className="search">
          <Search size={15} />
          <input
            ref={searchRef}
            aria-label="Search notes"
            placeholder="Search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
              setChatOpen(false);
              if (!['home', 'all', 'trash'].includes(view) && !view.startsWith('folder:'))
                setView('all');
            }}
          />
          <kbd>⌘ K</kbd>
        </label>
        <nav aria-label="Notebook">
          <button
            className={view === 'home' && !chatOpen ? 'active' : ''}
            onClick={() => navigate('home')}
          >
            <Home size={16} />
            Home
          </button>
          <button
            className={view === 'chat' ? 'active' : ''}
            onClick={() => {
              guard(async () => {
                await flushAll();
                setSelected(null);
                setView('chat');
                setChatScope('all');
                setChatOpen(true);
              });
            }}
          >
            <MessageCircle size={16} />
            Chat
          </button>
          <button
            className={view === 'starred' ? 'active' : ''}
            onClick={() => navigate('starred')}
          >
            <Star size={16} />
            Starred
          </button>
        </nav>
        <div className="nav-label">
          Spaces
          <IconButton label="New folder" onClick={() => setModal({ kind: 'folder', name: '' })}>
            <Plus size={14} />
          </IconButton>
        </div>
        <nav aria-label="Folders">
          <button
            className={'my-notes ' + (view === 'all' ? 'active' : '')}
            onClick={() => navigate('all')}
          >
            <span className="space-icon">
              <Lock size={14} />
            </span>
            My notes
          </button>
          {data.folders.map((f) => (
            <button
              key={f.id}
              className={'folder-item ' + (view === `folder:${f.id}` ? 'active' : '')}
              onClick={() => navigate(`folder:${f.id}`)}
            >
              <Folder size={15} fill="currentColor" />
              <span className="folder-name">{f.name}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tools">
            <IconButton label="Import transcript or backup" onClick={importFile}>
              <Upload size={16} />
            </IconButton>
            <IconButton label="Trash" onClick={() => navigate('trash')}>
              <Trash2 size={16} />
            </IconButton>
            <IconButton label="Settings" onClick={settings}>
              <Settings size={16} />
            </IconButton>
          </div>
          <button className="account-pill" onClick={settings}>
            <span className="brand-mark">
              <NotebookPen size={17} />
            </span>
            <strong>Stillnote</strong>
            <span className="account-local">Local</span>
            <ChevronDown size={13} />
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            {meeting ? (
              <button
                className="home-back"
                onClick={() => navigate('home')}
                aria-label="Back to Home"
              >
                <ArrowLeft size={15} />
                <Home size={15} />
              </button>
            ) : (
              <span className="workspace-label">{view === 'home' ? '' : title}</span>
            )}
          </div>
          <div className="top-actions">
            {data.recording && (
              <div className="global-recording" role="status">
                <span className="record-dot" />
                <span>{data.starting ? 'Connecting…' : `Listening · ${duration(elapsed)}`}</span>
                <button
                  onClick={() => guard(() => call('stop'))}
                  aria-label="Finish active recording"
                >
                  <Square size={11} fill="currentColor" />
                  Finish
                </button>
              </div>
            )}
            {meeting && (
              <span className="top-save">{saving ? 'Saving…' : 'Saved on this Mac'}</span>
            )}
            <button className="quick-note" onClick={() => newNote()} aria-label="New note">
              <Plus size={14} />
              Quick note
            </button>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <IconButton label="Dismiss error" onClick={() => setError('')}>
              <X size={16} />
            </IconButton>
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            <Check size={15} />
            {notice}
          </div>
        )}
        <div className="workspace-body">
          <section className="main-content">
            {view === 'calendar' ? (
              <div className="page">
                <p className="eyebrow">MAKE ROOM TO LISTEN</p>
                <h1>Your week, in focus.</h1>
                <p className="subhead">Bring upcoming meetings from the calendars on your Mac.</p>
                <button className="primary" disabled={calendarBusy} onClick={calendar}>
                  {calendarBusy ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <CalendarDays size={17} />
                  )}{' '}
                  {calendarBusy
                    ? 'Loading calendars…'
                    : data.calendar.length
                      ? 'Refresh calendar'
                      : 'Connect Mac calendars'}
                </button>
                <p className="muted small">
                  Includes Google and Outlook accounts added to Apple Calendar. Read access only.
                  Reminders appear while Stillnote is open.
                </p>
                <div className="calendar-list">
                  {data.calendar.map((e) => (
                    <button
                      className="event-row"
                      key={e.id}
                      onClick={() =>
                        newNote({
                          title: e.title,
                          participants: e.participants,
                          notes: e.notes ? `Meeting context\n${e.notes}` : '',
                        })
                      }
                    >
                      <div className="event-date">
                        <strong>{date(e.start)}</strong>
                        <small>{time(e.start)}</small>
                      </div>
                      <div>
                        <h3>{e.title}</h3>
                        <p>{e.participants || e.location || 'Calendar event'}</p>
                      </div>
                      <Plus size={18} />
                    </button>
                  ))}
                </div>
              </div>
            ) : view === 'recipes' ? (
              <div className="page">
                <p className="eyebrow">A LITTLE HELP THINKING</p>
                <h1>Go beyond the recap.</h1>
                <p className="subhead">
                  Turn your conversations into something useful. Every recipe uses the notes you
                  choose.
                </p>
                <div className="recipe-grid">
                  {data.recipes.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => {
                        setChatScope('all');
                        setChatOpen(true);
                        setQuestion(r.prompt);
                      }}
                    >
                      <Sparkles size={21} />
                      <h3>{r.name}</h3>
                      <p>{r.prompt}</p>
                      <span>
                        Use recipe <ArrowUpRight size={14} />
                      </span>
                    </button>
                  ))}
                </div>
                <button
                  className="secondary"
                  onClick={() => setModal({ kind: 'recipe', name: '', prompt: '' })}
                >
                  <Plus size={16} />
                  Create a recipe
                </button>
              </div>
            ) : meeting ? (
              <div className="editor">
                <div className="editor-toolbar">
                  <div>
                    <span className="note-date">
                      {date(meeting.createdAt)} · {time(meeting.createdAt)}
                    </span>
                    {saving ? (
                      <span className="save-state">Saving…</span>
                    ) : Object.keys(drafts[selected] ?? {}).length ? (
                      <span className="save-state">Unsaved changes</span>
                    ) : (
                      <span className="save-state">
                        <Check size={12} />
                        Saved
                      </span>
                    )}
                  </div>
                  <div className="toolbar-actions">
                    <IconButton
                      label={meeting.starred ? 'Unstar note' : 'Star note'}
                      onClick={() => patch({ starred: !meeting.starred })}
                    >
                      <Star size={16} fill={meeting.starred ? 'currentColor' : 'none'} />
                    </IconButton>
                    <IconButton
                      label="Export Markdown"
                      onClick={() =>
                        guard(async () => {
                          await flushAll();
                          const path = await call('export', selected);
                          if (path) setNotice(`Exported to ${path}`);
                        })
                      }
                    >
                      <Download size={17} />
                    </IconButton>
                    {meeting.deletedAt ? (
                      <IconButton label="Restore note" onClick={() => patch({ deletedAt: null })}>
                        <RotateCcw size={17} />
                      </IconButton>
                    ) : (
                      <IconButton
                        label="Move to Trash"
                        disabled={activeRecord}
                        onClick={() => patch({ deletedAt: true })}
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    )}
                  </div>
                </div>
                <input
                  className="note-title"
                  aria-label="Meeting title"
                  value={meeting.title}
                  onChange={(e) => draft({ title: e.target.value })}
                  maxLength={300}
                  placeholder="Untitled meeting"
                />
                <div className="meeting-meta">
                  <label className="participants">
                    <span>With</span>
                    <input
                      aria-label="Participants"
                      placeholder="Add participants…"
                      value={meeting.participants}
                      onChange={(e) => draft({ participants: e.target.value })}
                    />
                  </label>
                  <label className="folder-select">
                    <Folder size={14} />
                    <select
                      aria-label="Move note to folder"
                      value={meeting.folderId ?? ''}
                      onChange={(e) => patch({ folderId: e.target.value || null })}
                    >
                      <option value="">No folder</option>
                      {data.folders.map((f) => (
                        <option value={f.id} key={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {meeting.deletedAt && (
                  <div className="inline-note">
                    This note is in Trash.{' '}
                    <button className="text-button" onClick={() => patch({ deletedAt: null })}>
                      Restore it
                    </button>
                  </div>
                )}
                <div className="tabs">
                  <div role="tablist">
                    {[
                      ['notes', 'My notes'],
                      ['summary', 'Enhanced'],
                      ['transcript', 'Transcript'],
                    ].map(([key, label]) => (
                      <button
                        key={key}
                        role="tab"
                        aria-selected={tab === key}
                        className={tab === key ? 'active' : ''}
                        onClick={() => setTab(key)}
                      >
                        {label}
                        {key === 'transcript' && meeting.transcript.length > 0 && (
                          <span>{meeting.transcript.length}</span>
                        )}
                      </button>
                    ))}
                  </div>
                  {tab !== 'transcript' && (
                    <button
                      className="enhance-button"
                      disabled={!!busy || activeRecord || !!meeting.deletedAt}
                      onClick={enhance}
                    >
                      {busy === 'enhance' ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <Sparkles size={14} />
                      )}
                      Enhance notes
                    </button>
                  )}
                </div>
                <div className="document-body">
                  {tab === 'notes' ? (
                    <>
                      <textarea
                        className="note-editor"
                        aria-label="My notes"
                        placeholder="Add your thoughts…"
                        value={meeting.notes}
                        onChange={(e) => draft({ notes: e.target.value })}
                      />
                    </>
                  ) : tab === 'summary' ? (
                    <>
                      <div className="summary-tools">
                        <label>
                          <SlidersHorizontal size={14} />
                          <select
                            aria-label="Summary template"
                            value={meeting.templateId}
                            onChange={(e) => patch({ templateId: e.target.value })}
                          >
                            {data.templates.map((t) => (
                              <option value={t.id} key={t.id}>
                                {t.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div>
                          {meeting.versions.length > 0 && (
                            <IconButton
                              label="Previous summaries"
                              onClick={() => setModal({ kind: 'history' })}
                            >
                              <History size={15} />
                            </IconButton>
                          )}
                          {meeting.summary && (
                            <button
                              className="text-button"
                              onClick={() => setEditingSummary(!editingSummary)}
                            >
                              {editingSummary ? 'Done editing' : 'Edit'}
                            </button>
                          )}
                        </div>
                      </div>
                      {busy === 'enhance' ? (
                        <>
                          <div className="thinking">
                            <Sparkles size={15} />
                            Connecting the dots…
                            <button
                              className="text-button"
                              onClick={() => guard(() => call('cancel-ai'))}
                            >
                              Cancel
                            </button>
                          </div>
                          <Rich text={stream} />
                        </>
                      ) : editingSummary ? (
                        <textarea
                          className="note-editor"
                          aria-label="Edit enhanced notes"
                          value={meeting.summary}
                          onChange={(e) => draft({ summary: e.target.value })}
                        />
                      ) : meeting.summary ? (
                        <Rich text={meeting.summary} onSource={() => setTab('transcript')} />
                      ) : (
                        <div className="document-empty">
                          <div className="empty-icon">
                            <Sparkles size={28} />
                          </div>
                          <h2>A clearer picture.</h2>
                          <p>
                            Bring your notes and transcript together into an overview, decisions,
                            and next steps.
                          </p>
                          <button
                            className="primary"
                            disabled={!!busy || activeRecord}
                            onClick={enhance}
                          >
                            <Sparkles size={16} />
                            Enhance notes
                          </button>
                          <small>Uses your connected ChatGPT plan.</small>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="transcript-top">
                        <span>
                          {meeting.transcript.length} segments · {Math.ceil(meeting.duration / 60)}{' '}
                          min recorded
                        </span>
                        <button
                          className="text-button"
                          onClick={() =>
                            setModal({ kind: 'transcript', text: '', speaker: 'Speaker' })
                          }
                        >
                          <Plus size={14} />
                          Add transcript
                        </button>
                      </div>
                      {!meeting.transcript.length && !activeRecord && (
                        <div className="document-empty">
                          <div className="empty-icon">
                            <Mic size={26} />
                          </div>
                          <h2>Every detail, in its place.</h2>
                          <p>
                            Start recording or paste an existing transcript. Speaker labels can be
                            edited afterward.
                          </p>
                          <button
                            className="secondary"
                            onClick={() =>
                              setModal({ kind: 'transcript', text: '', speaker: 'Speaker' })
                            }
                          >
                            Paste a transcript
                          </button>
                        </div>
                      )}
                      {meeting.transcript.map((s) => (
                        <div className="transcript-segment" key={s.id}>
                          <div>
                            <strong>{s.speaker}</strong>
                            <time>{duration(s.timestamp)}</time>
                            <button
                              className="text-button segment-edit"
                              onClick={() => setModal({ kind: 'segment', ...s })}
                            >
                              Edit
                            </button>
                          </div>
                          <p>{s.text}</p>
                        </div>
                      ))}
                      {activeRecord &&
                        Object.values(partial).map((s) => (
                          <div className="transcript-segment live" key={s.speaker}>
                            <div>
                              <strong>{s.speaker}</strong>
                              <span className="live-label">LIVE</span>
                            </div>
                            <p>{s.text}</p>
                          </div>
                        ))}
                    </>
                  )}
                </div>
              </div>
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
                openNote={openNote}
                importFile={importFile}
                setQuery={setQuery}
              />
            )}
          </section>
          {!chatOpen && (
            <div className="floating-dock-wrap">
              {activeRecord && (
                <div className="recording-status">
                  <span className="record-dot" />
                  {data.starting
                    ? 'Waiting for permissions…'
                    : `${duration(elapsed)} · ${data.recording.systemAudio ? 'Mic + meeting audio' : 'Microphone'}`}
                  <button onClick={() => guard(() => call('stop'))}>
                    <Square size={11} fill="currentColor" />
                    Finish meeting
                  </button>
                </div>
              )}
              <div className="floating-dock">
                {meeting && !meeting.deletedAt && (
                  <button
                    className={'record-orb ' + (activeRecord ? 'recording' : '')}
                    aria-label={activeRecord ? 'Stop recording' : 'Start recording'}
                    title={activeRecord ? 'Stop recording' : 'Start recording on this Mac'}
                    disabled={!activeRecord && !!data.recording}
                    onClick={() => (activeRecord ? guard(() => call('stop')) : record())}
                  >
                    {activeRecord ? (
                      <Square size={17} fill="currentColor" />
                    ) : (
                      <AudioLines size={21} />
                    )}
                  </button>
                )}
                <div className="dock-chat">
                  <button
                    className="dock-placeholder"
                    onClick={() => {
                      setChatScope(
                        meeting ? 'meeting' : view.startsWith('folder:') ? 'folder' : 'all',
                      );
                      setChatOpen(true);
                    }}
                  >
                    {meeting ? 'Chat with this meeting' : 'Chat with your notes'}
                    <kbd>⌘ J</kbd>
                  </button>
                  <button
                    className="dock-recipe"
                    onClick={() => {
                      setChatScope(
                        meeting ? 'meeting' : view.startsWith('folder:') ? 'folder' : 'all',
                      );
                      setQuestion(
                        meeting
                          ? 'Draft a concise follow-up email with the decisions and next steps.'
                          : 'List recent action items with their owners and due dates, citing the source meetings.',
                      );
                      setChatOpen(true);
                    }}
                  >
                    <Sparkles size={13} />
                    {meeting ? 'Write follow-up email' : 'List recent to-dos'}
                  </button>
                </div>
              </div>
            </div>
          )}
          {chatOpen && (
            <aside className="chat-panel">
              <header>
                <div>
                  <Sparkles size={18} />
                  <h2>Ask your notes</h2>
                </div>
                <IconButton
                  label="Close chat"
                  onClick={() => {
                    setChatOpen(false);
                    if (view === 'chat') setView('home');
                  }}
                >
                  <PanelRightClose size={17} />
                </IconButton>
              </header>
              <div className="scope-picker">
                <span>LOOKING AT</span>
                <select
                  aria-label="Chat scope"
                  disabled={!!busy}
                  value={chatScope}
                  onChange={(e) => setChatScope(e.target.value)}
                >
                  {meeting && <option value="meeting">This meeting</option>}
                  {view.startsWith('folder:') && <option value="folder">This folder</option>}
                  <option value="all">All my notes</option>
                </select>
              </div>
              <div className="chat-messages">
                {!messages.length && !busy && (
                  <div className="chat-intro">
                    <span className="chat-spark">
                      <Sparkles size={28} />
                    </span>
                    <h3>What’s on your mind?</h3>
                    <p>Ask anything about your meetings.</p>
                    {[
                      'What did we decide?',
                      'What should I follow up on?',
                      'Draft a follow-up email.',
                    ].map((q) => (
                      <button key={q} onClick={() => setQuestion(q)}>
                        {q}
                        <ArrowUpRight size={13} />
                      </button>
                    ))}
                  </div>
                )}
                {messages.map((m) => (
                  <div className={'chat-message ' + m.role} key={m.id}>
                    <div className="message-role">{m.role === 'user' ? 'YOU' : 'STILLNOTE'}</div>
                    <Rich
                      text={m.content}
                      onSource={(number) => {
                        const source = m.sources?.find((s) => s.number === number);
                        const target = data.meetings.find((n) => n.id === source?.id);
                        if (target)
                          guard(async () => {
                            await flushAll();
                            setSelected(target.id);
                            setView('all');
                            setTab('transcript');
                          });
                      }}
                    />
                    {m.role === 'assistant' && chatScope === 'meeting' && meeting && (
                      <button
                        className="text-button apply-answer"
                        onClick={() =>
                          guard(async () => {
                            await patch({ summary: m.content });
                            setTab('summary');
                            setNotice('Enhanced notes updated. The previous version is saved.');
                          })
                        }
                      >
                        Use as enhanced notes
                      </button>
                    )}
                    {m.sources?.length > 0 && (
                      <div className="sources">
                        {m.sources.map((s) => (
                          <button
                            key={s.id}
                            onClick={() => {
                              const m = data.meetings.find((m) => m.id === s.id);
                              if (m) {
                                openNote(m);
                                setView('all');
                              }
                            }}
                          >
                            [{s.number}] {s.title}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {busy === 'chat' && (
                  <div className="chat-message assistant">
                    <div className="thinking">
                      <Sparkles size={14} />
                      {stream ? 'Stillnote' : 'Reading your notes…'}
                    </div>
                    <Rich text={stream} />
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
              <form
                className="chat-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  ask();
                }}
              >
                <textarea
                  aria-label="Ask a question"
                  placeholder="Ask anything about your notes…"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      ask();
                    }
                  }}
                />
                <div>
                  <span>
                    {data.account.sharing
                      ? 'Using your ChatGPT plan'
                      : 'Connect ChatGPT in Settings'}
                  </span>
                  {busy ? (
                    <IconButton
                      label="Stop response"
                      onClick={() => guard(() => call('cancel-ai'))}
                    >
                      <Square size={14} />
                    </IconButton>
                  ) : (
                    <button
                      className="send-button"
                      type="submit"
                      disabled={!question.trim()}
                      aria-label="Send question"
                    >
                      <ArrowUp size={18} />
                    </button>
                  )}
                </div>
              </form>
              <p className="chat-disclaimer">Check important details against the transcript.</p>
            </aside>
          )}
        </div>
      </main>
      <dialog
        ref={dialogRef}
        onCancel={() => setModal(null)}
        onClick={(e) => {
          if (e.target === dialogRef.current) setModal(null);
        }}
        aria-labelledby="modal-title"
      >
        <div className="modal-inner">
          <div className="modal-header">
            <h2 id="modal-title">
              {
                {
                  settings: 'Make yourself at home.',
                  folder: 'A place for your notes',
                  transcript: 'Add a transcript',
                  segment: 'Edit transcript',
                  history: 'Previous summaries',
                  recipe: 'Create a recipe',
                  template: 'Create a template',
                }[modal?.kind]
              }
            </h2>
            <IconButton label="Close dialog" onClick={() => setModal(null)}>
              <X size={19} />
            </IconButton>
          </div>
          {error && (
            <div className="modal-error" role="alert">
              {error}
            </div>
          )}
          {modal?.kind === 'settings' ? (
            <div className="settings-body">
              <section>
                <p className="eyebrow">CHATGPT CONNECTION</p>
                <div className="connection-box">
                  <div>
                    <strong>{data.account.email ?? 'Bring your ChatGPT plan'}</strong>
                    <p>
                      {data.account.sharing
                        ? 'Connected · ChatGPT plan usage enabled'
                        : 'Sign in to generate notes and ask questions. No API key.'}
                    </p>
                  </div>
                  {accountBusy ? (
                    <button
                      className="secondary"
                      onClick={() => guard(() => call('account', 'cancel'))}
                    >
                      Cancel sign-in
                    </button>
                  ) : (
                    <button className="primary" onClick={() => account('connect')}>
                      {data.account.connected ? 'Reconnect' : 'Continue with ChatGPT'}
                      <ArrowUpRight size={15} />
                    </button>
                  )}
                </div>
                <p className="muted small">
                  Selected notes and transcripts are sent to OpenAI when you use AI. Audio stays on
                  your Mac. Eligibility and your ChatGPT plan limits apply.
                </p>
                {data.account.profiles.length > 0 && (
                  <div className="setting-row">
                    <label htmlFor="profile">Account</label>
                    <select
                      id="profile"
                      disabled={accountBusy}
                      value={data.account.active ?? ''}
                      onChange={(e) => account('select', e.target.value)}
                    >
                      {data.account.profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label} · {p.email ?? 'Pending registration'}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {data.account.connected && (
                  <div className="connection-actions">
                    <button className="text-button" onClick={() => guard(() => call('usage'))}>
                      Manage usage <ArrowUpRight size={13} />
                    </button>
                    <button
                      className="text-button"
                      disabled={accountBusy}
                      onClick={() => account('add')}
                    >
                      Add account
                    </button>
                    <button
                      className="text-button"
                      disabled={accountBusy}
                      onClick={() => account('disconnect')}
                    >
                      Sign out
                    </button>
                  </div>
                )}
                {data.account.sharing && (
                  <div className="setting-row">
                    <label htmlFor="model">Model</label>
                    <select
                      id="model"
                      value={data.settings.model ?? models[0]?.id ?? ''}
                      onChange={(e) => guard(() => setting('model', e.target.value))}
                    >
                      {models.length ? (
                        models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))
                      ) : (
                        <option value="">Loading account models…</option>
                      )}
                    </select>
                  </div>
                )}
              </section>
              <section>
                <p className="eyebrow">CAPTURE</p>
                <div className="setting-row">
                  <div>
                    <label htmlFor="locale">Meeting language</label>
                    <small>Requires the on-device language on your Mac.</small>
                  </div>
                  <select
                    id="locale"
                    value={data.settings.locale ?? 'en-US'}
                    onChange={(e) => guard(() => setting('locale', e.target.value))}
                  >
                    {[
                      ['en-US', 'English (US)'],
                      ['en-GB', 'English (UK)'],
                      ['zh-CN', '中文（普通话）'],
                      ['zh-TW', '中文（台灣）'],
                      ['es-ES', 'Español'],
                      ['fr-FR', 'Français'],
                      ['de-DE', 'Deutsch'],
                      ['ja-JP', '日本語'],
                      ['ko-KR', '한국어'],
                      ['pt-BR', 'Português'],
                    ].map(([v, n]) => (
                      <option key={v} value={v}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="setting-row">
                  <div>
                    <label htmlFor="systemAudio">Capture meeting audio</label>
                    <small>Transcribe other apps alongside your microphone.</small>
                  </div>
                  <input
                    id="systemAudio"
                    type="checkbox"
                    checked={data.settings.systemAudio ?? true}
                    onChange={(e) => guard(() => setting('systemAudio', e.target.checked))}
                  />
                </div>
                <div className="setting-row">
                  <div>
                    <label htmlFor="autoEnhance">Enhance when the meeting ends</label>
                    <small>Use your ChatGPT plan automatically after recording.</small>
                  </div>
                  <input
                    id="autoEnhance"
                    type="checkbox"
                    checked={data.settings.autoEnhance ?? true}
                    onChange={(e) => guard(() => setting('autoEnhance', e.target.checked))}
                  />
                </div>
                <p className="muted small">
                  Microphone and meeting audio receive separate labels. Individual remote speakers
                  are not automatically identified. Let participants know when you transcribe.
                </p>
              </section>
              <section>
                <p className="eyebrow">YOUR NOTEBOOK</p>
                <div className="settings-buttons">
                  <button
                    className="secondary"
                    onClick={() =>
                      guard(async () => {
                        await flushAll();
                        const p = await call('backup');
                        if (p) {
                          setNotice('Backup saved.');
                          setModal(null);
                        }
                      })
                    }
                  >
                    <Download size={15} />
                    Back up notebook
                  </button>
                  <button className="secondary" onClick={() => guard(() => call('reveal'))}>
                    <Folder size={15} />
                    Open data folder
                  </button>
                  <button
                    className="secondary"
                    onClick={() => setModal({ kind: 'template', name: '', prompt: '' })}
                  >
                    <Plus size={15} />
                    Custom template
                  </button>
                </div>
                <p className="muted small">
                  SQLite storage. Backups include your meetings, transcripts and chat history.
                  Account credentials are excluded. Import merges new meetings without replacing
                  existing ones.
                </p>
              </section>
            </div>
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
              <button className="primary" type="submit">
                Create folder
              </button>
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
                  setTab('transcript');
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
                <button className="primary" type="submit">
                  Save transcript
                </button>
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
              </div>
            </form>
          ) : ['recipe', 'template'].includes(modal?.kind) ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                guard(async () => {
                  const key = modal.kind === 'recipe' ? 'recipes' : 'templates';
                  const item = { id: crypto.randomUUID(), name: modal.name, prompt: modal.prompt };
                  await setting(key, [...(data.settings[key] ?? []), item]);
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
              <button className="primary" type="submit">
                Save {modal.kind}
              </button>
            </form>
          ) : modal?.kind === 'history' ? (
            <div>
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
                          await patch({ summary: v.text });
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
