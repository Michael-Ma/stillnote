import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  AudioLines,
  LoaderCircle,
  Mic,
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { cleanError, date, duration, recordingLanguage, time } from '../format.mjs';

const sourceName = (source) => (source === 'system' ? 'Meeting audio' : 'Microphone');
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
    ? 'Very little text was recognized. Listen to the audio before relying on enhanced notes.'
    : 'Very little text was recognized. Review the transcript before relying on enhanced notes.';
}

// One quiet line under the title instead of a banner above every view.
export function CoverageWarning({ meeting, onListen, onRetry, retrying, disabled }) {
  const [dismissed, setDismissed] = useState(null);
  const message = transcriptCoverageWarning(meeting);
  if (!message || dismissed === meeting.id + meeting.updatedAt) return null;
  const candidates = [...(meeting.recordings ?? [])]
    .reverse()
    .filter((recording) => !isCapturing(recording) && playableTracks(recording).length);
  const retryable =
    candidates.find((recording) => recording.diagnostics?.lowCoverage) ?? candidates[0];
  return (
    <div className="coverage-warning" role="status">
      <AlertTriangle size={14} aria-hidden="true" />
      <strong>Review transcript coverage</strong>
      <span>{message}</span>
      <button className="text-button" onClick={onListen}>
        {retryable ? 'Listen' : 'Details'}
      </button>
      {retryable && (
        <button
          className="text-button"
          disabled={disabled || !!retrying}
          onClick={() => onRetry(retryable.id)}
        >
          {retrying === retryable.id ? 'Transcribing…' : 'Retry'}
        </button>
      )}
      <button
        className="icon-button small"
        aria-label="Dismiss coverage warning"
        onClick={() => setDismissed(meeting.id + meeting.updatedAt)}
      >
        <X size={13} />
      </button>
    </div>
  );
}

export function CaptureDiagnostics({ levels, sources, systemAudioRequested, starting, engine }) {
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
                ? 'Signal'
                : 'Quiet'
              : 'Waiting';
        return (
          <div
            className={'capture-source ' + (unavailable ? 'unavailable' : '')}
            key={source}
            title={state?.message ?? ''}
          >
            {source === 'system' ? <AudioLines size={14} /> : <Mic size={14} />}
            <span className="capture-source-name">
              {sourceName(source)}
              {source === 'microphone' && state?.device?.name ? ` · ${state.device.name}` : ''}
            </span>
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
        {engine === 'speechTranscriber'
          ? 'On-device · Apple SpeechTranscriber'
          : engine === 'legacy'
            ? 'On-device · Apple Speech (legacy)'
            : 'On-device speech recognition'}
        . Levels show incoming audio.
      </p>
    </div>
  );
}

function useTrackUrl(call, meetingId, recordingId, source, attempt) {
  const [state, setState] = useState({ url: '', error: '' });
  useEffect(() => {
    let valid = true;
    setState({ url: '', error: '' });
    Promise.resolve()
      .then(() => call('recording-url', meetingId, recordingId, source))
      .then((result) => {
        const url = typeof result === 'string' ? result : result?.url;
        if (!url) throw new Error('No recording file is available.');
        if (valid) setState({ url, error: '' });
      })
      .catch((e) => valid && setState({ url: '', error: cleanError(e) }));
    return () => {
      valid = false;
    };
  }, [meetingId, recordingId, source, attempt]);
  return state;
}

