import React from 'react';
import { CalendarDays, FileText, LoaderCircle, Plus, RefreshCw, Star, Video } from 'lucide-react';
import { dateFormat, dayLabel } from '../format.mjs';
import { eventKey, eventNote } from '../reminders.mjs';
import { callServices, meetingLink } from '../calls.mjs';
import { IconButton } from './Content.jsx';
import { useT } from '../i18n/react.jsx';

// "11:30 AM" with a quieter meridiem, as in Granola's lists.
function Clock({ value }) {
  const t = useT();
  const parts = dateFormat(t.locale, { hour: 'numeric', minute: '2-digit' })
    .formatToParts(new Date(value))
    .map((p, i) =>
      p.type === 'dayPeriod' ? (
        <small key={i}>{p.value}</small>
      ) : (
        <React.Fragment key={i}>{p.value}</React.Fragment>
      ),
    );
  return <>{parts}</>;
}

function DayStamp({ day }) {
  const t = useT();
  const d = new Date(day);
  const today = day === new Date().toDateString();
  return (
    <div className="day-stamp">
      <strong>{d.getDate()}</strong>
      <span>
        <span>
          {dateFormat(t.locale, { month: 'long' }).format(d)}
          {today && <i className="today-dot" aria-label={t('Today')} />}
        </span>
        <small>{dateFormat(t.locale, { weekday: 'short' }).format(d)}</small>
      </span>
    </div>
  );
}

