import React, { useMemo, useRef } from 'react';
import Markdown from 'react-markdown';
import { useT } from '../i18n/react.jsx';
export function IconButton({ label, children, className = '', ...props }) {
  return (
    <button className={'icon-button ' + className} aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}
// Text of a hast node without nested lists, so a parent bullet is judged on its own words.
const ownText = (node) =>
  (node?.children ?? [])
    .filter((child) => !['ul', 'ol'].includes(child.tagName))
    .map((child) => (child.type === 'text' ? child.value : ownText(child)))
    .join('');
export function Rich({ text, onSource, isOwn }) {
  const t = useT();
  const sourceRef = useRef(onSource);
  sourceRef.current = onSource;
  const components = useMemo(() => {
    const mark = (Tag) =>
      function Marked({ node, children, ...props }) {
        return (
          <Tag {...props} className={isOwn(ownText(node)) ? 'own' : undefined}>
            {children}
          </Tag>
        );
      };
    return {
      a: ({ href, children }) =>
        href?.startsWith('stillnote://source/') ? (
          <button
            className="citation"
            onClick={() => sourceRef.current?.(Number(href.split('/').pop()))}
            aria-label={t('View source {n}', { n: children })}
          >
            {children}
          </button>
        ) : (
          <span>{children}</span>
        ),
      ...(isOwn ? { li: mark('li'), p: mark('p') } : {}),
    };
  }, [isOwn, t]);
  const content = onSource ? text.replace(/\[(\d+)\](?!\()/g, '[$1](stillnote://source/$1)') : text;
  // Parsing Markdown is the slow part: it reruns only when the text or its marking changes, not
  // on every render of a chat or note (each keystroke, each streamed word elsewhere).
  const rendered = useMemo(
    () => (
      <Markdown
        urlTransform={(url) => (url.startsWith('stillnote://source/') ? url : '')}
        components={components}
      >
        {content}
      </Markdown>
    ),
    [content, components],
  );
  return <div className={'prose' + (isOwn ? ' enhanced' : '')}>{rendered}</div>;
}
