import React, { useState } from 'react';
import {
  ArrowUpRight,
  Check,
  Download,
  Folder,
  LoaderCircle,
  Mic,
  NotebookPen,
  Plus,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { RecordingSettings } from './RecordingSettings.jsx';
import { claudeSummary, modelKey, usageSummary } from '../ai-view.mjs';

const sections = [
  ['ai', 'AI', Sparkles],
  ['capture', 'Recording', Mic],
  ['notebook', 'Notebook', NotebookPen],
];

function Toggle({ id, checked, onChange }) {
  return (
    <input
      id={id}
      type="checkbox"
      role="switch"
      className="switch"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function ProviderCard({ id, name, active, ready, onUse, children, status }) {
  return (
    <div className={'provider-card' + (active ? ' active' : '')}>
      <div className="provider-head">
        <span className={'provider-mark ' + id} aria-hidden="true">
          {name[0]}
        </span>
        <div>
          <strong>{name}</strong>
          <p>{status}</p>
        </div>
        {active ? (
          <span className="provider-badge">
            <Check size={12} />
            In use
          </span>
        ) : (
          ready && (
            <button className="secondary small" onClick={onUse}>
              Use {name}
            </button>
          )
        )}
      </div>
      {children}
    </div>
  );
}

export function SettingsDialog({
  data,
  initialSection = 'ai',
  call,
  subscribe,
  ai,
  accountBusy,
  account,
  aiActions,
  models,
  setting,
  guard,
  onBackup,
  onReveal,
  onTemplate,
  onUsage,
}) {
  const [section, setSection] = useState(initialSection);
  const { chatgpt, claude } = ai;
  const activeModels = ai.provider === 'claude' ? models.claude : models.chatgpt;
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        {sections.map(([key, label, Icon]) => (
          <button
            key={key}
            className={section === key ? 'active' : ''}
            aria-current={section === key ? 'page' : undefined}
            onClick={() => setSection(key)}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        {section === 'ai' && (
          <section>
            <h3>AI provider</h3>
            <p className="settings-lead">
              Stillnote enhances notes and answers questions with a plan you already have. Audio
              never leaves this Mac; only the notes and transcripts you use are sent.
            </p>
            <ProviderCard
              id="claude"
              name="Claude"
              active={ai.provider === 'claude'}
              ready={claude.ready}
              onUse={() => aiActions.use('claude')}
              status={claudeSummary(claude)}
            >
              <div className="provider-actions">
                {claude.ready ? (
                  claude.usage && <small>{usageSummary(claude.usage)}</small>
                ) : claude.installed ? (
                  <button
                    className="primary small"
                    disabled={claude.signingIn}
                    onClick={aiActions.claudeSignIn}
                  >
                    {claude.signingIn && <LoaderCircle size={13} className="spin" />}
                    Sign in to Claude
                  </button>
                ) : (
                  <>
                    <button className="primary small" onClick={() => aiActions.terminal('install')}>
                      Install Claude Code
                    </button>
                    <button className="text-button" onClick={aiActions.installHelp}>
                      Learn more <ArrowUpRight size={12} />
                    </button>
                  </>
                )}
                {claude.signingIn && (
                  <>
                    <button className="text-button" onClick={aiActions.claudeCancel}>
                      Cancel
                    </button>
                    <button className="text-button" onClick={() => aiActions.terminal('sign-in')}>
                      Sign in using Terminal
                    </button>
                  </>
                )}
                <button className="text-button" onClick={aiActions.refresh}>
                  <RefreshCw size={12} className={claude.checking ? 'spin' : ''} />
                  Check again
                </button>
              </div>
              <small className="provider-note">
                Uses the Claude Code app on this Mac with your own sign-in. Stillnote never reads
                your Claude credentials. Requests count toward your Claude plan limits.
              </small>
            </ProviderCard>
            <ProviderCard
              id="chatgpt"
              name="ChatGPT"
              active={ai.provider === 'chatgpt'}
              ready={chatgpt.ready}
              onUse={() => aiActions.use('chatgpt')}
              status={
                chatgpt.ready
                  ? `Connected${chatgpt.email ? ` · ${chatgpt.email}` : ''}`
                  : chatgpt.connected
                    ? 'Connected, but plan usage is not enabled. Reconnect to allow it.'
                    : 'Sign in with your ChatGPT account in the browser.'
              }
            >
              <div className="provider-actions">
                {accountBusy ? (
                  <button className="secondary small" onClick={() => account('cancel')}>
                    Cancel sign-in
                  </button>
                ) : (
                  <button
                    className={
                      (chatgpt.connected || ai.provider === 'claude' ? 'secondary' : 'primary') +
                      ' small'
                    }
                    onClick={() => account('connect')}
                  >
                    {chatgpt.connected ? 'Reconnect' : 'Continue with ChatGPT'}
                    <ArrowUpRight size={13} />
                  </button>
                )}
                {chatgpt.connected && (
                  <>
                    <button
                      className="text-button"
                      disabled={accountBusy}
                      onClick={() => account('add')}
                    >
                      Add account
                    </button>
                    <button
                      className="text-button"
                      disabled={accountBusy}
                      onClick={() => account('disconnect')}
                    >
                      Sign out
                    </button>
                  </>
                )}
              </div>
              {chatgpt.profiles?.length > 1 && (
                <div className="setting-row">
                  <label htmlFor="profile">Account</label>
                  <select
                    id="profile"
                    disabled={accountBusy}
                    value={chatgpt.active ?? ''}
                    onChange={(e) => account('select', e.target.value)}
                  >
                    {chatgpt.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label} · {p.email ?? 'Pending registration'}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </ProviderCard>
            {ai.ready && (
              <div className="setting-row">
                <div>
                  <label htmlFor="model">Model</label>
                  <small>
                    <button className="text-button" onClick={onUsage}>
                      View {ai.label} usage <ArrowUpRight size={12} />
                    </button>
                  </small>
                </div>
                <select
                  id="model"
                  value={
                    activeModels?.some((m) => m.id === data.settings[modelKey(ai.provider)])
                      ? data.settings[modelKey(ai.provider)]
                      : (activeModels?.[0]?.id ?? '')
                  }
                  onChange={(e) => guard(() => setting(modelKey(ai.provider), e.target.value))}
                >
                  {activeModels?.length ? (
                    activeModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))
                  ) : (
                    <option value="">Loading models…</option>
                  )}
                </select>
              </div>
            )}
            <div className="setting-row">
              <div>
                <label htmlFor="autoEnhance">Enhance when the meeting ends</label>
                <small>Write enhanced notes automatically after recording.</small>
              </div>
              <Toggle
                id="autoEnhance"
                checked={data.settings.autoEnhance ?? true}
                onChange={(v) => guard(() => setting('autoEnhance', v))}
              />
            </div>
          </section>
        )}
        {section === 'capture' && (
          <section>
            <h3>Recording</h3>
            <RecordingSettings
              settings={data.settings}
              setting={setting}
              guard={guard}
              call={call}
              subscribe={subscribe}
            />
            <div className="setting-row">
              <div>
                <label htmlFor="systemAudio">Capture meeting audio</label>
                <small>Transcribe other apps, like Zoom or Meet, alongside your microphone.</small>
              </div>
              <Toggle
                id="systemAudio"
                checked={data.settings.systemAudio ?? true}
                onChange={(v) => guard(() => setting('systemAudio', v))}
              />
            </div>
            <p className="settings-foot">
              Your microphone is labeled “You” and other apps “Meeting audio”. Individual remote
              speakers are not identified. Let participants know when you record.
            </p>
          </section>
        )}
        {section === 'notebook' && (
          <section>
            <h3>Notebook</h3>
            <div className="settings-buttons">
              <button className="secondary" onClick={onBackup}>
                <Download size={15} />
                Back up notebook
              </button>
              <button className="secondary" onClick={onReveal}>
                <Folder size={15} />
                Open data folder
              </button>
              <button className="secondary" onClick={onTemplate}>
                <Plus size={15} />
                Custom template
              </button>
            </div>
            <p className="settings-foot">
              Notes live in a local SQLite database. Backups include meetings, transcripts and chat
              history, but not raw audio or account credentials. Importing a backup adds new
              meetings without replacing existing ones.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
