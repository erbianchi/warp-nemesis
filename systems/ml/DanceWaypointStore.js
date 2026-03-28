/** @module DanceWaypointStore
 * Persists DanceWaypointNetwork weights via localStorage.
 * Uses the same stage/promote pattern as EnemyLearningStore: retrained
 * weights are staged during gameplay and promoted on the next game load,
 * so the current run never mid-flight sees its own retraining. */

const STAGED_SUFFIX = '.staged';

export class DanceWaypointStore {
  /**
   * @param {string} [storageKey='warp-nemesis.danceWaypoint']
   */
  constructor(storageKey = 'warp-nemesis.danceWaypoint') {
    this._key       = storageKey;
    this._stagedKey = storageKey + STAGED_SUFFIX;
  }

  /**
   * Load the promoted state, promoting any staged state first.
   * Returns an empty object when no state has been saved yet.
   * @returns {object}
   */
  load() {
    this._promoteStagedIfReady();
    try {
      const raw = globalThis.localStorage?.getItem(this._key);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  /**
   * Persist a state immediately (used for synchronous, non-background saves).
   * @param {object} state
   * @returns {object} The saved state.
   */
  save(state) {
    try {
      globalThis.localStorage?.setItem(this._key, JSON.stringify(state));
    } catch {}
    return state;
  }

  /**
   * Queue a retrained state to be promoted on the next load().
   * @param {object} state
   */
  stage(state) {
    try {
      globalThis.localStorage?.setItem(this._stagedKey, JSON.stringify(state));
    } catch {}
  }

  _promoteStagedIfReady() {
    try {
      const staged = globalThis.localStorage?.getItem(this._stagedKey);
      if (!staged) return;
      globalThis.localStorage?.setItem(this._key, staged);
      globalThis.localStorage?.removeItem(this._stagedKey);
    } catch {}
  }
}
