import React from 'react';
import { ChevronDown, ChevronUp, LoaderCircle, Sparkles, Square } from 'lucide-react';
import { duration } from '../format.mjs';

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

export function RecordPill({
  recording,
  active,
  hasAudio,
  elapsed,
  level,
  sheetOpen,
  disabled,
  onStart,
  onStop,
  onToggleSheet,
}) {
  const toggle = (
    <button
      className="pill-toggle"
      onClick={onToggleSheet}
      aria-label={sheetOpen ? 'Hide transcript' : 'Show transcript'}
      aria-expanded={sheetOpen}
    >
      {sheetOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
    </button>
  );
  if (active)
    return (
      <div className="record-pill recording" role="group" aria-label="Recording">
        <button className="pill-main" onClick={onToggleSheet} aria-label="Live transcript">
          <LevelBars level={level} live={!recording.stopping} />
          <span className="pill-time">
            {recording.stopping ? 'Saving…' : recording.starting ? 'Starting…' : duration(elapsed)}
          </span>
        </button>
        <button
          className="pill-stop"
          aria-label="Stop recording"
          title="Stop recording"
          disabled={recording.stopping}
          onClick={onStop}
        >
          <Square size={11} fill="currentColor" />
        </button>
        {toggle}
      </div>
    );
  return (
    <div className="record-pill" role="group" aria-label="Recording">
      <button
        className="pill-main"
        aria-label="Start recording"
        title="Start recording on this Mac"
        disabled={disabled}
        onClick={onStart}
      >
        {hasAudio ? <LevelBars /> : <span className="rec-dot" aria-hidden="true" />}
        <span className="pill-label">{hasAudio ? 'Resume' : 'Record'}</span>
      </button>
      {toggle}
    </div>
  );
}

export function EnhancePill({ busy, disabled, onEnhance, onCancel }) {
  return busy ? (
    <button className="float-pill" onClick={onCancel}>
      <LoaderCircle size={14} className="spin" />
      Cancel
    </button>
  ) : (
    <button className="float-pill accent" disabled={disabled} onClick={onEnhance}>
      <Sparkles size={14} />
      Enhance notes
    </button>
  );
}
