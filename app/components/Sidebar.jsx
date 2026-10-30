import React, { useEffect, useRef, useState } from 'react';
import {
  Folder,
  Home,
  Lock,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { IconButton } from './Content.jsx';
import { useT } from '../i18n/react.jsx';

const plans = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };

export function Sidebar({
  view,
  chatOpen,
  folders,
  query,
  onQuery,
  searchRef,
  searchOpen,
  setSearchOpen,
  navigate,
  openChat,
  newFolder,
  renameFolder,
  deleteFolder,
  importFile,
  openSettings,
  ai,
  icon,
}) {
  const t = useT();
  // The folder whose menu is open, and where: under its ⋯ button, or where it was right-clicked.
  const [menu, setMenu] = useState(null);
  const item = (key, label, Icon, onClick = () => navigate(key)) => (
    <button
      className={view === key && (key !== 'home' || !chatOpen) ? 'active' : ''}
      onClick={onClick}
      aria-current={view === key ? 'page' : undefined}
    >
      <Icon size={16} />
      <span>{label}</span>
    </button>
  );
  const plan = ai.provider === 'claude' ? plans[ai.claude.subscriptionType] : null;
  return (
    <aside className="sidebar">
      <div className="window-space">
        <IconButton
          label={t('Search')}
          title={t('Search {shortcut}', { shortcut: '⌘K' })}
          className={'search-toggle' + (searchOpen ? ' active' : '')}
          onClick={() => setSearchOpen(!searchOpen)}
        >
          <Search size={16} />
        </IconButton>
      </div>
      {searchOpen && (
        <label className="search">
          <Search size={14} />
          <input
            ref={searchRef}
            autoFocus
            aria-label={t('Search notes')}
            placeholder={t('Search notes')}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                onQuery('');
                setSearchOpen(false);
              }
            }}
          />
          <button
            className="search-clear"
            aria-label={t('Close search')}
            onClick={() => {
              onQuery('');
              setSearchOpen(false);
            }}
          >
            <X size={13} />
          </button>
        </label>
      )}
      <nav aria-label={t('Notebook')}>
        {item('home', t('Home'), Home)}
        {item('chat', t('Chat'), MessageCircle, openChat)}
        {item('starred', t('Starred'), Star)}
      </nav>
      <div className="nav-label">
        <span>{t('Spaces')}</span>
        <IconButton label={t('New folder')} className="small" onClick={newFolder}>
          <Plus size={14} />
        </IconButton>
      </div>
      <nav aria-label={t('Folders')} className="folders">
        <button
          className={'my-notes' + (view === 'all' ? ' active' : '')}
          onClick={() => navigate('all')}
        >
          <span className="space-icon">
            <Lock size={12} />
          </span>
          <span>{t('My notes')}</span>
        </button>
        {folders.map((f) => (
          <div
            key={f.id}
            className={'folder-row' + (menu?.folder.id === f.id ? ' menu-open' : '')}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ folder: f, x: e.clientX, y: e.clientY });
            }}
          >
            <button
              className={'folder-item' + (view === `folder:${f.id}` ? ' active' : '')}
              onClick={() => navigate(`folder:${f.id}`)}
              title={f.name}
            >
              <Folder size={15} />
              <span className="folder-name">{f.name}</span>
            </button>
            <IconButton
              label={t('More actions for {name}', { name: f.name })}
              className="small folder-more"
              aria-haspopup="menu"
              aria-expanded={menu?.folder.id === f.id}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu(
                  menu?.folder.id === f.id ? null : { folder: f, x: r.left, y: r.bottom + 4 },
                );
              }}
            >
              <MoreHorizontal size={14} />
            </IconButton>
          </div>
        ))}
      </nav>
      {menu && (
        <FolderMenu
          {...menu}
          onClose={() => setMenu(null)}
          onRename={() => renameFolder(menu.folder)}
          onDelete={() => deleteFolder(menu.folder)}
        />
      )}
      <div className="sidebar-bottom">
        <div className="sidebar-tools">
          <IconButton label={t('Import transcript or backup')} onClick={importFile}>
            <Upload size={16} />
          </IconButton>
          <IconButton label={t('Trash')} onClick={() => navigate('trash')}>
            <Trash2 size={16} />
          </IconButton>
          <IconButton label={t('Settings')} onClick={openSettings}>
            <Settings size={16} />
          </IconButton>
        </div>
        <button className="plan-pill" onClick={openSettings} aria-label={t('AI settings')}>
          <span>
            <span className={'status-dot' + (ai.ready ? ' on' : '')} aria-hidden="true" />
            {ai.ready ? `${ai.label}${plan ? ` ${plan}` : ''}` : t('AI not set up')}
          </span>
          <span className="plan-action">{ai.ready ? t('Manage') : t('Connect')}</span>
        </button>
        <div className="workspace-row">
          <img className="brand-icon" src={icon} alt="" />
          <strong>Stillnote</strong>
          <small>{t('On this Mac')}</small>
        </div>
      </div>
    </aside>
  );
}

// Rename and delete for one folder. Fixed to the window so the scrolling folder list cannot clip
// it; Escape, a click elsewhere or a choice closes it.
function FolderMenu({ folder, x, y, onClose, onRename, onDelete }) {
  const t = useT();
  const root = useRef();
  const opener = useRef(document.activeElement);
  useEffect(() => {
    const items = () => [...root.current.querySelectorAll('[role="menuitem"]')];
    items()[0]?.focus();
    const outside = (e) => {
      if (!root.current?.contains(e.target) && !e.target.closest?.('.folder-more')) onClose();
    };
    const key = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        opener.current?.focus?.();
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
  }, [folder.id]);
  const choose = (action) => {
    onClose();
    action();
  };
  return (
    <div
      ref={root}
      className="folder-menu"
      role="menu"
      aria-label={folder.name}
      style={{ left: Math.max(8, x), top: Math.min(y, window.innerHeight - 96) }}
    >
      <button role="menuitem" onClick={() => choose(onRename)}>
        <Pencil size={14} />
        {t('Rename…')}
      </button>
      <button role="menuitem" className="danger" onClick={() => choose(onDelete)}>
        <Trash2 size={14} />
        {t('Delete folder')}
      </button>
    </div>
  );
}
