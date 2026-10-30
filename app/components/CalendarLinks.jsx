import React, { useEffect, useState } from 'react';
import { ClipboardCheck, ExternalLink, LoaderCircle, Trash2 } from 'lucide-react';
import { useT } from '../i18n/react.jsx';
import { cleanError } from '../format.mjs';
import { IconButton } from './Content.jsx';

// Calendars read from a private link (app/calendar-feed.mjs), without the Mac's Calendar app. The
// link is a secret: it goes to main and never comes back; here only its host is shown. While this
// dialog is open, main looks for a calendar link on the clipboard, so copying one in the browser
// and coming back is enough.
export function CalendarLinks({ call, feeds }) {
  const t = useT();
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const look = () =>
      call('calendar-feeds', 'clipboard')
        .then(setCopied)
        .catch(() => {});
    look();
    window.addEventListener('focus', look);
    return () => window.removeEventListener('focus', look);
  }, []);
  const run = async (action, input) => {
    setBusy(true);
    setError('');
    try {
      await call('calendar-feeds', action, input);
      setLink('');
      setCopied(null);
    } catch (e) {
      setError(t(cleanError(e)));
    } finally {
      setBusy(false);
    }
  };
  const guides = [
    [
      'google',
      'Google Calendar',
      t(
        'In Settings, choose your calendar on the left, open Integrate calendar, and copy “Secret address in iCal format”.',
      ),
    ],
    [
      'outlook',
      'Outlook',
      t('Under Shared calendars, publish your calendar with all details, then copy the ICS link.'),
    ],
    [
      'icloud',
      'iCloud',
      t('In Calendar on iCloud.com, make the calendar public and copy its link.'),
    ],
  ];
  return (
    <div className="import-dialog calendar-links">
      <p className="import-hint">
        {t(
          'Stillnote reads your meetings straight from this link, without the Mac’s Calendar app. It works like a password to your calendar, so it stays encrypted on this Mac and out of backups.',
        )}
      </p>
      {error && (
        <p className="modal-error" role="alert">
          {error}
        </p>
      )}
      {feeds.length > 0 && (
        <ul className="calendar-feeds" aria-label={t('Added calendars')}>
          {feeds.map((feed) => (
            <li key={feed.id}>
              <span>
                <strong>{feed.host}</strong>
                {feed.problem && <small role="alert">{t(feed.problem)}</small>}
              </span>
              <IconButton
                label={t('Remove {host}', { host: feed.host })}
                className="small danger"
                disabled={busy}
                onClick={() => run('remove', feed.id)}
              >
                <Trash2 size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <ul className="import-kinds">
        {guides.map(([id, name, text]) => (
          <li key={id}>
            <span>
              <strong>{name}</strong>
              <small>{text}</small>
            </span>
            {id !== 'icloud' && (
              <button
                className="text-button"
                onClick={() =>
                  call('calendar-feeds', 'open', id).catch((e) => setError(t(cleanError(e))))
                }
              >
                {t('Open')}
                <ExternalLink size={12} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {copied && (
        <div className="clipboard-link" role="status">
          <ClipboardCheck size={15} />
          <span>{t('Found a {host} calendar link on your clipboard.', { host: copied.host })}</span>
          <button
            className="primary small"
            disabled={busy}
            onClick={() => run('add', { clipboard: true })}
          >
            {t('Use it')}
          </button>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run('add', { url: link });
        }}
      >
        <label className="field">
          {t('Calendar link')}
          <input
            value={link}
            required
            spellCheck={false}
            autoComplete="off"
            placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
            onChange={(e) => setLink(e.target.value)}
          />
        </label>
        <div className="modal-footer">
          <button className="primary" type="submit" disabled={busy || !link.trim()}>
            {busy && <LoaderCircle size={13} className="spin" />}
            {t('Add calendar')}
          </button>
        </div>
      </form>
    </div>
  );
}
