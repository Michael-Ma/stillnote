import React, { useEffect, useRef, useState } from 'react';
import { cleanError, languageOptions } from '../format.mjs';

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
  const options = languageOptions(languages);
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
  async function install() {
    if (installing.current) return;
    installing.current = locale;
    setLanguageError('');
    setDownload({ locale, fraction: 0 });
    try {
      const result = await call('install-language', locale);
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
              <small>Transcribed on this Mac.</small>
            </div>
            <select
              id="locale"
              value={locale}
              disabled={!!download}
              onChange={(e) => guard(() => setting('locale', e.target.value))}
            >
              {!options.some((o) => o.locale === locale) && (
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
          {languages.engine === 'legacy' ? (
            <p className="settings-foot">
              Languages that work on this Mac:{' '}
              {options.map((o) => o.name).join(', ') || 'None available'}. Apple Speech (legacy)
              uses macOS Dictation settings for language setup.
            </p>
          ) : (
            options.some((o) => o.locale === locale && !o.installed) && (
              <div className="language-download">
                <button className="secondary small" disabled={!!download} onClick={install}>
                  {download ? 'Downloading…' : 'Download'}
                </button>
                {download?.locale === locale && (
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
            )
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
