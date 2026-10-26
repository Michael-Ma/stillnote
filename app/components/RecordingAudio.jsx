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
import { recognitionPlan } from '../language-arbiter.mjs';
import { translator } from '../i18n/index.mjs';
import { useT } from '../i18n/react.jsx';

// Stored in English and translated where shown; listed for the i18n coverage test.
const msg = (text) => text;

const english = translator('en');
const sourceName = (source, t) => (source === 'system' ? t('Meeting audio') : t('Microphone'));
const isCapturing = (recording) =>
  ['starting', 'recording', 'capturing', 'stopping'].includes(recording.status);
const playableTracks = (recording) =>
  (recording.tracks ?? []).filter((track) => track.fileName && track.bytes !== 0);

export function transcriptCoverageWarning(meeting, t = english) {
  const recordings = meeting.recordings ?? [];
  const flagged = recordings.find((recording) => recording.diagnostics?.lowCoverage === true);
  const text = (meeting.transcript ?? [])
    .map((segment) => segment.text ?? '')
    .join('')
    .replace(/\s/g, '');
  const seconds = Number(meeting.duration) || 0;
  if (!flagged && !(seconds >= 30 && text.length < Math.max(20, seconds * 0.5))) return null;
  return recordings.some((recording) => playableTracks(recording).length)
    ? t('Very little text was recognized. Listen to the audio before relying on enhanced notes.')
    : t('Very little text was recognized. Review the transcript before relying on enhanced notes.');
}

// One quiet line under the title instead of a banner above every view.
export function CoverageWarning({ meeting, onListen, onRetry, retrying, disabled }) {
  const t = useT();
  const [dismissed, setDismissed] = useState(null);
  const message = transcriptCoverageWarning(meeting, t);
  if (!message || dismissed === meeting.id + meeting.updatedAt) return null;
  const candidates = [...(meeting.recordings ?? [])]
    .reverse()
    .filter((recording) => !isCapturing(recording) && playableTracks(recording).length);
  const retryable =
    candidates.find((recording) => recording.diagnostics?.lowCoverage) ?? candidates[0];
  return (
    <div className="coverage-warning" role="status">
      <AlertTriangle size={14} aria-hidden="true" />
      <strong>{t('Review transcript coverage')}</strong>
      <span>{message}</span>
      <button className="text-button" onClick={onListen}>
        {retryable ? t('Listen') : t('Details')}
      </button>
      {retryable && (
        <button
          className="text-button"
          disabled={disabled || !!retrying}
          onClick={() => onRetry(retryable.id)}
        >
          {retrying === retryable.id ? t('Transcribing…') : t('Retry')}
        </button>
      )}
      <button
        className="icon-button small"
        aria-label={t('Dismiss coverage warning')}
        onClick={() => setDismissed(meeting.id + meeting.updatedAt)}
      >
        <X size={13} />
      </button>
    </div>
  );
}

export function CaptureDiagnostics({ levels, sources, systemAudioRequested, starting, engine }) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="capture-diagnostics" aria-label={t('Capture sources')}>
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
          ? t('Unavailable')
          : starting
            ? t('Connecting…')
            : recent
              ? rms >= 0.005
                ? t('Signal')
                : t('Quiet')
              : t('Waiting');
        // Source messages come from the main process in English.
        const message = state?.message ? t(state.message) : '';
        return (
          <div
            className={'capture-source ' + (unavailable ? 'unavailable' : '')}
            key={source}
            title={message}
          >
            {source === 'system' ? <AudioLines size={14} /> : <Mic size={14} />}
            <span className="capture-source-name">
              {sourceName(source, t)}
              {source === 'microphone' && state?.device?.name ? ` · ${state.device.name}` : ''}
            </span>
            <span
              className="source-meter"
              role="meter"
              aria-label={
                source === 'system' ? t('Meeting audio input level') : t('Microphone input level')
              }
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(Math.min(100, Math.sqrt(rms) * 100))}
            >
              <span style={{ width: `${Math.min(100, Math.sqrt(rms) * 100)}%` }} />
            </span>
            <span className="capture-source-state">{label}</span>
            {unavailable && message && <small>{message}</small>}
          </div>
        );
      })}
      <p>
        {engine === 'speechTranscriber'
          ? t('On-device · Apple SpeechTranscriber. Levels show incoming audio.')
          : engine === 'legacy'
            ? t('On-device · Apple Speech (legacy). Levels show incoming audio.')
            : t('On-device speech recognition. Levels show incoming audio.')}
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
        if (!url) throw new Error(msg('No recording file is available.'));
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
  const t = useT();
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState('');
  const { url, error } = useTrackUrl(call, meetingId, recordingId, track.source, attempt);
  const audioRef = useRef();
  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = muted;
  }, [muted, url]);
  // Kept in English (errors also come from the main process) and translated when shown.
  const shown = error || failed;
  return (
    <div className="audio-track">
      <button
        className={'track-toggle' + (muted ? ' muted' : '')}
        onClick={onToggleMute}
        aria-pressed={!muted}
        aria-label={
          track.source === 'system'
            ? muted
              ? t('Unmute Meeting audio')
              : t('Mute Meeting audio')
            : muted
              ? t('Unmute Microphone')
              : t('Mute Microphone')
        }
        title={
          track.sampleRate
            ? track.channels === 1
              ? t('{rate} kHz · mono', { rate: (track.sampleRate / 1000).toLocaleString(t.locale) })
              : t('{rate} kHz · {n} channels', {
                  rate: (track.sampleRate / 1000).toLocaleString(t.locale),
                  n: track.channels,
                })
            : undefined
        }
      >
        {track.source === 'system' ? <AudioLines size={14} /> : <Mic size={14} />}
        {sourceName(track.source, t)}
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
          aria-label={
            track.source === 'system' ? t('Meeting audio recording') : t('Microphone recording')
          }
          onError={() =>
            setFailed(msg('This audio could not be played. The file may be missing or unreadable.'))
          }
        />
      )}
      {shown ? (
        <div className="audio-track-error" role="alert">
          <span>{t(shown)}</span>
          <button
            className="text-button"
            onClick={() => {
              setFailed('');
              setAttempt((value) => value + 1);
            }}
          >
            {t('Try again')}
          </button>
        </div>
      ) : !url ? (
        <LoaderCircle className="spin" size={13} aria-label={t('Loading local audio')} />
      ) : null}
    </div>
  );
}