export function HomeFeed({
  data,
  visible,
  view,
  onEmptyTrash,
  query,
  title,
  calendarBusy,
  calendar,
  newNote,
  startMeeting,
  joinMeeting,
  callPending,
  openNote,
  importFile,
  setQuery,
}) {
  const t = useT();
  const groups = Object.entries(
    visible.reduce((all, m) => {
      const label = dayLabel(m.createdAt, t);
      (all[label] ??= []).push(m);
      return all;
    }, {}),
  );
  const upcoming = data.calendar.filter((e) => Date.parse(e.end) > Date.now()).slice(0, 6);
  const byDay = upcoming.reduce((all, e) => {
    (all[new Date(e.start).toDateString()] ??= []).push(e);
    return all;
  }, {});
  const todayKey = new Date().toDateString();
  // Granola always anchors the card on today, even when nothing else is left.
  const days = data.calendar.length
    ? Object.entries({ [todayKey]: byDay[todayKey] ?? [], ...byDay })
    : [];
  return (
    <div className="home-feed">
      {view === 'home' && !query && (
        <section className="upcoming">
          <div className="section-heading">
            <h1>{t('Coming up')}</h1>
            {data.calendar.length > 0 && (
              <IconButton
                label={t('Refresh calendar')}
                className="small"
                onClick={calendar}
                disabled={calendarBusy}
              >
                <RefreshCw size={14} className={calendarBusy ? 'spin' : ''} />
              </IconButton>
            )}
          </div>
          <div className="upcoming-card">
            {days.length ? (
              days.map(([day, events]) => (
                <div className="day-events" key={day}>
                  <DayStamp day={day} />
                  <div className="day-event-list">
                    {!events.length && <p className="no-events">{t('No more events today')}</p>}
                    {events.map((e) => {
                      const soon =
                        Date.parse(e.start) - Date.now() < 600000 && Date.parse(e.end) > Date.now();
                      const note = eventNote(e, t);
                      const link = meetingLink(e);
                      // The row opens the meeting's note; "Start now" also starts recording, and
                      // "Join & record" opens the meeting's call as well.
                      return (
                        <div className={'upcoming-event' + (soon ? ' soon' : '')} key={eventKey(e)}>
                          <button className="upcoming-open" onClick={() => newNote(note)}>
                            <span>
                              <strong>{e.title}</strong>
                              <small>
                                <Clock value={e.start} /> – <Clock value={e.end} />
                                {link && (
                                  <span className="call-badge">
                                    <Video size={12} aria-hidden="true" />
                                    {callServices[link.service].name}
                                  </span>
                                )}
                              </small>
                            </span>
                            {!soon && <span className="start-event">{t('Take notes')}</span>}
                          </button>
                          {/* Starting now records at once, so it is offered only near the start. */}
                          {soon && link ? (
                            <button
                              className="start-event join-event"
                              title={t('Join the call and start recording')}
                              disabled={callPending}
                              onClick={() => joinMeeting(e)}
                            >
                              {t('Join & record')}
                            </button>
                          ) : (
                            soon && (
                              <button
                                className="start-event"
                                title={t('Open the note and start recording')}
                                disabled={callPending}
                                onClick={() => startMeeting(note)}
                              >
                                {t('Start now')}
                              </button>
                            )
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            ) : (
              <div className="calendar-empty">
                <CalendarDays size={20} />
                <div>
                  <strong>{t('Your meetings, all in one place')}</strong>
                  <p>{t('Connect the calendars on your Mac to see what’s next.')}</p>
                </div>
                <button onClick={calendar} disabled={calendarBusy} className="calendar-connect">
                  {calendarBusy && <LoaderCircle size={13} className="spin" />}
                  {calendarBusy ? t('Connecting…') : t('Connect')}
                </button>
              </div>
            )}
          </div>
        </section>
      )}
      {query && (
        <div className="section-heading search-heading">
          <h1>{t('Search results')}</h1>
          <button className="text-button" onClick={() => setQuery('')}>
            {t('Clear search')}
          </button>
        </div>
      )}
      {view !== 'home' && !query && (
        <div className="section-heading feed-heading">
          <h1>{title}</h1>
          <span>{t.count(visible.length, '{n} note', '{n} notes')}</span>
          {view === 'trash' && visible.length > 0 && (
            <button className="text-button danger empty-trash" onClick={onEmptyTrash}>
              {t('Empty Trash')}
            </button>
          )}
        </div>
      )}
      <div className="meeting-feed">
        {groups.map(([day, meetings]) => (
          <section className="note-group" key={day}>
            <h2>{day}</h2>
            {meetings.map((m) => (
              <button className="note-row" key={m.id} onClick={() => openNote(m)}>
                <span
                  className={
                    'meeting-avatar ' +
                    (m.participants.trim() ? 'tone-' + (m.participants.charCodeAt(0) % 4) : 'doc')
                  }
                >
                  {m.participants.trim() ? (
                    m.participants.trim()[0].toUpperCase()
                  ) : (
                    <FileText size={15} />
                  )}
                </span>
                <span className="feed-note">
                  <span className="row-title">
                    <strong>{m.title || t('New note')}</strong>
                    {m.starred && <Star size={11} fill="currentColor" aria-label={t('Starred')} />}
                    {data.recording?.id === m.id && <span className="record-dot" />}
                  </span>
                  <span className="feed-description">
                    {m.participants || t('Me')}
                    {m.duration > 0 ? ` · ${t('{n} min', { n: Math.ceil(m.duration / 60) })}` : ''}
                  </span>
                </span>
                <time>
                  <Clock value={m.createdAt} />
                </time>
              </button>
            ))}
          </section>
        ))}
      </div>
      {!visible.length && (
        <div className="feed-empty">
          <FileText size={26} />
          <h2>
            {query
              ? t('No notes found')
              : view === 'trash'
                ? t('Nothing in Trash')
                : t('A place for every conversation')}
          </h2>
          <p>
            {query
              ? t('Try another word from a title, your notes, or a transcript.')
              : view === 'trash'
                ? t('Deleted notes stay here until you restore them or delete them forever.')
                : t('Start a note, press record, and stay in the conversation.')}
          </p>
          {!query && view !== 'trash' && (
            <div>
              <button className="primary" onClick={() => newNote()}>
                <Plus size={15} />
                {t('Quick note')}
              </button>
              <button className="text-button" onClick={importFile}>
                {t('Import notes or transcripts')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
