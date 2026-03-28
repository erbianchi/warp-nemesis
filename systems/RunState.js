/** @module RunState
 * Roguelike run singleton — single source of truth that persists across levels.
 * Reset at the start of every new run. */

function clonePlain(value) {
  if (Array.isArray(value)) return value.map(clonePlain);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, clonePlain(inner)])
    );
  }
  return value;
}

export const RunState = {
  score: 0,
  lives: 3,
  level: 1,
  kills: 0,
  playerState: null,
  playerStyleProfile: null,

  /**
   * Add points to the running score.
   * @param {number} amount
   */
  addScore(amount) {
    this.score += amount;
  },

  /**
   * Start a brand-new run with optional overrides.
   * @param {{level?: number, lives?: number}} [options={}]
   */
  beginNewRun(options = {}) {
    this.reset();
    this.level = Math.max(1, Math.round(options.level ?? 1));
    this.lives = Math.max(1, Math.round(options.lives ?? 3));
  },

  /**
   * Save the player checkpoint used when entering the next level.
   * @param {object|null} playerState
   * @returns {object|null}
   */
  savePlayerState(playerState) {
    this.playerState = playerState == null ? null : clonePlain(playerState);
    return this.playerState;
  },

  /**
   * Save the current run's learned player style profile.
   * @param {object|null} playerStyleProfile
   * @returns {object|null}
   */
  savePlayerStyleProfile(playerStyleProfile) {
    this.playerStyleProfile = playerStyleProfile == null ? null : clonePlain(playerStyleProfile);
    return this.playerStyleProfile == null ? null : clonePlain(this.playerStyleProfile);
  },

  /**
   * True while a saved player checkpoint is available for the next scene.
   * @returns {boolean}
   */
  hasPlayerState() {
    return this.playerState !== null;
  },

  /**
   * Consume and clear the current player checkpoint.
   * @returns {object|null}
   */
  consumePlayerState() {
    const saved = this.playerState == null ? null : clonePlain(this.playerState);
    this.playerState = null;
    return saved;
  },

  /** Clear any saved checkpoint from the current run. */
  clearPlayerState() {
    this.playerState = null;
  },

  /** Clear the current run's learned style profile. */
  clearPlayerStyleProfile() {
    this.playerStyleProfile = null;
  },

  /** Reset all fields to their initial values (call at new-game start). */
  reset() {
    this.score = 0;
    this.lives = 3;
    this.level = 1;
    this.kills = 0;
    this.playerState = null;
    this.playerStyleProfile = null;
  },
};
