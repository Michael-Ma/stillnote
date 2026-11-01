import React, { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { AiConnect } from './AiConnect.jsx';
import { date, duration } from '../format.mjs';
import { backfillIds, todoLists } from '../todos.mjs';
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

function NamesPrompt({ onSave }) {
  const t = useT();
  const [names, setNames] = useState('');
  return (
    <form
      className="todo-names"
      onSubmit={(e) => {
        e.preventDefault();
        if (names.trim()) onSave(names.trim());
      }}
    >
      <div>
        <label htmlFor="todo-names">{t('What do people call you in meetings?')}</label>
        <small>
          {t('Add every name you go by, separated by commas, to spot todos meant for you.')}
        </small>
      </div>
      <input
        id="todo-names"
        value={names}
        maxLength={300}
        onChange={(e) => setNames(e.target.value)}
      />
      <button className="secondary small" type="submit" disabled={!names.trim()}>
        {t('Save')}
      </button>
    </form>
  );
}

function TodoRow({ todo, onChange, onDismiss, onEvidence }) {
  const t = useT();
  const done = !!todo.doneAt,
    unclear = todo.assignee === 'unclear',
    theirs = todo.assignee === 'other';
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
        {(unclear || todo.due || todo.owner) && (
          <div className="todo-meta">
            {unclear && <span className="todo-flag">{t('Might not be yours')}</span>}
            {theirs && todo.owner && <span>{todo.owner}</span>}
            {todo.due && <span>{todo.due}</span>}
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
        {!theirs && !done && (
          <button
            className="text-button"
            onClick={() => onChange(todo.id, { assignee: 'other' })}
            aria-label={t('“{task}” is not mine', { task: todo.text })}
          >
            {t('Not mine')}
          </button>
        )}
        {!done && (
          <button
            className="text-button"
            onClick={() => onDismiss(todo)}
            aria-label={t('“{task}” is not a todo', { task: todo.text })}
          >
            {t('Not a todo')}
          </button>
        )}
      </div>
    </li>
  );
}

function Groups({ groups, rowProps, onOpen }) {
  const t = useT();
  return groups.map(({ meeting, todos }) => (
    <section className="todo-group" key={meeting.id}>
      <button className="todo-meeting" onClick={() => onOpen(meeting)}>
        <strong>{meeting.title}</strong>
        <small>{date(meeting.createdAt, t.locale)}</small>
      </button>
      <ul>
        {todos.map((todo) => (
          <TodoRow key={todo.id} todo={todo} {...rowProps} />
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
  onChange,
  onDismiss,
  onScan,
  onCancelScan,
  onSaveNames,
}) {
  const t = useT();
  const { open, done, others } = todoLists(data.todos, data.meetings);
  const groupProps = { rowProps: { onChange, onDismiss, onEvidence }, onOpen };
  const scanned = Object.keys(data.todoScans).length > 0;
  return (
    <div className="home-feed todo-page">
      <div className="section-heading">
        <h1>{t('Todos')}</h1>
      </div>
      {!data.settings.myNames?.trim() && <NamesPrompt onSave={onSaveNames} />}
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
      {open.length > 0 ? (
        <Groups groups={open} {...groupProps} />
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