// One transport for every source of a recording, so microphone and meeting audio stay aligned.
function Player({ meeting, recording, tracks, call }) {
  const t = useT();
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
          aria-label={playing ? t('Pause recording') : t('Play recording')}
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
          aria-label={t('Playback position')}
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
  const t = useT();
  const recordings = meeting.recordings ?? [];
  // Retry uses the current setting, read the way the main process reads it.
  const plan = recognitionPlan({ locale, autoLocales });
  const target = recordingLanguage(plan.label, plan.locales, t.locale, t);
  const sameLanguage = (recording) =>
    recording.locale === plan.label &&
    (plan.label !== 'auto' || (recording.locales ?? []).join() === plan.locales.join());
  return (
    <section className="recordings-panel" aria-label={t('Saved recordings')}>
      {!recordings.length ? (
        <div className="sheet-empty">
          <AudioLines size={22} aria-hidden="true" />
          <h2>{t('No saved audio')}</h2>
          <p>{t('Recordings appear here after you finish capturing. Audio stays on this Mac.')}</p>
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
                  <strong>{t('Recording {n}', { n: recordings.length - index })}</strong>
                  <span>
                    {date(recording.startedAt, t.locale)} · {time(recording.startedAt, t.locale)} ·{' '}
                    {duration(Number(recording.duration) || 0)} ·{' '}
                    {recording.locale
                      ? recordingLanguage(recording.locale, recording.locales, t.locale, t)
                      : t('Language not recorded')}
                  </span>
                </div>
                {!capturing && tracks.length > 0 && (
                  <button
                    className="text-button"
                    disabled={disabled || !!retrying}
                    onClick={() => onRetry(recording.id)}
                    title={
                      sameLanguage(recording)
                        ? undefined
                        : t('Transcribes again in {language}', { language: target })
                    }
                  >
                    {retrying === recording.id ? (
                      <LoaderCircle size={13} className="spin" />
                    ) : (
                      <RotateCcw size={13} />
                    )}
                    {retrying === recording.id ? t('Transcribing…') : t('Retry transcription')}
                  </button>
                )}
              </header>
              {(recording.engine || recording.sources?.microphone?.device?.name) && (
                <p className="recording-footnote">
                  {recording.sources?.microphone?.device?.name}
                  {recording.sources?.microphone?.device?.name && recording.engine ? ' · ' : ''}
                  {recording.engine === 'speechTranscriber'
                    ? t('On-device · Apple SpeechTranscriber')
                    : recording.engine === 'legacy'
                      ? t('On-device · Apple Speech (legacy)')
                      : ''}
                </p>
              )}
              {capturing ? (
                <p className="recording-pending">
                  {t('Audio is being saved. Finish recording to listen.')}
                </p>
              ) : tracks.length ? (
                <Player meeting={meeting} recording={recording} tracks={tracks} call={call} />
              ) : (
                <p className="recording-pending">
                  {t('No playable audio file was saved for this session.')}
                </p>
              )}
              {recording.status === 'interrupted' && (
                <p className="recording-detail-warning">
                  {t(
                    'This capture ended unexpectedly. Listen to the saved audio to check its coverage.',
                  )}
                </p>
              )}
              {recording.status === 'startfailed' && (
                <p className="recording-detail-warning">
                  {t(
                    'This capture could not start. Check the capture permissions in macOS and try a new recording.',
                  )}
                </p>
              )}
              {problems.map((warning, warningIndex) => (
                <p className="recording-detail-warning" key={warningIndex}>
                  {t(warning)}
                </p>
              ))}
            </article>
          );
        })
      )}
      {recordings.length > 0 && (
        <p className="recording-footnote">
          {t('Audio never leaves this Mac. Retry re-transcribes the saved audio on-device.')}
        </p>
      )}
    </section>
  );
}
