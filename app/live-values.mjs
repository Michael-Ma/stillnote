// Capture state that changes several times a second (audio levels, live transcript lines) is kept
// outside React state: an update redraws only what subscribes to it (a meter, the transcript),
// not the whole window. Read it with React's useSyncExternalStore(value.subscribe, value.get).
export function liveValue(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? next(value) : next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// The louder source's recent level, 0–1, for the dock's listening bars.
export function meterLevel(levels, now = Date.now()) {
  return Math.max(
    0,
    ...['microphone', 'system'].map((source) =>
      levels[source] && now - levels[source].receivedAt < 3000
        ? Math.sqrt(Math.max(0, Number(levels[source].rms) || 0))
        : 0,
    ),
  );
}
