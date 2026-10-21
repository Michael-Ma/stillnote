import React, { useEffect, useRef, useState } from 'react';
import { AudioLines, Headphones, LoaderCircle, Mic, RotateCcw } from 'lucide-react';
import { date, duration, time } from '../format.mjs';

const sourceName = (source) => (source === 'system' ? 'Meeting audio' : 'Microphone');
const languageName = (locale) =>
  ({
    'en-US': 'English (US)',
    'en-GB': 'English (UK)',
    'zh-CN': '中文（普通话）',
    'zh-TW': '中文（台灣）',
    'es-ES': 'Español',
    'fr-FR': 'Français',
    'de-DE': 'Deutsch',
    'ja-JP': '日本語',
    'ko-KR': '한국어',
    'pt-BR': 'Português',
  })[locale] ?? locale;
const isCapturing = (recording) =>
  ['starting', 'recording', 'capturing', 'stopping'].includes(recording.status);
const playableTracks = (recording) =>
  (recording.tracks ?? []).filter((track) => track.fileName && track.bytes !== 0);

export function transcriptCoverageWarning(meeting) {
  const recordings = meeting.recordings ?? [];
  const flagged = recordings.find((recording) => recording.diagnostics?.lowCoverage === true);
  const text = (meeting.transcript ?? [])
    .map((segment) => segment.text ?? '')
    .join('')
    .replace(/\s/g, '');
  const seconds = Number(meeting.duration) || 0;
  if (!flagged && !(seconds >= 30 && text.length < Math.max(20, seconds * 0.5))) return null;
  return recordings.some((recording) => playableTracks(recording).length)
    ? 'There is very little transcript text for this recording. Listen to the audio to check what was captured before relying on enhanced notes.'
    : 'There is very little transcript text for this recording. Review the transcript before relying on enhanced notes. Earlier sessions may not have saved audio.';
}

