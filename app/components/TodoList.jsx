import React, { useRef, useState } from 'react';
import { LoaderCircle, Pencil, Plus, Trash2 } from 'lucide-react';
import { AiConnect } from './AiConnect.jsx';
import { IconButton } from './Content.jsx';
import { date, dateFormat, duration } from '../format.mjs';
import { backfillIds, dayOf, dueState, todoLists, todosByDue } from '../todos.mjs';
import { useT } from '../i18n/react.jsx';

// Finding todos in past meetings spends the user's plan, so it only starts from this button, and
// says what it will cost first.
function ScanBanner({ meetings, scans, progress, onScan, onCancel }) {
  const t = useT();
  const [days, setDays] = useState(30);
  if (progress.running)
    return (
      <div className="todo-scan" role="status">
        <LoaderCircle size={15} className="spin" aria-hidden="true" />
        <div>
          <strong>
            {t('Finding todos… {done} of {total} meetings', {
              done: progress.done,
              total: progress.total,
            })}
          </strong>
          <small>{t('You can keep working. Meetings already read stay read if you stop.')}</small>
        </div>
        <button className="secondary small" onClick={onCancel}>
          {t('Stop')}
        </button>
      </div>
    );
  const due = backfillIds(meetings, scans, null).length;
  if (!due) return null;
  const chosen = backfillIds(meetings, scans, days).length;
  return (
    <div className="todo-scan">
      <div>
        <strong>
          {t.count(due, '{n} meeting not read for todos', '{n} meetings not read for todos')}
        </strong>
        <small>
          {t.count(
            chosen,
            'Uses {n} request from your AI plan.',
            'Uses {n} requests from your AI plan.',
          )}
        </small>
      </div>
      <select
        className="chip-select"
        aria-label={t('Meetings to read')}
        value={days ?? 'all'}
        onChange={(e) => setDays(e.target.value === 'all' ? null : Number(e.target.value))}
      >
        <option value={30}>{t('Last 30 days')}</option>
        <option value={90}>{t('Last 90 days')}</option>
        <option value="all">{t('All meetings')}</option>
      </select>
      <button className="primary small" disabled={!chosen} onClick={() => onScan(days)}>
        {t('Find todos')}
      </button>
    </div>
  );
}

// Adding and editing share a form. It submits natively, so the Enter that picks a word in a Chinese
// input method never saves half a sentence.
function TodoForm({ todo, onSave, onCancel }) {
  const t = useT();
  const field = useRef(null);
  const [task, setTask] = useState(todo?.text ?? '');
  const [day, setDay] = useState(todo?.dueDate ?? '');
  const editing = !!todo;
  const typed = task.trim();
  const clear = () => {
    setTask('');
    setDay('');
  };
  async function save(e) {
    e.preventDefault();
    if (!typed || !(await onSave({ text: typed, dueDate: day || null })) || editing) return;
    clear();
    field.current.focus();
  }
  return (
    <form
      className="todo-form"
      onSubmit={save}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
        if (editing) onCancel();
        else clear();
      }}
    >
      {!editing && <Plus size={15} aria-hidden="true" />}
      <input
        ref={field}
        autoFocus={editing}
        aria-label={editing ? t('Todo') : t('Add a todo')}
        placeholder={editing ? undefined : t('Add a todo')}
        maxLength={500}
        value={task}
        onChange={(e) => setTask(e.target.value)}
      />
      {(editing || typed) && (
        <>
          <input
            type="date"
            aria-label={t('Deadline')}
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
          <button className="primary small" disabled={!typed}>
            {editing ? t('Save') : t('Add')}
          </button>
        </>
      )}
      {editing && (
        <button type="button" className="secondary small" onClick={onCancel}>
          {t('Cancel')}
        </button>
      )}
    </form>
  );
}

