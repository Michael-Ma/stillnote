import React from 'react';
import { CalendarDays, LoaderCircle, NotebookPen, Star, Lock, Plus } from 'lucide-react';
import { dayLabel, time } from '../format.mjs';
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
  const days = Object.entries(
    upcoming.reduce((all, e) => {
      (all[new Date(e.start).toDateString()] ??= []).push(e);
      return all;
    }, {}),
  );
  return (
    <div className="home-feed">
      {view === 'home' && !query && (
        <section className="upcoming">
          <div className="section-heading">
            <h1>Coming up</h1>
            <button className="text-button" onClick={calendar} disabled={calendarBusy}>
              {calendarBusy ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <CalendarDays size={13} />
              )}{' '}
              {calendarBusy ? 'Loading…' : data.calendar.length ? 'Refresh' : 'Connect calendar'}
            </button>
          </div>
          <div className="upcoming-card">
            {days.length ? (
              days.map(([day, events]) => (
                <div className="day-events" key={day}>
                  <div className="day-stamp">
                    <strong>{new Date(day).getDate()}</strong>
                    <span>
                      {new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(day))}
                      <small>
                        {new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(
                          new Date(day),
                        )}
                      </small>
                    </span>
                  </div>
                  <div className="day-event-list">
                    {events.map((e) => (
                      <button
                        className="upcoming-event"
                        key={e.id}
                        onClick={() =>
                          newNote({
                            title: e.title,
                            participants: e.participants,
                            notes: e.notes ? `Meeting context\n${e.notes}` : '',
                          })
                        }
                      >
                        <span>
                          <strong>{e.title}</strong>
                          <small>
                            {time(e.start)} – {time(e.end)}
                          </small>
                        </span>
                        <span className="start-event">Take notes</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="calendar-empty">
                <CalendarDays size={22} />
                <div>
                  <strong>
                    {data.calendar.length
                      ? 'You have a little breathing room.'
                      : 'Your meetings, all in one place.'}
                  </strong>
                  <p>
                    {data.calendar.length
                      ? 'No more meetings in your synced calendar this week.'
                      : 'Connect your Mac calendars to see what’s next.'}
                  </p>
                </div>
                {!data.calendar.length && (
                  <button onClick={calendar} disabled={calendarBusy} className="calendar-connect">
                    Connect
                  </button>
                )}
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
                <span className={'meeting-avatar tone-' + (m.title.length % 4)}>
                  {m.participants ? (
                    m.participants.trim()[0].toUpperCase()
                  ) : (
                    <NotebookPen size={17} />
                  )}
                </span>
                <span className="feed-note">
                  <span className="row-title">
                    <strong>{m.title || 'Untitled meeting'}</strong>
                    {m.starred && <Star size={11} fill="currentColor" />}
                    {data.recording?.id === m.id && <span className="record-dot" />}
                  </span>
                  <span className="feed-description">
                    {m.participants || 'Personal note'}
                    {m.duration > 0 ? ` · ${Math.ceil(m.duration / 60)} min` : ''}
                  </span>
                </span>
                <Lock size={11} className="feed-lock" />
                <time>{time(m.createdAt)}</time>
              </button>
            ))}
          </section>
        ))}
      </div>
      {!visible.length && (
        <div className="feed-empty">
          <NotebookPen size={28} />
          <h2>
            {query
              ? 'No notes found.'
              : view === 'trash'
                ? 'Nothing in Trash.'
                : 'A place for every conversation.'}
          </h2>
          <p>
            {query
              ? 'Try another word from a title, your notes, or a transcript.'
              : view === 'trash'
                ? 'Deleted notes will appear here until you restore them.'
                : 'Take a few notes. Stay in the conversation. We’ll help with the details.'}
          </p>
          {!query && view !== 'trash' && (
            <div>
              <button className="secondary" onClick={() => newNote()}>
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
