import React, { useEffect, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  AudioLines,
  ChevronRight,
  FileText,
  LoaderCircle,
  Search,
  Upload,
} from 'lucide-react';
import { useT } from '../i18n/react.jsx';
import { cleanError, date } from '../format.mjs';

// What Stillnote can import, before the file picker opens (app/import-formats.mjs reads them),
// and the apps it imports from directly (app/source-import.mjs).
export function ImportDialog({ onChoose, call, progress, onImported }) {
  const t = useT();
  const [source, setSource] = useState(null);
  if (source)
    return (
      <SourceImport
        source={source}
        call={call}
        progress={progress?.source === source ? progress : null}
        onBack={() => setSource(null)}
        onImported={onImported}
      />
    );
  const kinds = [
    [
      AudioLines,
      t('Meeting transcripts'),
      t(
        'Captions from Zoom, Teams or Google Meet (.vtt), subtitles (.srt), and text exports from Otter or Fireflies (.txt), split by speaker and time.',
      ),
    ],
    [
      FileText,
      t('Notes'),
      t(
        'Markdown or text from Notion, Obsidian, Granola and other apps (.md, .txt). For a Notion export, unzip it and choose the folder.',
      ),
    ],
    [
      Archive,
      t('Stillnote backup'),
      t('A notebook backup (.json) from Settings → Notebook. Notes already here are kept.'),
    ],
  ];
  const apps = [
    ['granola', 'Granola', t('Meeting notes, AI summaries and transcripts.')],
    ['notion', 'Notion', t('Pages, including Notion AI meeting notes.')],
  ];
  return (
    <div className="import-dialog">
      <ul className="import-kinds">
        {kinds.map(([Icon, title, text]) => (
          <li key={title}>
            <span className="import-icon" aria-hidden="true">
              <Icon size={16} />
            </span>
            <span>
              <strong>{title}</strong>
              <small>{text}</small>
            </span>
          </li>
        ))}
      </ul>
      <p className="import-hint">
        {t('You can choose several files or a folder. Importing the same file again adds nothing.')}
      </p>
      <div className="modal-footer">
        <button className="primary" onClick={onChoose}>
          <Upload size={14} />
          {t('Choose files or a folder…')}
        </button>
      </div>
      <h3 className="import-section">{t('Or straight from another app')}</h3>
      <div className="import-apps">
        {apps.map(([id, name, text]) => (
          <button key={id} className="import-app" onClick={() => setSource(id)}>
            <span className={'import-app-mark ' + id} aria-hidden="true">
              {name[0]}
            </span>
            <span>
              <strong>{t('From {app}', { app: name })}</strong>
              <small>{text}</small>
            </span>
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}

const ranges = ['last_7_days', 'last_30_days', 'last_90_days', 'last_year', 'everything'];

// Connect one app, list what it has, and import the chosen items.
function SourceImport({ source, call, progress, onBack, onImported }) {
  const t = useT();
  const name = { granola: 'Granola', notion: 'Notion' }[source];
  const [status, setStatus] = useState(null);
  const [items, setItems] = useState(null);
  const [chosen, setChosen] = useState(new Set());
  const [range, setRange] = useState('last_30_days');
  const [query, setQuery] = useState('meeting');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const run = async (kind, fn) => {
    setBusy(kind);
    setError('');
    try {
      return await fn();
    } catch (e) {
      setError(t(cleanError(e)));
    } finally {
      setBusy('');
    }
  };
  const list = (input) =>
    run('list', async () => {
      const found = await call('import-source', 'list', source, input);
      setItems(found);
      setChosen(new Set(found.filter((item) => !item.imported).map((item) => item.id)));
    });
  const connected = status?.[source]?.connected;
  useEffect(() => {
    run('status', async () => setStatus(await call('import-source', 'status')));
  }, [source]);
  useEffect(() => {
    if (connected) list(source === 'granola' ? { range } : { query });
  }, [connected, range]);
  const rangeLabel = {
    last_7_days: t('Last 7 days'),
    last_30_days: t('Last 30 days'),
    last_90_days: t('Last 90 days'),
    last_year: t('Last year'),
    everything: t('Everything'),
  };
  const toggle = (id) =>
    setChosen((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const fresh = (items ?? []).filter((item) => !item.imported);
  return (
    <div className="import-dialog source-import">
      <button className="text-button import-back" onClick={onBack} disabled={busy === 'import'}>
        <ArrowLeft size={14} />
        {t('All import options')}
      </button>
      {error && (
        <p className="modal-error" role="alert">
          {error}
        </p>
      )}
      {!status ? (
        <p className="import-hint">
          <LoaderCircle size={13} className="spin" /> {t('Checking…')}
        </p>
      ) : !connected ? (
        <>
          <p>
            {t(
              'Stillnote signs in to {app} in your browser and only reads: it never changes anything in {app}. The connection stays on this Mac, and you can disconnect at any time.',
              { app: name },
            )}
          </p>
          {source === 'granola' && (
            <p className="import-hint">
              {t('On Granola’s free plan, only the last 30 days are shared, without transcripts.')}
            </p>
          )}
          <div className="modal-footer">
            {busy === 'connect' ? (
              <>
                <span className="import-hint">
                  <LoaderCircle size={13} className="spin" />{' '}
                  {t('Finish signing in in your browser…')}
                </span>
                <button onClick={() => call('import-source', 'cancel', source)}>
                  {t('Cancel')}
                </button>
              </>
            ) : (
              <button
                className="primary"
                disabled={!!busy}
                onClick={() =>
                  run('connect', async () =>
                    setStatus(await call('import-source', 'connect', source)),
                  )
                }
              >
                {t('Connect {app}', { app: name })}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="source-controls">
            {source === 'granola' ? (
              <select
                className="chip-select"
                aria-label={t('Meetings from')}
                value={range}
                disabled={!!busy}
                onChange={(e) => setRange(e.target.value)}
              >
                {ranges.map((value) => (
                  <option key={value} value={value}>
                    {rangeLabel[value]}
                  </option>
                ))}
              </select>
            ) : (
              <form
                className="source-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  list({ query });
                }}
              >
                <Search size={14} aria-hidden="true" />
                <input
                  aria-label={t('Search Notion')}
                  value={query}
                  maxLength={200}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button type="submit" disabled={!!busy}>
                  {t('Search')}
                </button>
              </form>
            )}
            {fresh.length > 0 && (
              <button
                className="text-button"
                disabled={!!busy}
                onClick={() =>
                  setChosen(
                    chosen.size === fresh.length
                      ? new Set()
                      : new Set(fresh.map((item) => item.id)),
                  )
                }
              >
                {chosen.size === fresh.length ? t('Select none') : t('Select all')}
              </button>
            )}
          </div>
          {busy === 'list' || !items ? (
            <p className="import-hint">
              <LoaderCircle size={13} className="spin" /> {t('Loading from {app}…', { app: name })}
            </p>
          ) : items.length === 0 ? (
            <p className="import-hint">{t('Nothing found.')}</p>
          ) : (
            <ul className="source-items" aria-label={t('Items in {app}', { app: name })}>
              {items.map((item) => (
                <li key={item.id}>
                  <label className={item.imported ? 'imported' : ''}>
                    <input
                      type="checkbox"
                      disabled={item.imported || !!busy}
                      checked={item.imported || chosen.has(item.id)}
                      onChange={() => toggle(item.id)}
                    />
                    <span>
                      <strong>{item.title}</strong>
                      <small>
                        {[item.date && date(item.date, t.locale), item.participants]
                          .filter(Boolean)
                          .join(' · ')}
                      </small>
                    </span>
                    {item.imported && <em>{t('Imported')}</em>}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="modal-footer">
            <button
              className="text-button danger"
              disabled={!!busy}
              onClick={() =>
                run('disconnect', async () => {
                  setStatus(await call('import-source', 'disconnect', source));
                  setItems(null);
                })
              }
            >
              {t('Disconnect {app}', { app: name })}
            </button>
            {busy === 'import' && progress?.total ? (
              <span className="import-hint">
                <LoaderCircle size={13} className="spin" />{' '}
                {t('Importing {done} of {total}…', { done: progress.done, total: progress.total })}
              </span>
            ) : null}
            <button
              className="primary"
              disabled={!!busy || chosen.size === 0}
              onClick={() =>
                run('import', async () =>
                  onImported(await call('import-source', 'import', source, [...chosen]), name),
                )
              }
            >
              {t.count(chosen.size, 'Import {n} item', 'Import {n} items')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
