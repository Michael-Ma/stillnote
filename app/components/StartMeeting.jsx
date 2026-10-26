import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Video } from 'lucide-react';
import { callServices, startableServices } from '../calls.mjs';
import { useT } from '../i18n/react.jsx';

// Start a meeting and record it in one click. The button starts the service used last; the
// chevron offers each service, and choosing one starts it and makes it the default.
export function StartMeeting({ service = 'meet', disabled, onStart }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef();
  const name = callServices[service]?.name ?? callServices.meet.name;
  useEffect(() => {
    if (!open) return;
    const items = () => [...root.current.querySelectorAll('[role="menuitemradio"]')];
    (items().find((item) => item.getAttribute('aria-checked') === 'true') ?? items()[0])?.focus();
    const outside = (e) => {
      if (!root.current?.contains(e.target)) setOpen(false);
    };
    const key = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        root.current?.querySelector('.start-call-more')?.focus();
      }
      if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        const list = items();
        const at = list.indexOf(document.activeElement);
        list[(at + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
      }
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', key, true);
    };
  }, [open]);
  const start = (id) => {
    setOpen(false);
    onStart(id);
  };
  return (
    <div className="start-call" ref={root}>
      <button
        className="start-call-main"
        disabled={disabled}
        title={t('Open a new {service} meeting and start recording', { service: name })}
        onClick={() => start(service)}
      >
        <Video size={14} />
        {t('Start {service}', { service: name })}
      </button>
      <button
        className="start-call-more"
        disabled={disabled}
        aria-label={t('Choose meeting app')}
        title={t('Choose meeting app')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="start-call-menu" role="menu" aria-label={t('Start a meeting and record')}>
          <p aria-hidden="true">{t('Start a meeting and record')}</p>
          {startableServices.map((id) => (
            <button
              key={id}
              role="menuitemradio"
              aria-checked={id === service}
              onClick={() => start(id)}
            >
              <span className={'call-mark ' + id} aria-hidden="true">
                <Video size={13} />
              </span>
              <span>
                <strong>{callServices[id].name}</strong>
                <small>{new URL(callServices[id].start).host}</small>
              </span>
              {id === service && <Check size={13} className="call-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
