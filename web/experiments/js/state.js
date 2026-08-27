/**
 * One place the page's data lives, and one way to hear that it changed.
 *
 * Small enough not to need a framework, explicit enough that no render
 * function reaches into the network or into another render function.
 */

/** @typedef {{jobs: object[], experiments: object[], outcomes: object[], selected: string|null, error: string|null, loading: boolean}} AppState */

/** @type {AppState} */
const state = {
  jobs: [],
  experiments: [],
  outcomes: [],
  selected: null,
  error: null,
  loading: true
};

/** @type {Array<(s: AppState) => void>} */
const listeners = [];

/**
 * @returns {AppState} a shallow copy, so a renderer cannot mutate the source
 */
export function getState() {
  return { ...state };
}

/**
 * @param {Partial<AppState>} patch
 * @returns {void}
 */
export function setState(patch) {
  Object.assign(state, patch);
  for (const listener of listeners) listener(getState());
}

/**
 * @param {(s: AppState) => void} listener
 * @returns {() => void} unsubscribe
 */
export function subscribe(listener) {
  listeners.push(listener);
  return () => {
    const i = listeners.indexOf(listener);
    if (i >= 0) listeners.splice(i, 1);
  };
}
