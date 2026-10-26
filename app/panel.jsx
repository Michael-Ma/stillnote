import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChevronDown } from 'lucide-react';
import stillnoteIcon from '../assets/icon-small.png';
import './style.css';
import './panel.css';

const api = window.stillnotePanel;

// The floating panel (app/panel.mjs): the meeting with its calendar's color, its time, and the
// main action with more in a menu. The bar at the bottom runs down to when the panel goes by
// itself (paused while the pointer is over it), or to an automatic stop.
function Panel() {
  const [panel, setPanel] = useState(null);
  const [now, setNow] = useState(Date.now);
  const left = useRef(0);
  const hovering = useRef(false);
  useEffect(() => {
    api.onShow((next) => {
      left.current = next?.expires ? Math.max(0, next.expires - Date.now()) : 0;
      setNow(Date.now());
      setPanel(next);
    });
  }, []);
  useEffect(() => {
    if (!panel) return;
    let last = Date.now();
    const timer = setInterval(() => {
      const at = Date.now();
      if (panel.expires && !hovering.current) left.current -= at - last;
      last = at;
      setNow(at);
      if (panel.expires && left.current <= 0) {
        clearInterval(timer);
        void api.act(panel.id, 'dismiss');
      }
    }, 100);
    return () => clearInterval(timer);
  }, [panel]);
  if (!panel) return null;
  const total = panel.deadline ?? panel.expires;
  const span = Math.max(1, total - (panel.shownAt ?? total - 60_000));
  const remaining = panel.deadline ? Math.max(0, panel.deadline - now) : Math.max(0, left.current);
  const seconds = Math.ceil(remaining / 1000);
  const act = (action) => void api.act(panel.id, action);
  return (
    <div
      className={'panel ' + panel.kind}
      role="alertdialog"
      aria-label={panel.title}
      style={panel.color ? { '--bar': panel.color } : undefined}
      onMouseEnter={() => (hovering.current = true)}
      onMouseLeave={() => (hovering.current = false)}
    >
      <button className="panel-text" onClick={() => act('open')}>
        <span className="panel-bar" aria-hidden="true" />
        <span className="panel-words">
          <strong>{panel.title}</strong>
          <small>
            {panel.countdown
              ? `${panel.countdown.replace('{n}', seconds)} · ${panel.detail}`
              : panel.detail}
          </small>
        </span>
      </button>
      <div className="panel-actions">
        <button className="panel-primary" onClick={() => act(panel.primary.id)}>
          <img src={stillnoteIcon} alt="" />
          {panel.primary.label}
        </button>
        {panel.menu.length > 0 && (
          <button
            className="panel-more"
            aria-label={panel.more}
            title={panel.more}
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              void api.menu(panel.id, box.left, box.bottom + 4);
            }}
          >
            <ChevronDown size={16} />
          </button>
        )}
      </div>
      <span
        className="panel-progress"
        aria-hidden="true"
        style={{ transform: `scaleX(${Math.min(1, remaining / span)})` }}
      />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Panel />);
