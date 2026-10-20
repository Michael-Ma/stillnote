import React from 'react';
import Markdown from 'react-markdown';
export function IconButton({ label, children, ...props }) {
  return (
    <button className="icon-button" aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}
export function Rich({ text, onSource }) {
  const content = onSource ? text.replace(/\[(\d+)\](?!\()/g, '[$1](stillnote://source/$1)') : text;
  return (
    <div className="prose">
      <Markdown
        urlTransform={(url) => (url.startsWith('stillnote://source/') ? url : '')}
        components={{
          a: ({ href, children }) =>
            href?.startsWith('stillnote://source/') ? (
              <button
                className="citation"
                onClick={() => onSource?.(Number(href.split('/').pop()))}
                aria-label={`View source ${children}`}
              >
                {children}
              </button>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
