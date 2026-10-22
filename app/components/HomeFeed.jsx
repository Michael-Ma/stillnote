import React from 'react';
import { CalendarDays, FileText, LoaderCircle, Plus, RefreshCw, Star } from 'lucide-react';
import { dayLabel, time } from '../format.mjs';
import { eventKey } from '../reminders.mjs';
import { IconButton } from './Content.jsx';

// "11:30 AM" with a quieter meridiem, as in Granola's lists.
function Clock({ value }) {
  const parts = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
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
  const d = new Date(day);
  const today = day === new Date().toDateString();
  return (
    <div className="day-stamp">
      <strong>{d.getDate()}</strong>
      <span>
        <span>
          {new Intl.DateTimeFormat(undefined, { month: 'long' }).format(d)}
          {today && <i className="today-dot" aria-label="Today" />}
        </span>
        <small>{new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d)}</small>
      </span>
    </div>
  );
}

export function HomeFeed({
  data,
  visible,
  view,
  query,
  title,
  calendarBusy,
  calendar,
  newNote,
  openNote,
  importFile,
  setQuery,
}) {
  const groups = Object.entries(
    visible.reduce((all, m) => {
      const label = dayLabel(m.createdAt);
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
            <h1>Coming up</h1>
            {data.calendar.length > 0 && (
              <IconButton
                label="Refresh calendar"
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
                    {!events.length && <p className="no-events">No more events today</p>}
                    {events.map((e) => {
                      const soon =
                        Date.parse(e.start) - Date.now() < 600000 && Date.parse(e.end) > Date.now();
                      return (
                        <button
                          className={'upcoming-event' + (soon ? ' soon' : '')}
                          key={e.id}
                          onClick={() =>
                            newNote({
                              title: e.title,
                              participants: e.participants,
                              notes: e.notes ? `Meeting context\n${e.notes}` : '',
                              eventKey: eventKey(e),
                            })
                          }
                        >
                          <span>
                            <strong>{e.title}</strong>
                            <small>
                              <Clock value={e.start} /> – <Clock value={e.end} />
                            </small>
                          </span>
                          <span className="start-event">{soon ? 'Start now' : 'Take notes'}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            ) : (
              <div className="calendar-empty">
                <CalendarDays size={20} />
                <div>
                  <strong>Your meetings, all in one place</strong>
                  <p>Connect the calendars on your Mac to see what’s next.</p>
                </div>
                <button onClick={calendar} disabled={calendarBusy} className="calendar-connect">
                  {calendarBusy && <LoaderCircle size={13} className="spin" />}
                  {calendarBusy ? 'Connecting…' : 'Connect'}
                </button>
              </div>
            )}
          </div>
        </section>
      )}
      {query && (
        <div className="section-heading search-heading">
          <h1>Search results</h1>
          <button className="text-button" onClick={() => setQuery('')}>
            Clear search
          </button>
        </div>
      )}
      {view !== 'home' && !query && (
        <div className="section-heading feed-heading">
          <h1>{title}</h1>
          <span>
            {visible.length} {visible.length === 1 ? 'note' : 'notes'}
          </span>
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
                    <strong>{m.title || 'New note'}</strong>
                    {m.starred && <Star size={11} fill="currentColor" aria-label="Starred" />}
                    {data.recording?.id === m.id && <span className="record-dot" />}
                  </span>
                  <span className="feed-description">
                    {m.participants || 'Me'}
                    {m.duration > 0 ? ` · ${Math.ceil(m.duration / 60)} min` : ''}
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
              ? 'No notes found'
              : view === 'trash'
                ? 'Nothing in Trash'
                : 'A place for every conversation'}
          </h2>
          <p>
            {query
              ? 'Try another word from a title, your notes, or a transcript.'
              : view === 'trash'
                ? 'Deleted notes will appear here until you restore them.'
                : 'Start a note, press record, and stay in the conversation.'}
          </p>
          {!query && view !== 'trash' && (
            <div>
              <button className="primary" onClick={() => newNote()}>
                <Plus size={15} />
                Quick note
              </button>
              <button className="text-button" onClick={importFile}>
                Import a transcript
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
