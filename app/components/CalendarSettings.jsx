import React, { useEffect, useState } from 'react';
import { ExternalLink, LoaderCircle, Unplug } from 'lucide-react';
import { CalendarLinks } from './CalendarLinks.jsx';
import { Toggle } from './Content.jsx';
import { useT } from '../i18n/react.jsx';

// Everything Stillnote reads meetings from, in one place: the Mac's calendars, each of which can be
// turned off, and calendar links.
export function CalendarSettings({ data, call, setting, guard, calendar, calendarBusy }) {
  const t = useT();
  const connected = !!data.settings.calendarConnected;
  const hidden = data.settings.hiddenCalendars ?? [];
  const [loading, setLoading] = useState(connected);
  // Opening this page, or coming back from System Settings with a new account, shows what is there.
  useEffect(() => {
    if (!connected) return;
    const look = () => call('calendar').catch(() => {});
    look().finally(() => setLoading(false));
    window.addEventListener('focus', look);
    return () => window.removeEventListener('focus', look);
  }, [connected]);
  const accounts = Object.entries(
    data.macCalendars.reduce((all, item) => {
      (all[item.account || t('On this Mac')] ??= []).push(item);
      return all;
    }, {}),
  );
  const show = (id, on) =>
    guard(() =>
      setting('hiddenCalendars', on ? hidden.filter((item) => item !== id) : [...hidden, id]),
    );
  return (
    <section className="calendar-settings">
      <h3>{t('Calendars')}</h3>
      <p className="settings-lead">
        {t(
          'Stillnote shows the coming week from these calendars, and reminds you before meetings.',
        )}
      </p>
      <h4 className="calendar-heading">{t('Calendars on this Mac')}</h4>
      {!connected ? (
        <div className="setting-row">
          <div>
            <small>
              {t('Reads the accounts in the Mac’s Calendar app, such as Google or Outlook.')}
            </small>
          </div>
          <button
            className="secondary"
            disabled={calendarBusy}
            onClick={() => calendar({ mac: true })}
          >
            {calendarBusy && <LoaderCircle size={13} className="spin" />}
            {calendarBusy ? t('Connecting…') : t('Connect')}
          </button>
        </div>
      ) : (
        <>
          {accounts.length === 0 && (
            <p className="import-hint">
              {loading ? t('Checking…') : t('No calendars on this Mac yet.')}
            </p>
          )}
          {accounts.map(([account, calendars]) => (
            <div key={account} className="calendar-account">
              <small>{account}</small>
              <ul aria-label={account}>
                {calendars.map((item) => (
                  <li key={item.id}>
                    <span
                      className="calendar-dot"
                      style={item.color ? { background: item.color } : undefined}
                      aria-hidden="true"
                    />
                    <label htmlFor={`calendar-${item.id}`}>{item.name}</label>
                    <Toggle
                      id={`calendar-${item.id}`}
                      checked={!hidden.includes(item.id)}
                      onChange={(on) => show(item.id, on)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="settings-buttons">
            <button
              className="secondary"
              onClick={() => guard(() => call('calendar-mac', 'open-accounts'))}
            >
              <ExternalLink size={14} />
              {t('Add an account in macOS')}
            </button>
            <button
              className="secondary"
              onClick={() => guard(() => call('calendar-mac', 'disconnect'))}
            >
              <Unplug size={14} />
              {t('Disconnect')}
            </button>
          </div>
          <p className="settings-foot">
            {t(
              'Disconnecting removes these meetings from Stillnote and keeps your notes. macOS keeps Stillnote’s Calendar permission until you turn it off in System Settings.',
            )}
          </p>
        </>
      )}
      <h4 className="calendar-heading">{t('Calendar links')}</h4>
      <CalendarLinks call={call} feeds={data.calendarFeeds} />
    </section>
  );
}
