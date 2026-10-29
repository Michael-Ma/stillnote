import React, { useEffect, useRef, useState } from 'react';
import { cleanError, languageName, languageOptions } from '../format.mjs';
import { defaultAutoLocales, defaultLocale } from '../language-arbiter.mjs';
import { useT } from '../i18n/react.jsx';

// `message` is the translated sentence for a main process without this operation; any other
// error comes back in English from the main process and is translated when it is known.
const unavailable = (error, message, t) =>
  /Unknown operation/.test(cleanError(error)) ? message : t(cleanError(error));

export function RecordingSettings({ settings, setting, guard, call, subscribe }) {
  const t = useT();
  const [inputs, setInputs] = useState(null);
  const [languages, setLanguages] = useState(null);
  const [deviceError, setDeviceError] = useState('');
  const [languageError, setLanguageError] = useState('');
  const [download, setDownload] = useState(null);
  const alive = useRef(false);
  const installing = useRef(null);
  const locale = settings.locale ?? defaultLocale;
  const auto = locale === 'auto';
  const autoLocales = settings.autoLocales ?? defaultAutoLocales;
  const options = languageOptions(languages, t.locale);
  const installed = (code) => options.some((o) => o.locale === code && o.installed);
  // The languages this choice needs that are supported here but not downloaded yet.
  const missing = (auto ? autoLocales : [locale]).filter(
    (code) => options.some((o) => o.locale === code) && !installed(code),
  );
  useEffect(() => {
    alive.current = true;
    Promise.resolve()
      .then(() => call('audio-devices'))
      .then((r) => {
        if (alive.current) setInputs(r.inputs);
      })
      .catch((e) => {
        if (alive.current)
          setDeviceError(
            unavailable(e, t('Microphone controls are unavailable in this version.'), t),
          );
      });
    Promise.resolve()
      .then(() => call('languages'))
      .then((r) => {
        if (alive.current) setLanguages(r);
      })
      .catch((e) => {
        if (alive.current)
          setLanguageError(
            unavailable(e, t('Language controls are unavailable in this version.'), t),
          );
      });
    const unsubscribe = subscribe((event) => {
      if (event.type === 'language-progress' && installing.current === event.locale)
        setDownload({ locale: event.locale, fraction: Math.max(0, Math.min(1, event.fraction)) });
    });
    return () => {
      alive.current = false;
      unsubscribe();
    };
  }, []);
  async function install(target) {
    if (installing.current) return;
    installing.current = target;
    setLanguageError('');
    setDownload({ locale: target, fraction: 0 });
    try {
      const result = await call('install-language', target);
      if (alive.current) setLanguages(result);
    } catch (e) {
      if (alive.current)
        setLanguageError(
          unavailable(e, t('Language downloads are unavailable in this version.'), t),
        );
    } finally {
      installing.current = null;
      if (alive.current) setDownload(null);
    }
  }
  const defaultInput = inputs?.find((d) => d.isDefault);
  return (
    <>
      {inputs ? (
        <>
          <div className="setting-row">
            <div>
              <label htmlFor="inputDevice">{t('Microphone')}</label>
              <small>{t('Applies to your next recording.')}</small>
            </div>
            <select
              id="inputDevice"
              value={settings.inputDevice ?? ''}
              onChange={(e) => guard(() => setting('inputDevice', e.target.value || null))}
            >
              <option value="">
                {defaultInput
                  ? t('System default ({device})', { device: defaultInput.name })
                  : t('System default')}
              </option>
              {settings.inputDevice && !inputs.some((d) => d.uid === settings.inputDevice) && (
                <option value={settings.inputDevice}>
                  {t('Selected microphone (unavailable)')}
                </option>
              )}
              {inputs.map((device) => (
                <option key={device.uid} value={device.uid}>
                  {device.isDefault
                    ? t('{device} · Default', { device: device.name })
                    : device.name}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <div>
              <label htmlFor="echoCancellation">{t('Echo cancellation')}</label>
              <small>
                {t(
                  'Experimental. Use headphones for the cleanest transcript; Stillnote falls back to normal capture if your Mac can’t start it.',
                )}
              </small>
            </div>
            <select
              id="echoCancellation"
              value={settings.echoCancellation === 'on' ? 'on' : 'off'}
              onChange={(e) => guard(() => setting('echoCancellation', e.target.value))}
            >
              <option value="off">{t('Off')}</option>
              <option value="on">{t('On (experimental)')}</option>
            </select>
          </div>
        </>
      ) : (
        <p className="settings-foot" role="status">
          {deviceError || t('Loading microphones…')}
        </p>
      )}
      {languages && (
        <>
          <div className="setting-row">
            <div>
              <label htmlFor="locale">{t('Meeting language')}</label>
              <small>
                {auto
                  ? t(
                      'Each sentence is transcribed in whichever language fits. Uses more processing while recording.',
                    )
                  : t('Transcribed on this Mac.')}
              </small>
            </div>
            <select
              id="locale"
              value={locale}
              disabled={!!download}
              onChange={(e) => guard(() => setting('locale', e.target.value))}
            >
              {languages.engine !== 'legacy' && <option value="auto">{t('Auto')}</option>}
              {!auto && !options.some((o) => o.locale === locale) && (
                <option value={locale}>
                  {t('{language} · Unavailable', { language: locale })}
                </option>
              )}
              {options.map((option) => (
                <option key={option.locale} value={option.locale}>
                  {option.installed
                    ? t('{language} · Installed', { language: option.name })
                    : option.name}
                </option>
              ))}
            </select>
          </div>
          {auto && (
            <div className="setting-row">
              <div>
                <span id="auto-languages">{t('Listen for')}</span>
                <small>{t('Pick the two languages your meetings use.')}</small>
              </div>
              <div className="auto-languages" role="group" aria-labelledby="auto-languages">
                {autoLocales.map((code, index) => (
                  <select
                    key={index}
                    aria-label={index ? t('Second language') : t('First language')}
                    value={code}
                    disabled={!!download}
                    onChange={(e) => {
                      const next = [...autoLocales];
                      // Picking the other slot's language swaps the two.
                      if (next[1 - index] === e.target.value) next[1 - index] = next[index];
                      next[index] = e.target.value;
                      guard(() => setting('autoLocales', next));
                    }}
                  >
                    {options.map((option) => (
                      <option key={option.locale} value={option.locale}>
                        {option.installed
                          ? t('{language} · Installed', { language: option.name })
                          : option.name}
                      </option>
                    ))}
                  </select>
                ))}
              </div>
            </div>
          )}
          {languages.engine === 'legacy' ? (
            <p className="settings-foot">
              {t(
                'Languages that work on this Mac: {languages}. Apple Speech (legacy) uses macOS Dictation settings for language setup. Auto language needs macOS 26.',
                {
                  languages: options.map((o) => o.name).join(', ') || t('None available'),
                },
              )}
            </p>
          ) : (
            missing.map((code) => (
              <div className="language-download" key={code}>
                <button
                  className="secondary small"
                  disabled={!!download}
                  onClick={() => install(code)}
                >
                  {download?.locale === code
                    ? t('Downloading…')
                    : t('Download {language}', { language: languageName(code, t.locale) })}
                </button>
                {download?.locale === code && (
                  <>
                    <progress
                      aria-label={t('Language download progress')}
                      max={1}
                      value={download.fraction}
                    />
                    <span>{Math.round(download.fraction * 100)}%</span>
                  </>
                )}
              </div>
            ))
          )}
        </>
      )}
      {(!languages || languageError) && (
        <p className="settings-foot" role="status">
          {languageError || t('Loading meeting languages…')}
        </p>
      )}
    </>
  );
}
