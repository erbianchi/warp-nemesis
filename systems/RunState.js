/** @module RunState
 * Roguelike run singleton — single source of truth that persists across levels.
 * Reset at the start of every new run. */

export const RunState = {
  score:  0,
  lives:  3,
  level:  1,
  kills:  0,

  /**
   * Add points to the running score.
   * @param {number} amount
   */
  addScore(amount) {
    this.score += amount;
  },

  /** Reset all fields to their initial values (call at new-game start). */
  reset() {
    this.score = 0;
    this.lives = 3;
    this.level = 1;
    this.kills = 0;
  },
};