export function CoverageWarning({ meeting, onListen, onRetry, retrying, disabled }) {
  const message = transcriptCoverageWarning(meeting);
  if (!message) return null;
  const candidates = [...(meeting.recordings ?? [])]
    .reverse()
    .filter((recording) => !isCapturing(recording) && playableTracks(recording).length);
  const retryable =
    candidates.find((recording) => recording.diagnostics?.lowCoverage) ?? candidates[0];
  return (
    <div className="coverage-warning" role="status">
      <Headphones size={17} aria-hidden="true" />
      <div>
        <strong>Review transcript coverage</strong>
        <p>{message}</p>
        <div className="recording-actions">
          <button className="text-button" onClick={onListen}>
            {retryable ? 'Listen & review' : 'Review recording details'}
          </button>
          {retryable && (
            <button
              className="text-button"
              disabled={disabled || !!retrying}
              onClick={() => onRetry(retryable.id)}
            >
              {retrying === retryable.id ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <RotateCcw size={13} />
              )}
              {retrying === retryable.id ? 'Transcribing…' : 'Retry transcription'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function CaptureDiagnostics({ levels, sources, systemAudioRequested, starting }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="capture-diagnostics" aria-label="Capture sources">
      {['microphone', ...(systemAudioRequested ? ['system'] : [])].map((source) => {
        const level = levels[source];
        const state = sources?.[source];
        const status = typeof state === 'string' ? state : state?.status;
        const unavailable = ['error', 'failed', 'unavailable', 'denied', 'disabled'].includes(
          status,
        );
        const recent = level && now - level.receivedAt < 4000;
        const rms = recent ? Math.max(0, Number(level.rms) || 0) : 0;
        const label = unavailable
          ? 'Unavailable'
          : starting
            ? 'Connecting…'
            : recent
              ? rms >= 0.005
                ? 'Signal detected'
                : 'Quiet'
              : 'Waiting for audio';
        return (
          <div
            className={'capture-source ' + (unavailable ? 'unavailable' : '')}
            key={source}
            title={state?.message ?? ''}
          >
            {source === 'system' ? <AudioLines size={14} /> : <Mic size={14} />}
            <span className="capture-source-name">{sourceName(source)}</span>
            <span
              className="source-meter"
              role="meter"
              aria-label={`${sourceName(source)} input level`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(Math.min(100, Math.sqrt(rms) * 100))}
            >
              <span style={{ width: `${Math.min(100, Math.sqrt(rms) * 100)}%` }} />
            </span>
            <span className="capture-source-state">{label}</span>
            {unavailable && state?.message && <small>{state.message}</small>}
          </div>
        );
      })}
      <p>
        Levels show incoming audio, not transcript completeness. Raw audio is saved on this Mac.
      </p>
    </div>
  );
}

function AudioTrack({ meetingId, recordingId, track, call }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const audioRef = useRef();
  useEffect(() => {
    let valid = true;
    setUrl('');
    setError('');
    Promise.resolve()
      .then(() => call('recording-url', meetingId, recordingId, track.source))
      .then((result) => {
        const localUrl = typeof result === 'string' ? result : result?.url;
        if (!localUrl) throw new Error('No recording file is available.');
        if (valid) setUrl(localUrl);
      })
      .catch((e) => {
        if (valid)
          setError(e.message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
      });
    return () => {
      valid = false;
      audioRef.current?.pause();
    };
  }, [meetingId, recordingId, track.source, attempt]);
  return (
    <div className="audio-track">
      <div className="audio-track-label">
        {track.source === 'system' ? <AudioLines size={15} /> : <Mic size={15} />}
        <strong>{sourceName(track.source)}</strong>
        <span>{duration(Number(track.duration) || 0)}</span>
        {!!track.sampleRate && (
          <small>
            {(track.sampleRate / 1000).toLocaleString()} kHz ·{' '}
            {track.channels === 1 ? 'mono' : `${track.channels} channels`}
          </small>
        )}
      </div>
      {error ? (
        <div className="audio-track-error" role="alert">
          <span>{error}</span>
          <button className="text-button" onClick={() => setAttempt((value) => value + 1)}>
            Try loading again
          </button>
        </div>
      ) : url ? (
        <audio
          ref={audioRef}
          controls
          preload="metadata"
          src={url}
          aria-label={`${sourceName(track.source)} recording`}
          onError={() =>
            setError(
              'This audio could not be played. The recording file may be missing or unreadable.',
            )
          }
        />
      ) : (
        <p className="audio-loading">
          <LoaderCircle className="spin" size={13} /> Loading local audio…
        </p>
      )}
    </div>
  );
}

export function RecordingAudio({ meeting, call, onRetry, retrying, disabled, locale = 'en-US' }) {
  const recordings = meeting.recordings ?? [];
  return (
    <section className="recordings-panel" aria-label="Saved recordings">
      <div className="recordings-intro">
        <Headphones size={18} aria-hidden="true" />
        <div>
          <strong>Listen to the original audio</strong>
          <p>
            Raw microphone and meeting audio are retained on this Mac for playback and on-device
            transcription. Audio is never sent to OpenAI.
          </p>
        </div>
      </div>
      {!recordings.length ? (
        <div className="recordings-empty">
          <Headphones size={25} aria-hidden="true" />
          <h2>No saved audio</h2>
          <p>
            New recordings will appear here after you finish capturing. Audio from earlier
            recordings that did not save a file cannot be recovered.
          </p>
        </div>
      ) : (
        [...recordings].reverse().map((recording, index) => {
          const tracks = playableTracks(recording);
          const capturing = isCapturing(recording);
          const problems = [
            ...(recording.diagnostics?.warnings ?? []),
            ...(recording.diagnostics?.reasons ?? []),
          ];
          return (
            <article className="saved-recording" key={recording.id}>
              <header>
                <div>
                  <strong>Recording {recordings.length - index}</strong>
                  <span>
                    {date(recording.startedAt)} · {time(recording.startedAt)} ·{' '}
                    {duration(Number(recording.duration) || 0)}
                  </span>
                  <span>
                    Recognition language:{' '}
                    {recording.locale ? languageName(recording.locale) : 'Not recorded'}
                  </span>
                  {recording.locale !== locale && (
                    <span>Retry language: {languageName(locale)}</span>
                  )}
                </div>
                {!capturing && tracks.length > 0 && (
                  <button
                    className="text-button"
                    disabled={disabled || !!retrying}
                    onClick={() => onRetry(recording.id)}
                  >
                    {retrying === recording.id ? (
                      <LoaderCircle size={13} className="spin" />
                    ) : (
                      <RotateCcw size={13} />
                    )}
                    {retrying === recording.id ? 'Transcribing…' : 'Retry transcription'}
                  </button>
                )}
              </header>
              {capturing ? (
                <p className="recording-pending">
                  Audio is being saved. Finish recording to listen.
                </p>
              ) : tracks.length ? (
                tracks.map((track) => (
                  <AudioTrack
                    key={track.source}
                    meetingId={meeting.id}
                    recordingId={recording.id}
                    track={track}
                    call={call}
                  />
                ))
              ) : (
                <p className="recording-pending">
                  No playable audio file was saved for this session.
                </p>
              )}
              {recording.status === 'interrupted' && (
                <p className="recording-detail-warning">
                  This capture ended unexpectedly. Listen to the saved audio to check its coverage.
                </p>
              )}
              {recording.status === 'startfailed' && (
                <p className="recording-detail-warning">
                  This capture could not start. Check the capture permissions in macOS and try a new
                  recording.
                </p>
              )}
              {Array.isArray(problems) &&
                problems
                  .filter((warning) => typeof warning === 'string')
                  .map((warning, warningIndex) => (
                    <p className="recording-detail-warning" key={warningIndex}>
                      {warning}
                    </p>
                  ))}
            </article>
          );
        })
      )}
      {recordings.length > 0 && (
        <p className="recording-footnote">
          Retry uses the saved audio and updates this recording’s transcript. Check the result
          before enhancing your notes again.
        </p>
      )}
    </section>
  );
}
