import React from 'react';
import { Archive, AudioLines, FileText, Upload } from 'lucide-react';
import { useT } from '../i18n/react.jsx';

// What Stillnote can import, before the file picker opens (app/import-formats.mjs reads them).
export function ImportDialog({ onChoose }) {
  const t = useT();
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
    </div>
  );
}
