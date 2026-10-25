import React, { useEffect, useRef, useState } from 'react';
import { cleanError, languageName, languageOptions } from '../format.mjs';

const unavailable = (error, label) =>
  /Unknown operation/.test(cleanError(error))
    ? `${label} are unavailable in this version.`
    : cleanError(error);

export function RecordingSettings({ settings, setting, guard, call, subscribe }) {
  const [inputs, setInputs] = useState(null);
  const [languages, setLanguages] = useState(null);
  const [deviceError, setDeviceError] = useState('');
  const [languageError, setLanguageError] = useState('');
  const [download, setDownload] = useState(null);
  const alive = useRef(false);
  const installing = useRef(null);
  const locale = settings.locale ?? 'en-US';
  const auto = locale === 'auto';
  const autoLocales = settings.autoLocales ?? ['zh-CN', 'en-US'];
  const options = languageOptions(languages);
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
        if (alive.current) setDeviceError(unavailable(e, 'Microphone controls'));
      });
    Promise.resolve()
      .then(() => call('languages'))
      .then((r) => {
        if (alive.current) setLanguages(r);
      })
      .catch((e) => {
        if (alive.current) setLanguageError(unavailable(e, 'Language controls'));
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
      if (alive.current) setLanguageError(unavailable(e, 'Language downloads'));
    } finally {
      installing.current = null;
      if (alive.current) setDownload(null);
    }
  }
  return (
    <>
      {inputs ? (
        <>
          <div className="setting-row">
            <div>
              <label htmlFor="inputDevice">Microphone</label>
              <small>Applies to your next recording.</small>
            </div>
            <select
              id="inputDevice"
              value={settings.inputDevice ?? ''}
              onChange={(e) => guard(() => setting('inputDevice', e.target.value || null))}
            >
              <option value="">
                System default
                {inputs.find((d) => d.isDefault)
                  ? ` (${inputs.find((d) => d.isDefault).name})`
                  : ''}
              </option>
              {settings.inputDevice && !inputs.some((d) => d.uid === settings.inputDevice) && (
                <option value={settings.inputDevice}>Selected microphone (unavailable)</option>
              )}
              {inputs.map((device) => (
                <option key={device.uid} value={device.uid}>
                  {device.name}
                  {device.isDefault ? ' · Default' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <div>
              <label htmlFor="echoCancellation">Echo cancellation</label>
              <small>
                Experimental. Use headphones for the cleanest transcript; Stillnote falls back to
                normal capture if your Mac can’t start it.
              </small>
            </div>
            <select
              id="echoCancellation"
              value={settings.echoCancellation === 'on' ? 'on' : 'off'}
              onChange={(e) => guard(() => setting('echoCancellation', e.target.value))}
            >
              <option value="off">Off</option>
              <option value="on">On (experimental)</option>
            </select>
          </div>
        </>
      ) : (
        <p className="settings-foot" role="status">
          {deviceError || 'Loading microphones…'}
        </p>
      )}
      {languages && (
        <>
          <div className="setting-row">
            <div>
              <label htmlFor="locale">Meeting language</label>
              <small>
                {auto
                  ? 'Each sentence is transcribed in whichever language fits. Uses more processing while recording.'
                  : 'Transcribed on this Mac.'}
              </small>
            </div>
            <select
              id="locale"
              value={locale}
              disabled={!!download}
              onChange={(e) => guard(() => setting('locale', e.target.value))}
            >
              {languages.engine !== 'legacy' && <option value="auto">Auto</option>}
              {!auto && !options.some((o) => o.locale === locale) && (
                <option value={locale}>{locale} · Unavailable</option>
              )}
              {options.map((option) => (
                <option key={option.locale} value={option.locale}>
                  {option.name}
                  {option.installed ? ' · Installed' : ''}
                </option>
              ))}
            </select>
          </div>
          {auto && (
            <div className="setting-row">
              <div>
                <span id="auto-languages">Listen for</span>
                <small>Pick the two languages your meetings use.</small>
              </div>
              <div className="auto-languages" role="group" aria-labelledby="auto-languages">
                {autoLocales.map((code, index) => (
                  <select
                    key={index}
                    aria-label={index ? 'Second language' : 'First language'}
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
                        {option.name}
                        {option.installed ? ' · Installed' : ''}
                      </option>
                    ))}
                  </select>
                ))}
              </div>
            </div>
          )}
          {languages.engine === 'legacy' ? (
            <p className="settings-foot">
              Languages that work on this Mac:{' '}
              {options.map((o) => o.name).join(', ') || 'None available'}. Apple Speech (legacy)
              uses macOS Dictation settings for language setup. Auto language needs macOS 26.
            </p>
          ) : (
            missing.map((code) => (
              <div className="language-download" key={code}>
                <button
                  className="secondary small"
                  disabled={!!download}
                  onClick={() => install(code)}
                >
                  {download?.locale === code ? 'Downloading…' : `Download ${languageName(code)}`}
                </button>
                {download?.locale === code && (
                  <>
                    <progress
                      aria-label="Language download progress"
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
          {languageError || 'Loading meeting languages…'}
        </p>
      )}
    </>
  );
}
