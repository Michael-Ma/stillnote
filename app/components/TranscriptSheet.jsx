import React, { useEffect, useRef } from 'react';
import { Mic, Plus, X } from 'lucide-react';
import { IconButton } from './Content.jsx';
import { CaptureDiagnostics, RecordingAudio } from './RecordingAudio.jsx';
import { duration, languageName } from '../format.mjs';

const isMe = (speaker = '') => /^(me|you|microphone|mic)$/i.test(speaker.trim());

// Granola keeps the transcript one click away from the listening indicator, above the dock.
export function TranscriptSheet({
  meeting,
  tab,
  setTab,
  onClose,
  activeRecord,
  partial,
  capture,
  recordings,
  onAddTranscript,
  onEditSegment,
}) {
  const bottomRef = useRef();
  // Auto language: when sentences came out in different languages, each says which.
  const mixed = new Set(meeting.transcript.map((s) => s.locale).filter(Boolean)).size > 1;
  useEffect(() => {
    if (activeRecord && tab === 'transcript')
      bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [meeting.transcript.length, partial, activeRecord, tab]);
  return (
    <section className="transcript-sheet" aria-label="Transcript and recordings">
      <header>
        <div role="tablist" className="sheet-tabs">
          <button
            role="tab"
            aria-selected={tab === 'transcript'}
            className={tab === 'transcript' ? 'active' : ''}
            onClick={() => setTab('transcript')}
          >
            Transcript
            {meeting.transcript.length > 0 && <span>{meeting.transcript.length}</span>}
          </button>
          <button
            role="tab"
            aria-selected={tab === 'recordings'}
            className={tab === 'recordings' ? 'active' : ''}
            onClick={() => setTab('recordings')}
          >
            Recordings
          </button>
        </div>
        <div className="sheet-actions">
          {tab === 'transcript' && (
            <button className="text-button" onClick={onAddTranscript}>
              <Plus size={14} />
              Add transcript
            </button>
          )}
          <IconButton label="Close transcript" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
      </header>
      <div className="sheet-body">
        {activeRecord && <CaptureDiagnostics {...capture} />}
        {tab === 'recordings' ? (
          <RecordingAudio meeting={meeting} {...recordings} />
        ) : (
          <>
            {!meeting.transcript.length && !activeRecord && (
              <div className="sheet-empty">
                <Mic size={22} aria-hidden="true" />
                <h2>No transcript yet</h2>
                <p>Start recording, or paste a transcript you already have.</p>
                <button className="secondary" onClick={onAddTranscript}>
                  Paste a transcript
                </button>
              </div>
            )}
            {meeting.transcript.length > 0 && (
              <p className="sheet-meta">
                {meeting.transcript.length} segments · {Math.ceil(meeting.duration / 60)} min
                recorded
              </p>
            )}
            <div className="transcript-list">
              {meeting.transcript.map((s) => (
                <div className={'transcript-segment' + (isMe(s.speaker) ? ' me' : '')} key={s.id}>
                  <div className="segment-head">
                    <strong>{s.speaker}</strong>
                    <time>{duration(s.timestamp)}</time>
                    {mixed && s.locale && (
                      <span className="segment-language">
                        {languageName(s.locale.split('-')[0])}
                      </span>
                    )}
                    <button className="text-button segment-edit" onClick={() => onEditSegment(s)}>
                      Edit
                    </button>
                  </div>
                  <p>{s.text}</p>
                </div>
              ))}
              {activeRecord &&
                Object.values(partial).map((s) => (
                  <div
                    className={'transcript-segment live' + (isMe(s.speaker) ? ' me' : '')}
                    key={s.segmentId || s.speaker}
                  >
                    <div className="segment-head">
                      <strong>{s.speaker}</strong>
                      <span className="live-label">Live</span>
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
