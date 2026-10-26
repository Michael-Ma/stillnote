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
import { tidyNotes } from '../meeting-context.mjs';
import { date } from '../format.mjs';
import { useT } from '../i18n/react.jsx';

// Templates Stillnote ships, whose stored English names are shown translated; custom ones keep
// the name the user gave them.
const builtInTemplates = ['general', 'one-on-one', 'customer', 'standup', 'interview'];

// Granola's top-right switch between the user's notes and the enhanced version.
export function NoteToolbar({
  meeting,
  tab,
  setTab,
  templates,
  patch,
  activeRecord,
  onExport,
  onDeleteForever,
}) {
  const t = useT();
  return (
    <div className="note-toolbar">
      <div className="view-switch" role="tablist" aria-label={t('Note view')}>
        <button
          role="tab"
          aria-selected={tab === 'notes'}
          className={tab === 'notes' ? 'active' : ''}
          onClick={() => setTab('notes')}
          title={t('My notes')}
        >
          <NotebookPen size={14} />
          <span>{t('My notes')}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === 'summary'}
          className={tab === 'summary' ? 'active' : ''}
          onClick={() => setTab('summary')}
          title={t('Enhanced notes')}
        >
          <Sparkles size={14} />
          <span>{t('Enhanced')}</span>
        </button>
      </div>
      <select
        className="chip-select template-select"
        aria-label={t('Summary template')}
        value={meeting.templateId}
        onChange={(e) => patch({ templateId: e.target.value })}
      >
        {templates.map((template) => (
          <option value={template.id} key={template.id}>
            {builtInTemplates.includes(template.id) ? t(template.name) : template.name}
          </option>
        ))}
      </select>
      <span className="toolbar-divider" />
      <IconButton
        label={meeting.starred ? t('Unstar note') : t('Star note')}
        onClick={() => patch({ starred: !meeting.starred })}
        className={meeting.starred ? 'starred' : ''}
      >
        <Star size={15} fill={meeting.starred ? 'currentColor' : 'none'} />
      </IconButton>
      <IconButton label={t('Export Markdown')} onClick={onExport}>
        <Download size={15} />
      </IconButton>
      {meeting.deletedAt ? (
        <>
          <IconButton label={t('Restore note')} onClick={() => patch({ deletedAt: null })}>
            <RotateCcw size={15} />
          </IconButton>
          <IconButton label={t('Delete forever')} className="danger" onClick={onDeleteForever}>
            <Trash2 size={15} />
          </IconButton>
        </>
      ) : (
        <IconButton
          label={t('Move to Trash')}
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
  onTidyContext,
  onDeleteForever,
}) {
  const t = useT();
  const isOwn = useMemo(() => ownLineMatcher(meeting.notes), [meeting.notes]);
  // Notes made before invites were cleaned still hold them as they arrived (HTML, dial-ins).
  const untidy = useMemo(() => tidyNotes(meeting.notes, t) !== meeting.notes, [meeting.notes, t]);
  const enhancing = busy === 'enhance';
  return (
    <article className="note">
      <input
        className="note-title"
        aria-label={t('Meeting title')}
        value={meeting.title}
        onChange={(e) => draft({ title: e.target.value })}
        maxLength={300}
        placeholder={t('New note')}
      />
      <div className="meta-chips">
        <span className="chip">
          <CalendarDays size={13} />
          {date(meeting.createdAt, t.locale)}
        </span>
        <label className="chip chip-input">
          <Users size={13} />
          <input
            aria-label={t('Participants')}
            placeholder={t('Add people')}
            value={meeting.participants}
            onChange={(e) => draft({ participants: e.target.value })}
          />
        </label>
        <label className="chip chip-input">
          <Folder size={13} />
          <select
            aria-label={t('Move note to folder')}
            value={meeting.folderId ?? ''}
            onChange={(e) => patch({ folderId: e.target.value || null })}
          >
            <option value="">{t('Add to folder')}</option>
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
          {t('This note is in Trash.')}{' '}
          <button className="text-button" onClick={() => patch({ deletedAt: null })}>
            {t('Restore it')}
          </button>{' '}
          <button className="text-button danger" onClick={onDeleteForever}>
            {t('Delete forever')}
          </button>
        </div>
      )}
      {!activeRecord && <CoverageWarning meeting={meeting} {...coverage} />}
      {tab === 'notes' && untidy && !meeting.deletedAt && (
        <div className="inline-note">
          {t('The meeting context is the calendar invite as it arrived.')}{' '}
          <button className="text-button" onClick={onTidyContext}>
            {t('Tidy it')}
          </button>
        </div>
      )}
      <div className="document-body">
        {tab === 'notes' ? (
          <textarea
            className="note-editor"
            aria-label={t('My notes')}
            placeholder={t('Write notes…')}
            value={meeting.notes}
            onChange={(e) => draft({ notes: e.target.value })}
          />
        ) : enhancing ? (
          <>
            <div className="analyzing" role="status">
              <LoaderCircle size={14} className="spin" />
              {stream ? t('Writing enhanced notes…') : t('Analyzing transcript…')}
              {showCancel && (
                <button className="text-button" onClick={onCancel}>
                  {t('Cancel')}
                </button>
              )}
            </div>
            <Rich text={stream} isOwn={isOwn} />
          </>
        ) : editingSummary ? (
          <>
            <div className="summary-tools">
              <button className="text-button" onClick={() => setEditingSummary(false)}>
                {t('Done editing')}
              </button>
            </div>
            <textarea
              className="note-editor"
              aria-label={t('Edit enhanced notes')}
              value={meeting.summary}
              onChange={(e) => draft({ summary: e.target.value })}
            />
          </>
        ) : meeting.summary ? (
          <>
            <div className="summary-tools">
              {meeting.versions.length > 0 && (
                <IconButton label={t('Previous summaries')} className="small" onClick={onHistory}>
                  <History size={14} />
                </IconButton>
              )}
              <button className="text-button" onClick={() => setEditingSummary(true)}>
                {t('Edit')}
              </button>
              <button className="text-button" disabled={enhanceDisabled} onClick={onEnhance}>
                <Sparkles size={13} />
                {t('Enhance notes')}
              </button>
            </div>
            <Rich text={meeting.summary} onSource={onSource} isOwn={isOwn} />
          </>
        ) : !ai.ready ? (
          <AiConnect ai={ai} actions={aiActions} title={t('Connect an AI to enhance notes')} />
        ) : (
          <div className="document-empty">
            <Sparkles size={20} aria-hidden="true" />
            <h2>{t('No enhanced notes yet')}</h2>
            <p>
              {enhanceDisabled
                ? t('Record the meeting or write a few notes first.')
                : t('Combine your notes and the transcript with {ai}.', { ai: ai.label })}
            </p>
          </div>
        )}
      </div>
    </article>
  );
}
