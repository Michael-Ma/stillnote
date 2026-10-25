import React, { createContext, useContext } from 'react';
import { translator } from './index.mjs';

const I18n = createContext(translator('en'));

export function I18nProvider({ t, children }) {
  return <I18n.Provider value={t}>{children}</I18n.Provider>;
}

// The current interface language's t(); components re-render when the language changes.
export const useT = () => useContext(I18n);