// A real day when there is one, with what was said kept for hovering; otherwise what was said.
function Deadline({ todo, today, done }) {
  const t = useT();
  if (!todo.dueDate) return todo.due ? <span>{todo.due}</span> : null;
  const state = dueState(todo.dueDate, today);
  const noon = `${todo.dueDate}T12:00:00`;
  const label =
    state === 'today'
      ? t('Today')
      : state === 'tomorrow'
        ? t('Tomorrow')
        : todo.dueDate.slice(0, 4) === today.slice(0, 4)
          ? date(noon, t.locale)
          : dateFormat(t.locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(
              new Date(noon),
            );
  return (
    <span
      className={state === 'overdue' && !done ? 'todo-overdue' : undefined}
      title={todo.due ?? undefined}
    >
      {label}
    </span>
  );
}

function TodoRow({ todo, meeting, today, onOpen, onChange, onDelete, onEvidence }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const done = !!todo.doneAt,
    unclear = todo.assignee === 'unclear',
    theirs = todo.assignee === 'other';
  async function save(fields) {
    const same = fields.text === todo.text && fields.dueDate === (todo.dueDate ?? null);
    const saved = same || (await onChange(todo.id, fields));
    if (saved) setEditing(false);
    return saved;
  }
  if (editing)
    return (
      <li className="todo-row editing">
        <TodoForm todo={todo} onSave={save} onCancel={() => setEditing(false)} />
      </li>
    );
  return (
    <li className={'todo-row' + (done ? ' done' : '') + (unclear ? ' unclear' : '')}>
      {theirs ? (
        <span className="todo-bullet" aria-hidden="true" />
      ) : (
        <input
          type="checkbox"
          checked={done}
          aria-label={
            done
              ? t('Mark “{task}” as not done', { task: todo.text })
              : t('Mark “{task}” as done', { task: todo.text })
          }
          onChange={(e) => onChange(todo.id, { done: e.target.checked })}
        />
      )}
      <div className="todo-body">
        <p>{todo.text}</p>
        {(unclear || todo.dueDate || todo.due || (theirs && todo.owner) || meeting) && (
          <div className="todo-meta">
            {unclear && <span className="todo-flag">{t('Might not be yours')}</span>}
            {theirs && todo.owner && <span>{todo.owner}</span>}
            <Deadline todo={todo} today={today} done={done} />
            {meeting && (
              <button className="todo-from" onClick={() => onOpen(meeting)}>
                {meeting.title}
              </button>
            )}
          </div>
        )}
        {todo.evidence && (
          <button className="todo-source" onClick={() => onEvidence(todo)}>
            <span>“{todo.evidence.quote}”</span>
            {todo.evidence.from === 'transcript' && (
              <time>{duration(todo.evidence.timestamp)}</time>
            )}
          </button>
        )}
      </div>
      <div className={'todo-actions' + (unclear ? ' shown' : '')}>
        {(unclear || theirs) && (
          <button
            className="text-button"
            onClick={() => onChange(todo.id, { assignee: 'me' })}
            aria-label={t('“{task}” is mine', { task: todo.text })}
          >
            {t('It’s mine')}
          </button>
        )}
        {!theirs && !done && todo.meetingId && (
          <button
            className="text-button"
            onClick={() => onChange(todo.id, { assignee: 'other' })}
            aria-label={t('“{task}” is not mine', { task: todo.text })}
          >
            {t('Not mine')}
          </button>
        )}
        <IconButton
          className="small"
          label={t('Edit “{task}”', { task: todo.text })}
          title={t('Edit')}
          onClick={() => setEditing(true)}
        >
          <Pencil size={14} />
        </IconButton>
        <IconButton
          className="small"
          label={t('Delete “{task}”', { task: todo.text })}
          title={t('Delete')}
          onClick={() => onDelete(todo)}
        >
          <Trash2 size={14} />
        </IconButton>
      </div>
    </li>
  );
}

function Groups({ groups, rowProps, onOpen }) {
  const t = useT();
  return groups.map(({ meeting, todos }) => (
    <section className="todo-group" key={meeting?.id ?? 'added'}>
      {meeting ? (
        <button className="todo-meeting" onClick={() => onOpen(meeting)}>
          <strong>{meeting.title}</strong>
          <small>{date(meeting.createdAt, t.locale)}</small>
        </button>
      ) : (
        <h2 className="todo-heading">{t('Added by you')}</h2>
      )}
      <ul>
        {todos.map((todo) => (
          <TodoRow key={todo.id} todo={todo} {...rowProps} />
        ))}
      </ul>
    </section>
  ));
}

// With no meeting heading above them, todos say which meeting they came from.
function DueParts({ groups, meetings, today, rowProps, onOpen }) {
  const t = useT();
  const headings = {
    overdue: t('Overdue'),
    today: t('Today'),
    later: t('Upcoming'),
    none: t('No deadline'),
  };
  const meetingOf = new Map(meetings.map((meeting) => [meeting.id, meeting]));
  return todosByDue(groups, today).map(({ key, todos }) => (
    <section className="todo-group" key={key}>
      <h2 className={'todo-heading' + (key === 'overdue' ? ' todo-overdue' : '')}>
        {headings[key]}
      </h2>
      <ul>
        {todos.map((todo) => (
          <TodoRow
            key={todo.id}
            todo={todo}
            meeting={meetingOf.get(todo.meetingId)}
            onOpen={onOpen}
            {...rowProps}
          />
        ))}
      </ul>
    </section>
  ));
}

function Fold({ label, groups, ...props }) {
  const count = groups.reduce((sum, group) => sum + group.todos.length, 0);
  if (!count) return null;
  return (
    <details className="todo-fold">
      <summary>
        {label} <span>{count}</span>
      </summary>
      <Groups groups={groups} {...props} />
    </details>
  );
}

export function TodoList({
  data,
  ai,
  aiActions,
  onOpen,
  onEvidence,
  onAdd,
  onChange,
  onDelete,
  onScan,
  onCancelScan,
  onView,
}) {
  const t = useT();
  const { open, done, others } = todoLists(data.todos, data.meetings);
  const today = dayOf(Date.now());
  const groupProps = { rowProps: { today, onChange, onDelete, onEvidence }, onOpen };
  const scanned = Object.keys(data.todoScans).length > 0;
  const view = data.settings.todoView === 'due' ? 'due' : 'meeting';
  const views = { meeting: t('By meeting'), due: t('By deadline') };
  return (
    <div className="home-feed todo-page">
      <div className="section-heading">
        <h1>{t('Todos')}</h1>
        <div className="view-switch" role="tablist" aria-label={t('Todo view')}>
          {Object.entries(views).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={view === key}
              className={view === key ? 'active' : ''}
              onClick={() => onView(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {ai.ready ? (
        <ScanBanner
          meetings={data.meetings}
          scans={data.todoScans}
          progress={data.todoProgress}
          onScan={onScan}
          onCancel={onCancelScan}
        />
      ) : (
        <AiConnect ai={ai} actions={aiActions} title={t('Connect an AI to find your todos')} />
      )}
      <TodoForm onSave={onAdd} />
      {open.length > 0 ? (
        view === 'due' ? (
          <DueParts groups={open} meetings={data.meetings} today={today} {...groupProps} />
        ) : (
          <Groups groups={open} {...groupProps} />
        )
      ) : (
        <div className="document-empty">
          <h2>{scanned ? t('Nothing to do') : t('No todos yet')}</h2>
          <p>
            {scanned
              ? t('Todos assigned to you in meetings will appear here.')
              : t('After a meeting, what was assigned to you shows up here.')}
          </p>
        </div>
      )}
      <Fold label={t('Done')} groups={done} {...groupProps} />
      <Fold label={t('Assigned to others')} groups={others} {...groupProps} />
    </div>
  );
}