function Track({ meetingId, recordingId, track, call, register, muted, onToggleMute }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState('');
  const { url, error } = useTrackUrl(call, meetingId, recordingId, track.source, attempt);
  const audioRef = useRef();
  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = muted;
  }, [muted, url]);
  const shown = error || failed;
  return (
    <div className="audio-track">
      <button
        className={'track-toggle' + (muted ? ' muted' : '')}
        onClick={onToggleMute}
        aria-pressed={!muted}
        aria-label={`${muted ? 'Unmute' : 'Mute'} ${sourceName(track.source)}`}
        title={
          track.sampleRate
            ? `${(track.sampleRate / 1000).toLocaleString()} kHz · ${track.channels === 1 ? 'mono' : `${track.channels} channels`}`
            : undefined
        }
      >
        {track.source === 'system' ? <AudioLines size={14} /> : <Mic size={14} />}
        {sourceName(track.source)}
        {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
      </button>
      {url && (
        <audio
          ref={(element) => {
            audioRef.current = element;
            register(track.source, element, track.startOffset ?? 0);
          }}
          preload="metadata"
          src={url}
          aria-label={`${sourceName(track.source)} recording`}
          onError={() =>
            setFailed('This audio could not be played. The file may be missing or unreadable.')
          }
        />
      )}
      {shown ? (
        <div className="audio-track-error" role="alert">
          <span>{shown}</span>
          <button
            className="text-button"
            onClick={() => {
              setFailed('');
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : !url ? (
        <LoaderCircle className="spin" size={13} aria-label="Loading local audio" />
      ) : null}
    </div>
  );
}

// One transport for every source of a recording, so microphone and meeting audio stay aligned.
function Player({ meeting, recording, tracks, call }) {
  const elements = useRef({});
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [muted, setMuted] = useState({});
  const total = Math.max(
    Number(recording.duration) || 0,
    ...tracks.map((t) => (Number(t.duration) || 0) + (t.startOffset ?? 0)),
  );
  const all = () => Object.values(elements.current).filter((x) => x.element);
  const register = (source, element, offset) => {
    if (element) elements.current[source] = { element, offset };
    else delete elements.current[source];
  };
  const seek = (t) => {
    for (const { element, offset } of all())
      element.currentTime = Math.max(0, Math.min(element.duration || Infinity, t - offset));
    setPosition(t);
  };
  // Each source starts a little after the recording (its startOffset). A source whose audio
  // begins later than the play position starts on cue, while a clock keeps the scrubber moving.
  const cues = useRef([]),
    clock = useRef({ at: 0, from: 0 });
  const clearCues = () => {
    cues.current.forEach(clearTimeout);
    cues.current = [];
  };
  const startAll = (from) => {
    clearCues();
    clock.current = { at: performance.now(), from };
    for (const { element, offset } of all()) {
      if (from >= offset) element.play().catch(() => {});
      else {
        const cue = setTimeout(
          () => {
            cues.current = cues.current.filter((id) => id !== cue);
            element.play().catch(() => {});
          },
          (offset - from) * 1000,
        );
        cues.current.push(cue);
      }
    }
  };
  const pauseAll = () => {
    clearCues();
    all().forEach(({ element }) => element.pause());
  };
  useEffect(() => {
    if (!playing) return;
    let frame;
    const tick = () => {
      const lead = all().find(({ element }) => !element.paused);
      if (lead) setPosition(lead.element.currentTime + lead.offset);
      else if (cues.current.length)
        setPosition(clock.current.from + (performance.now() - clock.current.at) / 1000);
      else return setPlaying(false);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  useEffect(() => pauseAll, []);
  const toggle = () => {
    if (playing) {
      pauseAll();
      setPlaying(false);
      return;
    }
    const start = position >= total - 0.2 ? 0 : position;
    seek(start);
    startAll(start);
    setPlaying(true);
  };
  const scrub = (t) => {
    if (playing) pauseAll();
    seek(t);
    if (playing) startAll(t);
  };
  return (
    <div className="player">
      <div className="transport">
        <button
          className="play-button"
          onClick={toggle}
          aria-label={playing ? 'Pause recording' : 'Play recording'}
        >
          {playing ? (
            <Pause size={14} fill="currentColor" />
          ) : (
            <Play size={14} fill="currentColor" />
          )}
        </button>
        <span className="player-time">{duration(position)}</span>
        <input
          type="range"
          className="scrubber"
          aria-label="Playback position"
          min={0}
          max={Math.max(total, 0.1)}
          step={0.1}
          value={Math.min(position, total)}
          onChange={(e) => scrub(Number(e.target.value))}
          style={{ '--progress': `${total ? (position / total) * 100 : 0}%` }}
        />
        <span className="player-time">{duration(total)}</span>
      </div>
      <div className="track-list">
        {tracks.map((track) => (
          <Track
            key={track.source}
            meetingId={meeting.id}
            recordingId={recording.id}
            track={track}
            call={call}
            register={register}
            muted={!!muted[track.source]}
            onToggleMute={() => setMuted((m) => ({ ...m, [track.source]: !m[track.source] }))}
          />
        ))}
      </div>
    </div>
  );
}

export function RecordingAudio({
  meeting,
  call,
  onRetry,
  retrying,
  disabled,
  locale = 'en-US',
  autoLocales,
}) {
  const recordings = meeting.recordings ?? [];
  return (
    <section className="recordings-panel" aria-label="Saved recordings">
      {!recordings.length ? (
        <div className="sheet-empty">
          <AudioLines size={22} aria-hidden="true" />
          <h2>No saved audio</h2>
          <p>Recordings appear here after you finish capturing. Audio stays on this Mac.</p>
        </div>
      ) : (
        [...recordings].reverse().map((recording, index) => {
          const tracks = playableTracks(recording);
          const capturing = isCapturing(recording);
          const problems = [
            ...(recording.diagnostics?.warnings ?? []),
            ...(recording.diagnostics?.reasons ?? []),
          ].filter((warning) => typeof warning === 'string');
          return (
            <article className="saved-recording" key={recording.id}>
              <header>
                <div>
                  <strong>Recording {recordings.length - index}</strong>
                  <span>
                    {date(recording.startedAt)} · {time(recording.startedAt)} ·{' '}
                    {duration(Number(recording.duration) || 0)} ·{' '}
                    {recording.locale
                      ? recordingLanguage(recording.locale, recording.locales)
                      : 'Language not recorded'}
                  </span>
                </div>
                {!capturing && tracks.length > 0 && (
                  <button
                    className="text-button"
                    disabled={disabled || !!retrying}
                    onClick={() => onRetry(recording.id)}
                    title={
                      recordingLanguage(recording.locale ?? '', recording.locales) !==
                      recordingLanguage(locale, autoLocales)
                        ? `Transcribes again in ${recordingLanguage(locale, autoLocales)}`
                        : undefined
                    }
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
              {(recording.engine || recording.sources?.microphone?.device?.name) && (
                <p className="recording-footnote">
                  {recording.sources?.microphone?.device?.name}
                  {recording.sources?.microphone?.device?.name && recording.engine ? ' · ' : ''}
                  {recording.engine === 'speechTranscriber'
                    ? 'On-device · Apple SpeechTranscriber'
                    : recording.engine === 'legacy'
                      ? 'On-device · Apple Speech (legacy)'
                      : ''}
                </p>
              )}
              {capturing ? (
                <p className="recording-pending">
                  Audio is being saved. Finish recording to listen.
                </p>
              ) : tracks.length ? (
                <Player meeting={meeting} recording={recording} tracks={tracks} call={call} />
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
              {problems.map((warning, warningIndex) => (
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
          Audio never leaves this Mac. Retry re-transcribes the saved audio on-device.
        </p>
      )}
    </section>
  );
}
