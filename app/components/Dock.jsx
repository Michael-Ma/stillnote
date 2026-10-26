import React, { useSyncExternalStore } from 'react';
import {
  Captions,
  ChevronDown,
  ChevronUp,
  Headphones,
  LoaderCircle,
  Sparkles,
  Square,
} from 'lucide-react';
import { duration } from '../format.mjs';
import { meterLevel } from '../live-values.mjs';
import { useT } from '../i18n/react.jsx';

// Toggles the transcript sheet (handled in ui.jsx); the Transcript button's tooltip names it.
const transcriptShortcut = '⌘⇧T';

// Four bars that follow the live input level, like Granola's listening indicator.
export function LevelBars({ level = 0, live = false }) {
  const shape = [0.55, 1, 0.75, 0.4];
  return (
    <span className={'level-bars' + (live ? ' live' : '')} aria-hidden="true">
      {shape.map((s, i) => (
        <span
          key={i}
          style={
            live
              ? { transform: `scaleY(${Math.max(0.25, Math.min(1, s * (0.35 + level * 3)))})` }
              : undefined
          }
        />
      ))}
    </span>
  );
}

// The transcript and the saved audio are labelled in the dock, with their counts, so a note
// shows what it has at a glance. Each opens its tab of the sheet above, and closes it again.
function SheetButtons({ sheet, lines, saved, live, onSheet }) {
  const t = useT();
  const open = sheet === 'transcript';
  const shortcut = { shortcut: transcriptShortcut };
  return (
    <>
      <button
        className={'pill-sheet' + (lines || live ? '' : ' empty')}
        aria-label={
          lines ? t.count(lines, 'Transcript, {n} segment', 'Transcript, {n} segments') : undefined
        }
        aria-expanded={open}
        title={
          open
            ? t('Hide transcript {shortcut}', shortcut)
            : t('Show transcript {shortcut}', shortcut)
        }
        onClick={() => onSheet('transcript')}
      >
        <Captions size={15} aria-hidden="true" />
        <span>{t('Transcript')}</span>
        {lines > 0 && <span className={'pill-count' + (live ? ' live' : '')}>{lines}</span>}
        {open ? (
          <ChevronDown size={14} className="pill-chevron" aria-hidden="true" />
        ) : (
          <ChevronUp size={14} className="pill-chevron" aria-hidden="true" />
        )}
      </button>
      {saved > 0 && (
        <button
          className="pill-sheet"
          aria-label={t('Recordings, {n} saved', { n: saved })}
          aria-expanded={sheet === 'recordings'}
          title={sheet === 'recordings' ? t('Hide recordings') : t('Listen to saved recordings')}
          onClick={() => onSheet('recordings')}
        >
          <Headphones size={15} aria-hidden="true" />
          <span>{t('Recordings')}</span>
          <span className="pill-count">{saved}</span>
        </button>
      )}
    </>
  );
}

// The bars subscribe to the audio levels themselves, so a level update redraws only them.
function LiveLevelBars({ levels, live }) {
  const current = useSyncExternalStore(levels.subscribe, levels.get);
  return <LevelBars level={meterLevel(current)} live={live} />;
}

export function RecordPill({
  recording,
  active,
  canRecord,
  hasAudio,
  elapsed,
  levels,
  sheet,
  lines,
  saved,
  disabled,
  onStart,
  onStop,
  onSheet,
}) {
  const t = useT();
  const sheetButtons = (
    <SheetButtons sheet={sheet} lines={lines} saved={saved} live={active} onSheet={onSheet} />
  );
  if (active)
    return (
      <div className="record-pill recording" role="group" aria-label={t('Recording')}>
        <button
          className="pill-main"
          onClick={() => onSheet('transcript')}
          aria-label={t('Live transcript')}
        >
          <LiveLevelBars levels={levels} live={!recording.stopping} />
          <span className="pill-time">
            {recording.stopping
              ? t('Saving…')
              : recording.starting
                ? t('Starting…')
                : duration(elapsed)}
          </span>
        </button>
        <button
          className="pill-stop"
          aria-label={t('Stop recording')}
          title={t('Stop recording')}
          disabled={recording.stopping}
          onClick={onStop}
        >
          <Square size={11} fill="currentColor" />
        </button>
        <span className="pill-divider" aria-hidden="true" />
        {sheetButtons}
      </div>
    );
  // A note in Trash can't record; it still shows its transcript and audio, if it has any.
  if (!canRecord)
    return lines || saved ? (
      <div className="record-pill" role="group" aria-label={t('Transcript and recordings')}>
        {sheetButtons}
      </div>
    ) : null;
  return (
    <div className="record-pill" role="group" aria-label={t('Recording')}>
      <button
        className="pill-main"
        aria-label={t('Start recording')}
        title={t('Start recording on this Mac')}
        disabled={disabled}
        onClick={onStart}
      >
        {hasAudio ? <LevelBars /> : <span className="rec-dot" aria-hidden="true" />}
        <span className="pill-label">{hasAudio ? t('Resume') : t('Record')}</span>
      </button>
      <span className="pill-divider" aria-hidden="true" />
      {sheetButtons}
    </div>
  );
}

export function EnhancePill({ busy, disabled, onEnhance, onCancel }) {
  const t = useT();
  return busy ? (
    <button className="float-pill" onClick={onCancel}>
      <LoaderCircle size={14} className="spin" />
      {t('Cancel')}
    </button>
  ) : (
    <button className="float-pill accent" disabled={disabled} onClick={onEnhance}>
      <Sparkles size={14} />
      {t('Enhance notes')}
    </button>
  );
}
