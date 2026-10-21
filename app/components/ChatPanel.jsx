import React, { useEffect, useRef } from 'react';
import { ArrowUp, ArrowUpRight, PanelRightClose, Square } from 'lucide-react';
import { IconButton, Rich } from './Content.jsx';
import { AiConnect } from './AiConnect.jsx';
import { providerName } from '../ai-view.mjs';

const suggestions = {
  meeting: ['What did we decide?', 'What should I follow up on?', 'Draft a follow-up email.'],
  folder: ['What themes keep coming up?', 'Summarize open questions.', 'List action items.'],
  all: ['What did I commit to this week?', 'List recent to-dos.', 'What changed since last week?'],
};

export function ChatPanel({
  global,
  messages,
  busy,
  stream,
  question,
  setQuestion,
  onAsk,
  onCancel,
  onClose,
  scope,
  scopes,
  setScope,
  ai,
  aiActions,
  modelOptions,
  modelValue,
  onModel,
  onSource,
  onOpenSource,
  onApply,
}) {
  const bottomRef = useRef();
  const inputRef = useRef();
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, stream]);
  useEffect(() => {
    inputRef.current?.focus();
  }, [scope]);
  const empty = !messages.length && !busy;
  const composer = (
    <form
      className="chat-composer"
      onSubmit={(e) => {
        e.preventDefault();
        onAsk();
      }}
    >
      <textarea
        ref={inputRef}
        aria-label="Ask a question"
        placeholder={
          scope === 'meeting' ? 'Ask about this meeting…' : 'Ask anything about your notes…'
        }
        rows={global && empty ? 3 : 2}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onAsk();
          }
        }}
      />
      <div className="composer-bar">
        <select
          className="chip-select"
          aria-label="Chat scope"
          disabled={!!busy}
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          {scopes.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {modelOptions.length > 0 && (
          <select
            className="chip-select"
            aria-label="AI model"
            disabled={!!busy}
            value={modelValue}
            onChange={(e) => onModel(e.target.value)}
          >
            {modelOptions.map((group) => (
              <optgroup key={group.provider} label={providerName(group.provider)}>
                {group.models.map((m) => (
                  <option key={m.id} value={`${group.provider}:${m.id}`}>
                    {providerName(group.provider)} · {m.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
        <span className="composer-spacer" />
        {busy ? (
          <IconButton label="Stop response" className="send-button" onClick={onCancel}>
            <Square size={12} fill="currentColor" />
          </IconButton>
        ) : (
          <button
            className="send-button"
            type="submit"
            disabled={!question.trim()}
            aria-label="Send question"
          >
            <ArrowUp size={16} />
          </button>
        )}
      </div>
    </form>
  );
  return (
    <aside className={'chat-panel' + (global ? ' global' : '') + (empty ? ' empty' : '')}>
      <header>
        <h2>{global ? 'Chat' : 'Ask about this meeting'}</h2>
        <IconButton label="Close chat" onClick={onClose}>
          <PanelRightClose size={16} />
        </IconButton>
      </header>
      <div className="chat-messages">
        {empty && (
          <div className="chat-intro">
            <h3>{global ? 'Ask anything' : 'What would you like to know?'}</h3>
            {global && composer}
            <div className="suggestions">
              {(suggestions[scope] ?? suggestions.all).map((q) => (
                <button key={q} onClick={() => setQuestion(q)}>
                  {q}
                  <ArrowUpRight size={13} />
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div className={'chat-message ' + m.role} key={m.id}>
            {m.role === 'user' ? (
              <p className="bubble">{m.content}</p>
            ) : (
              <>
                <Rich text={m.content} onSource={(number) => onSource(m, number)} />
                {m.context?.included < m.context?.total && (
                  <p className="context-coverage">
                    Used {m.context.included} of {m.context.total} notes
                  </p>
                )}
                {(m.sources?.length > 0 || onApply) && (
                  <div className="message-tools">
                    {m.sources?.map((s) => (
                      <button key={s.id} className="source-chip" onClick={() => onOpenSource(s)}>
                        <span>{s.number}</span>
                        {s.title}
                      </button>
                    ))}
                    {onApply && (
                      <button className="text-button" onClick={() => onApply(m)}>
                        Use as enhanced notes
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        {busy === 'chat' && (
          <div className="chat-message assistant">
            {stream ? (
              <Rich text={stream} />
            ) : (
              <p className="thinking">
                <span className="dot-pulse" aria-hidden="true" />
                Reading your notes…
              </p>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {!ai.ready && (
        <div className="chat-connect">
          <AiConnect ai={ai} actions={aiActions} title="Connect an AI to chat" />
        </div>
      )}
      {!(global && empty) && composer}
      <p className="chat-disclaimer">
        {ai.ready ? `Answers use your ${ai.label} plan. ` : ''}Check important details against the
        transcript.
      </p>
    </aside>
  );
}
