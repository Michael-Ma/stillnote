import React, { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { useT } from '../i18n/react.jsx';

// "The meeting seems to be over", above the dock while recording: why, and in automatic mode the
// seconds until the recording stops. Keep recording answers it; Stop now does not wait.
export function MeetingEndPrompt({ prompt, onKeep, onStop }) {
  const t = useT();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!prompt.deadline) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [prompt.deadline]);
  const seconds = prompt.deadline ? Math.max(0, Math.ceil((prompt.deadline - now) / 1000)) : null;
  return (
    <div className="meeting-prompt" role="status">
      <span className="meeting-prompt-mark" aria-hidden="true">
        <Timer size={16} />
      </span>
      <span className="meeting-prompt-text">
        <strong>
          {seconds === null
            ? t('The meeting seems to be over')
            : t('The meeting seems to be over. Stopping in {n} s', { n: seconds })}
        </strong>
        <small>
          {prompt.reason === 'call'
            ? t('The call has ended and no one is speaking.')
            : prompt.reason === 'calendar'
              ? t('The calendar meeting has ended and no one is speaking.')
              : t('No one has spoken for a while.')}
        </small>
      </span>
      <button className="banner-action" onClick={onKeep}>
        {t('Keep recording')}
      </button>
      <button className="text-button" onClick={onStop}>
        {t('Stop now')}
      </button>
    </div>
  );
}
