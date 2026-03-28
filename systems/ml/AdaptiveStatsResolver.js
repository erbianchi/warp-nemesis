/** @module AdaptiveStatsResolver */

/**
 * Applies cross-run adaptive modifiers on top of the regular enemy stat
 * resolution pipeline.
 */
export class AdaptiveStatsResolver {
  /**
   * @param {{policy: {getModifiers(enemyType: string): {enabled?: boolean, minSpeedScalar?: number, maxSpeedScalar?: number, sampleCount?: number, predictedEnemyWinRate?: number, predictedPressure?: number, predictedCollisionRisk?: number, predictedBulletRisk?: number}}, baseResolveStats: Function}} options
   */
  constructor(options) {
    this._policy = options.policy;
    this._baseResolveStats = options.baseResolveStats;
  }

  /**
   * @param {{type: string, difficultyBase: number, difficultyFactor: number, planeOverrides?: object}} options
   * @returns {object}
   */
  resolve(options) {
    const baseStats = this._baseResolveStats(
      options.type,
      options.difficultyBase,
      options.difficultyFactor,
      options.planeOverrides ?? {}
    );
    const modifiers = this._policy?.getModifiers?.(options.type) ?? {};

    return {
      ...baseStats,
      adaptive: {
        ...modifiers,
        enemyType: options.type,
      },
    };
  }
}
