import React, { useState } from 'react';
import {
  ArrowUpRight,
  CalendarDays,
  Check,
  Download,
  Folder,
  Languages,
  LoaderCircle,
  Mic,
  NotebookPen,
  Plus,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { RecordingSettings } from './RecordingSettings.jsx';
import { CalendarSettings } from './CalendarSettings.jsx';
import { Toggle } from './Content.jsx';
import { claudeSummary, modelKey, usageSummary } from '../ai-view.mjs';
import { useT } from '../i18n/react.jsx';

// Labels are translation keys, translated where they are shown.
// Labels are translated where shown; msg() lists them for the i18n coverage test.
const msg = (text) => text;
const sections = [
  ['general', msg('General'), Languages],
  ['ai', msg('AI'), Sparkles],
  ['capture', msg('Recording'), Mic],
  ['calendars', msg('Calendars'), CalendarDays],
  ['notebook', msg('Notebook'), NotebookPen],
];

function ProviderCard({ id, name, active, ready, onUse, children, status }) {
  const t = useT();
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
            {t('In use')}
          </span>
        ) : (
          ready && (
            <button className="secondary small" onClick={onUse}>
              {t('Use {provider}', { provider: name })}
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
  calendar,
  calendarBusy,
  onUsage,
}) {
  const t = useT();
  const [section, setSection] = useState(initialSection);
  const { chatgpt, claude } = ai;
  const activeModels = ai.provider === 'claude' ? models.claude : models.chatgpt;
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={t('Settings sections')}>
        {sections.map(([key, label, Icon]) => (
          <button
            key={key}
            className={section === key ? 'active' : ''}
            aria-current={section === key ? 'page' : undefined}
            onClick={() => setSection(key)}
          >
            <Icon size={15} />
            {t(label)}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        {section === 'general' && (
          <section>
            <h3>{t('General')}</h3>
            <div className="setting-row">
              <div>
                <label htmlFor="ui-language">{t('App language')}</label>
                <small>
                  {t('Menus, buttons and messages. Notes keep the language you write in.')}
                </small>
              </div>
              <select
                id="ui-language"
                value={data.settings.uiLanguage ?? 'system'}
                onChange={(e) => guard(() => setting('uiLanguage', e.target.value))}
              >
                <option value="system">{t('Follow macOS')}</option>
                {/* Each language is named in itself, so it can be found whatever is shown. */}
                <option value="en">English</option>
                <option value="zh-Hans">简体中文</option>
              </select>
            </div>
          </section>
        )}
        {section === 'ai' && (
          <section>
            <h3>{t('AI provider')}</h3>
            <p className="settings-lead">
              {t(
                'Stillnote enhances notes and answers questions with a plan you already have. Audio never leaves this Mac; only the notes and transcripts you use are sent.',
              )}
            </p>
            <ProviderCard
              id="claude"
              name="Claude"
              active={ai.provider === 'claude'}
              ready={claude.ready}
              onUse={() => aiActions.use('claude')}
              status={claudeSummary(claude, t)}
            >
              <div className="provider-actions">
                {claude.ready ? (
                  claude.usage && <small>{usageSummary(claude.usage, Date.now(), t)}</small>
                ) : claude.installed ? (
                  <button
                    className="primary small"
                    disabled={claude.signingIn}
                    onClick={aiActions.claudeSignIn}
                  >
                    {claude.signingIn && <LoaderCircle size={13} className="spin" />}
                    {t('Sign in to Claude')}
                  </button>
                ) : (
                  <>
                    <button className="primary small" onClick={() => aiActions.terminal('install')}>
                      {t('Install Claude Code')}
                    </button>
                    <button className="text-button" onClick={aiActions.installHelp}>
                      {t('Learn more')} <ArrowUpRight size={12} />
                    </button>
                  </>
                )}
                {claude.signingIn && (
                  <>
                    <button className="text-button" onClick={aiActions.claudeCancel}>
                      {t('Cancel')}
                    </button>
                    <button className="text-button" onClick={() => aiActions.terminal('sign-in')}>
                      {t('Sign in using Terminal')}
                    </button>
                  </>
                )}
                <button className="text-button" onClick={aiActions.refresh}>
                  <RefreshCw size={12} className={claude.checking ? 'spin' : ''} />
                  {t('Check again')}
                </button>
              </div>
              <small className="provider-note">
                {t(
                  'Uses the Claude Code app on this Mac with your own sign-in. Stillnote never reads your Claude credentials. Requests count toward your Claude plan limits.',
                )}
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
                  ? chatgpt.email
                    ? t('Connected · {email}', { email: chatgpt.email })
                    : t('Connected')
                  : chatgpt.connected
                    ? t('Connected, but plan usage is not enabled. Reconnect to allow it.')
                    : t('Sign in with your ChatGPT account in the browser.')
              }
            >
              <div className="provider-actions">
                {accountBusy ? (
                  <button className="secondary small" onClick={() => account('cancel')}>
                    {t('Cancel sign-in')}
                  </button>
                ) : (
                  <button
                    className={
                      (chatgpt.connected || ai.provider === 'claude' ? 'secondary' : 'primary') +
                      ' small'
                    }
                    onClick={() => account('connect')}
                  >
                    {chatgpt.connected ? t('Reconnect') : t('Continue with ChatGPT')}
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
                      {t('Add account')}
                    </button>
                    <button
                      className="text-button"
                      disabled={accountBusy}
                      onClick={() => account('disconnect')}
                    >
                      {t('Sign out')}
                    </button>
                  </>
                )}
              </div>
              {chatgpt.profiles?.length > 1 && (
                <div className="setting-row">
                  <label htmlFor="profile">{t('Account')}</label>
                  <select
                    id="profile"
                    disabled={accountBusy}
                    value={chatgpt.active ?? ''}
                    onChange={(e) => account('select', e.target.value)}
                  >
                    {chatgpt.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label} · {p.email ?? t('Pending registration')}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </ProviderCard>
            {ai.ready && (
              <div className="setting-row">
                <div>
                  <label htmlFor="model">{t('Model')}</label>
                  <small>
                    <button className="text-button" onClick={onUsage}>
                      {t('View {provider} usage', { provider: ai.label })}{' '}
                      <ArrowUpRight size={12} />
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
                    <option value="">{t('Loading models…')}</option>
                  )}
                </select>
              </div>
            )}
            <div className="setting-row">
              <div>
                <label htmlFor="autoEnhance">{t('Enhance when the meeting ends')}</label>
                <small>{t('Write enhanced notes automatically after recording.')}</small>
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
            <h3>{t('Recording')}</h3>
            <RecordingSettings
              settings={data.settings}
              setting={setting}
              guard={guard}
              call={call}
              subscribe={subscribe}
            />
            <div className="setting-row">
              <div>
                <label htmlFor="systemAudio">{t('Capture meeting audio')}</label>
                <small>
                  {t('Transcribe other apps, like Zoom or Meet, alongside your microphone.')}
                </small>
              </div>
              <Toggle
                id="systemAudio"
                checked={data.settings.systemAudio ?? true}
                onChange={(v) => guard(() => setting('systemAudio', v))}
              />
            </div>
            <div className="setting-row">
              <div>
                <label htmlFor="meetingReminders">{t('Meeting reminders')}</label>
                <small>
                  {data.settings.calendarConnected || data.calendarFeeds.length > 0
                    ? t('Notify me a minute before calendar meetings while Stillnote is open.')
                    : t(
                        'Connect a calendar under Calendars to get a reminder before each meeting.',
                      )}
                </small>
              </div>
              <Toggle
                id="meetingReminders"
                checked={data.settings.meetingReminders ?? true}
                onChange={(v) => guard(() => setting('meetingReminders', v))}
              />
            </div>
            <div className="setting-row">
              <div>
                <label htmlFor="reminderAutoRecord">{t('Start recording from a reminder')}</label>
                <small>
                  {t('Clicking a reminder opens the meeting’s note and starts recording.')}
                </small>
              </div>
              <Toggle
                id="reminderAutoRecord"
                checked={data.settings.reminderAutoRecord ?? true}
                onChange={(v) => guard(() => setting('reminderAutoRecord', v))}
              />
            </div>
            <div className="setting-row">
              <div>
                <label htmlFor="meetingDetection">{t('Detect meetings')}</label>
                <small>
                  {t(
                    'Ask to take notes when another app starts using the microphone, like a Zoom or Meet call.',
                  )}
                </small>
              </div>
              <Toggle
                id="meetingDetection"
                checked={data.settings.meetingDetection ?? true}
                onChange={(v) => guard(() => setting('meetingDetection', v))}
              />
            </div>
            <div className="setting-row">
              <div>
                <label htmlFor="openOnMeetingDetected">
                  {t('Open Stillnote when a meeting is detected')}
                </label>
                <small>
                  {t('Bring Stillnote to the front with its prompt, not only a notification.')}
                </small>
              </div>
              <Toggle
                id="openOnMeetingDetected"
                checked={data.settings.openOnMeetingDetected === true}
                disabled={data.settings.meetingDetection === false}
                onChange={(v) => guard(() => setting('openOnMeetingDetected', v))}
              />
            </div>
            <div className="setting-row">
              <div>
                <label htmlFor="meetingEnd">{t('When a meeting seems over')}</label>
                <small>
                  {t(
                    'The call app stops using the microphone, the calendar meeting has ended, or no one has spoken for a long time. Long silence at the end of a recording is removed.',
                  )}
                </small>
              </div>
              <select
                id="meetingEnd"
                className="fit"
                value={data.settings.meetingEnd ?? 'auto'}
                onChange={(e) => guard(() => setting('meetingEnd', e.target.value))}
              >
                <option value="auto">{t('Stop after a countdown')}</option>
                <option value="prompt">{t('Only ask')}</option>
                <option value="off">{t('Off')}</option>
              </select>
            </div>
            <p className="settings-foot">
              {t(
                'Your microphone is labeled “You” and other apps “Meeting audio”. Individual remote speakers are not identified. Let participants know when you record.',
              )}
            </p>
          </section>
        )}
        {section === 'calendars' && (
          <CalendarSettings
            data={data}
            call={call}
            setting={setting}
            guard={guard}
            calendar={calendar}
            calendarBusy={calendarBusy}
          />
        )}
        {section === 'notebook' && (
          <section>
            <h3>{t('Notebook')}</h3>
            <div className="settings-buttons">
              <button className="secondary" onClick={onBackup}>
                <Download size={15} />
                {t('Back up notebook')}
              </button>
              <button className="secondary" onClick={onReveal}>
                <Folder size={15} />
                {t('Open data folder')}
              </button>
              <button className="secondary" onClick={onTemplate}>
                <Plus size={15} />
                {t('Custom template')}
              </button>
            </div>
            <p className="settings-foot">
              {t(
                'Notes live in a local SQLite database. Backups include meetings, transcripts and chat history, but not raw audio or account credentials. Importing a backup adds new meetings without replacing existing ones.',
              )}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
