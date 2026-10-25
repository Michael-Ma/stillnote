import React from 'react';
import {
  Folder,
  Home,
  Lock,
  MessageCircle,
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
  importFile,
  openSettings,
  ai,
  icon,
}) {
  const t = useT();
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
          <button
            key={f.id}
            className={'folder-item' + (view === `folder:${f.id}` ? ' active' : '')}
            onClick={() => navigate(`folder:${f.id}`)}
            title={f.name}
          >
            <Folder size={15} />
            <span className="folder-name">{f.name}</span>
          </button>
        ))}
      </nav>
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
