import React from 'react';
import { ArrowUpRight, LoaderCircle, Sparkles } from 'lucide-react';
import { claudeSummary } from '../ai-view.mjs';

// The shortest path to a working AI provider, shown wherever AI is needed but not ready.
export function AiConnect({ ai, actions, busy, title = 'Connect an AI to continue' }) {
  const { claude, chatgpt } = ai;
  return (
    <div className="ai-connect" role="group" aria-label="Connect AI">
      <div className="ai-connect-head">
        <Sparkles size={15} aria-hidden="true" />
        <strong>{title}</strong>
      </div>
      <p>Use the plan you already pay for. No API key needed.</p>
      <div className="ai-connect-options">
        {claude.ready ? (
          <button className="primary" disabled={busy} onClick={() => actions.use('claude')}>
            Use Claude
          </button>
        ) : claude.installed ? (
          <button
            className="primary"
            disabled={busy || claude.signingIn}
            onClick={actions.claudeSignIn}
          >
            {claude.signingIn && <LoaderCircle size={14} className="spin" />}
            Sign in to Claude
          </button>
        ) : null}
        {chatgpt.ready ? (
          <button className="secondary" disabled={busy} onClick={() => actions.use('chatgpt')}>
            Use ChatGPT
          </button>
        ) : (
          <button className="secondary" disabled={busy} onClick={actions.chatgptSignIn}>
            Sign in with ChatGPT
          </button>
        )}
        {!claude.installed && !claude.checking && (
          <button className="text-button" onClick={() => actions.terminal('install')}>
            Install Claude Code <ArrowUpRight size={13} />
          </button>
        )}
        {claude.signingIn && (
          <button className="text-button" onClick={() => actions.terminal('sign-in')}>
            Sign in using Terminal
          </button>
        )}
      </div>
      {claude.installed && !claude.ready && <small>{claudeSummary(claude)}</small>}
    </div>
  );
}
