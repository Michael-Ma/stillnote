import React from 'react';
import { ArrowUpRight, LoaderCircle, Sparkles } from 'lucide-react';
import { claudeSummary } from '../ai-view.mjs';
import { useT } from '../i18n/react.jsx';

// The shortest path to a working AI provider, shown wherever AI is needed but not ready.
// A `title` passed in is shown as given, so callers translate their own.
export function AiConnect({ ai, actions, busy, title }) {
  const t = useT();
  const { claude, chatgpt } = ai;
  return (
    <div className="ai-connect" role="group" aria-label={t('Connect AI')}>
      <div className="ai-connect-head">
        <Sparkles size={15} aria-hidden="true" />
        <strong>{title ?? t('Connect an AI to continue')}</strong>
      </div>
      <p>{t('Use the plan you already pay for. No API key needed.')}</p>
      <div className="ai-connect-options">
        {claude.ready ? (
          <button className="primary" disabled={busy} onClick={() => actions.use('claude')}>
            {t('Use Claude')}
          </button>
        ) : claude.installed ? (
          <button
            className="primary"
            disabled={busy || claude.signingIn}
            onClick={actions.claudeSignIn}
          >
            {claude.signingIn && <LoaderCircle size={14} className="spin" />}
            {t('Sign in to Claude')}
          </button>
        ) : null}
        {chatgpt.ready ? (
          <button className="secondary" disabled={busy} onClick={() => actions.use('chatgpt')}>
            {t('Use ChatGPT')}
          </button>
        ) : (
          <button className="secondary" disabled={busy} onClick={actions.chatgptSignIn}>
            {t('Sign in with ChatGPT')}
          </button>
        )}
        {!claude.installed && !claude.checking && (
          <button className="text-button" onClick={() => actions.terminal('install')}>
            {t('Install Claude Code')} <ArrowUpRight size={13} />
          </button>
        )}
        {claude.signingIn && (
          <button className="text-button" onClick={() => actions.terminal('sign-in')}>
            {t('Sign in using Terminal')}
          </button>
        )}
      </div>
      {claude.installed && !claude.ready && <small>{claudeSummary(claude, t)}</small>}
    </div>
  );
}
