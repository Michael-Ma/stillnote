import React, { useMemo } from 'react';
import {
  CalendarDays,
  Download,
  Folder,
  History,
  LoaderCircle,
  NotebookPen,
  RotateCcw,
  Sparkles,
  Star,
  Trash2,
  Users,
} from 'lucide-react';
import { IconButton, Rich } from './Content.jsx';
import { AiConnect } from './AiConnect.jsx';
import { CoverageWarning } from './RecordingAudio.jsx';
import { ownLineMatcher } from '../own-lines.mjs';
import { date } from '../format.mjs';

// Granola's top-right switch between the user's notes and the enhanced version.
export function NoteToolbar({ meeting, tab, setTab, templates, patch, activeRecord, onExport }) {
  return (
    <div className="note-toolbar">
      <div className="view-switch" role="tablist" aria-label="Note view">
        <button
          role="tab"
          aria-selected={tab === 'notes'}
          className={tab === 'notes' ? 'active' : ''}
          onClick={() => setTab('notes')}
          title="My notes"
        >
          <NotebookPen size={14} />
          <span>My notes</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === 'summary'}
          className={tab === 'summary' ? 'active' : ''}
          onClick={() => setTab('summary')}
          title="Enhanced notes"
        >
          <Sparkles size={14} />
          <span>Enhanced</span>
        </button>
      </div>
      <select
        className="chip-select template-select"
        aria-label="Summary template"
        value={meeting.templateId}
        onChange={(e) => patch({ templateId: e.target.value })}
      >
        {templates.map((t) => (
          <option value={t.id} key={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <span className="toolbar-divider" />
      <IconButton
        label={meeting.starred ? 'Unstar note' : 'Star note'}
        onClick={() => patch({ starred: !meeting.starred })}
        className={meeting.starred ? 'starred' : ''}
      >
        <Star size={15} fill={meeting.starred ? 'currentColor' : 'none'} />
      </IconButton>
      <IconButton label="Export Markdown" onClick={onExport}>
        <Download size={15} />
      </IconButton>
      {meeting.deletedAt ? (
        <IconButton label="Restore note" onClick={() => patch({ deletedAt: null })}>
          <RotateCcw size={15} />
        </IconButton>
      ) : (
        <IconButton
          label="Move to Trash"
          disabled={activeRecord}
          onClick={() => patch({ deletedAt: true })}
        >
          <Trash2 size={15} />
        </IconButton>
      )}
    </div>
  );
}

export function NoteView({
  meeting,
  folders,
  tab,
  draft,
  patch,
  busy,
  stream,
  editingSummary,
  setEditingSummary,
  onEnhance,
  enhanceDisabled,
  onCancel,
  showCancel,
  onHistory,
  onSource,
  coverage,
  activeRecord,
  ai,
  aiActions,
}) {
  const isOwn = useMemo(() => ownLineMatcher(meeting.notes), [meeting.notes]);
  const enhancing = busy === 'enhance';
  return (
    <article className="note">
      <input
        className="note-title"
        aria-label="Meeting title"
        value={meeting.title}
        onChange={(e) => draft({ title: e.target.value })}
        maxLength={300}
        placeholder="New note"
      />
      <div className="meta-chips">
        <span className="chip">
          <CalendarDays size={13} />
          {date(meeting.createdAt)}
        </span>
        <label className="chip chip-input">
          <Users size={13} />
          <input
            aria-label="Participants"
            placeholder="Add people"
            value={meeting.participants}
            onChange={(e) => draft({ participants: e.target.value })}
          />
        </label>
        <label className="chip chip-input">
          <Folder size={13} />
          <select
            aria-label="Move note to folder"
            value={meeting.folderId ?? ''}
            onChange={(e) => patch({ folderId: e.target.value || null })}
          >
            <option value="">Add to folder</option>
            {folders.map((f) => (
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
      {!activeRecord && <CoverageWarning meeting={meeting} {...coverage} />}
      <div className="document-body">
        {tab === 'notes' ? (
          <textarea
            className="note-editor"
            aria-label="My notes"
            placeholder="Write notes…"
            value={meeting.notes}
            onChange={(e) => draft({ notes: e.target.value })}
          />
        ) : enhancing ? (
          <>
            <div className="analyzing" role="status">
              <LoaderCircle size={14} className="spin" />
              {stream ? 'Writing enhanced notes…' : 'Analyzing transcript…'}
              {showCancel && (
                <button className="text-button" onClick={onCancel}>
                  Cancel
                </button>
              )}
            </div>
            <Rich text={stream} isOwn={isOwn} />
          </>
        ) : editingSummary ? (
          <>
            <div className="summary-tools">
              <button className="text-button" onClick={() => setEditingSummary(false)}>
                Done editing
              </button>
            </div>
            <textarea
              className="note-editor"
              aria-label="Edit enhanced notes"
              value={meeting.summary}
              onChange={(e) => draft({ summary: e.target.value })}
            />
          </>
        ) : meeting.summary ? (
          <>
            <div className="summary-tools">
              {meeting.versions.length > 0 && (
                <IconButton label="Previous summaries" className="small" onClick={onHistory}>
                  <History size={14} />
                </IconButton>
              )}
              <button className="text-button" onClick={() => setEditingSummary(true)}>
                Edit
              </button>
              <button className="text-button" disabled={enhanceDisabled} onClick={onEnhance}>
                <Sparkles size={13} />
                Enhance notes
              </button>
            </div>
            <Rich text={meeting.summary} onSource={onSource} isOwn={isOwn} />
          </>
        ) : !ai.ready ? (
          <AiConnect ai={ai} actions={aiActions} title="Connect an AI to enhance notes" />
        ) : (
          <div className="document-empty">
            <Sparkles size={20} aria-hidden="true" />
            <h2>No enhanced notes yet</h2>
            <p>
              {enhanceDisabled
                ? 'Record the meeting or write a few notes first.'
                : `Combine your notes and the transcript with ${ai.label}.`}
            </p>
          </div>
        )}
      </div>
    </article>
  );
}
