import React, { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { Mic, Plus, X } from 'lucide-react';
import { IconButton } from './Content.jsx';
import { CaptureDiagnostics, RecordingAudio } from './RecordingAudio.jsx';
import { duration, languageName, speakerLabel } from '../format.mjs';
import { useT } from '../i18n/react.jsx';

const isMe = (speaker = '') => /^(me|you|microphone|mic)$/i.test(speaker.trim());

// A saved line. Rows draw again only when their own segment changes, not on every live update of
// a long meeting.
const Segment = React.memo(function Segment({ segment: s, mixed, onEdit }) {
  const t = useT();
  return (
    <div className={'transcript-segment' + (isMe(s.speaker) ? ' me' : '')}>
      <div className="segment-head">
        <strong>{speakerLabel(s.speaker, t)}</strong>
        <time>{duration(s.timestamp)}</time>
        {mixed && s.locale && (
          <span className="segment-language">{languageName(s.locale.split('-')[0], t.locale)}</span>
        )}
        <button className="text-button segment-edit" onClick={() => onEdit(s)}>
          {t('Edit')}
        </button>
      </div>
      <p>{s.text}</p>
    </div>
  );
});

// Granola keeps the transcript one click away from the listening indicator, above the dock.
export function TranscriptSheet({
  meeting,
  tab,
  setTab,
  onClose,
  activeRecord,
  partials,
  capture,
  recordings,
  onAddTranscript,
  onEditSegment,
}) {
  const t = useT();
  const partial = useSyncExternalStore(partials.subscribe, partials.get);
  const bottomRef = useRef();
  // While recording, the newest line stays in view unless the reader has scrolled up to read.
  const following = useRef(true);
  const edit = useRef(onEditSegment);
  edit.current = onEditSegment;
  const onEdit = useCallback((segment) => edit.current(segment), []);
  // Auto language: when sentences came out in different languages, each says which.
  const mixed = new Set(meeting.transcript.map((s) => s.locale).filter(Boolean)).size > 1;
  useEffect(() => {
    if (activeRecord && tab === 'transcript' && following.current)
      bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [meeting.transcript.length, partial, activeRecord, tab]);
  return (
    <section className="transcript-sheet" aria-label={t('Transcript and recordings')}>
      <header>
        <div role="tablist" className="sheet-tabs">
          <button
            role="tab"
            aria-selected={tab === 'transcript'}
            className={tab === 'transcript' ? 'active' : ''}
            onClick={() => setTab('transcript')}
          >
            {t('Transcript')}
            {meeting.transcript.length > 0 && <span>{meeting.transcript.length}</span>}
          </button>
          <button
            role="tab"
            aria-selected={tab === 'recordings'}
            className={tab === 'recordings' ? 'active' : ''}
            onClick={() => setTab('recordings')}
          >
            {t('Recordings')}
          </button>
        </div>
        <div className="sheet-actions">
          {tab === 'transcript' && (
            <button className="text-button" onClick={onAddTranscript}>
              <Plus size={14} />
              {t('Add transcript')}
            </button>
          )}
          <IconButton label={t('Close transcript')} onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
      </header>
      <div
        className="sheet-body"
        onScroll={(e) => {
          const body = e.currentTarget;
          following.current = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
        }}
      >
        {activeRecord && <CaptureDiagnostics {...capture} />}
        {tab === 'recordings' ? (
          <RecordingAudio meeting={meeting} {...recordings} />
        ) : (
          <>
            {!meeting.transcript.length && !activeRecord && (
              <div className="sheet-empty">
                <Mic size={22} aria-hidden="true" />
                <h2>{t('No transcript yet')}</h2>
                <p>{t('Start recording, or paste a transcript you already have.')}</p>
                <button className="secondary" onClick={onAddTranscript}>
                  {t('Paste a transcript')}
                </button>
              </div>
            )}
            {meeting.transcript.length > 0 && (
              <p className="sheet-meta">
                {t.count(
                  meeting.transcript.length,
                  '{n} segment · {minutes} min recorded',
                  '{n} segments · {minutes} min recorded',
                  { minutes: Math.ceil(meeting.duration / 60) },
                )}
              </p>
            )}
            <div className="transcript-list">
              {meeting.transcript.map((s) => (
                <Segment key={s.id} segment={s} mixed={mixed} onEdit={onEdit} />
              ))}
              {activeRecord &&
                Object.values(partial).map((s) => (
                  <div
                    className={'transcript-segment live' + (isMe(s.speaker) ? ' me' : '')}
                    key={s.segmentId || s.speaker}
                  >
                    <div className="segment-head">
                      <strong>{speakerLabel(s.speaker, t)}</strong>
                      <span className="live-label">{t('Live')}</span>
                    </div>
                    <p>{s.text}</p>
                  </div>
                ))}
              <div ref={bottomRef} />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
