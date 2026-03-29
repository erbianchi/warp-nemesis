/** @module EnemyFeatureEncoder */

import { GAME_CONFIG } from '../../config/game.config.js';
import { WEAPONS } from '../../config/weapons.config.js';
import {
  DEFAULT_ENEMY_ACTION_MODE,
  ENEMY_ACTION_MODES,
  ENEMY_LEARNING_CONFIG,
} from '../../config/enemyLearning.config.js';
import { resolveShotAlignment } from './EnemyPolicyMath.js';
import { clamp } from '../../utils/math.js';

const WEAPON_KEYS = Object.freeze(Object.keys(WEAPONS));
export const ENEMY_ACTION_MODE_OFFSET = 24;
export const ENEMY_ACTION_MODE_COUNT = ENEMY_ACTION_MODES.length;

function toActionModeFeatureName(mode) {
  return `actionMode${mode[0].toUpperCase()}${mode.slice(1)}`;
}

const ACTION_MODE_FEATURE_NAMES = ENEMY_ACTION_MODES.map(toActionModeFeatureName);

/**
 * Encodes a single enemy state/action sample into a fixed numeric vector that
 * both training and runtime policy evaluation can share.
 */
export class EnemyFeatureEncoder {
  constructor(options = {}) {
    this._width = options.width ?? GAME_CONFIG.WIDTH;
    this._height = options.height ?? GAME_CONFIG.HEIGHT;
    this._normalization = {
      ...ENEMY_LEARNING_CONFIG.normalization,
      ...(options.normalization ?? {}),
    };
    this._weaponKeys = options.weaponKeys ?? WEAPON_KEYS;
    this._featureNames = [
      'playerXNorm',
      'playerYNorm',
      'playerShieldUp',
      'playerShieldRatio',
      'playerHpRatio',
      'playerHeatRatio',
      'playerOverheated',
      'playerDamageMultiplierNorm',
      'enemyXNorm',
      'enemyYNorm',
      'squadXNorm',
      'squadYNorm',
      'dxNorm',
      'dyNorm',
      'squadWidthNorm',
      'squadAliveNorm',
      'speedNorm',
      'shotAlignment',
      'proximityNorm',
      'shieldedProximityNorm',
      'shieldedLaneRisk',
      'nearestBulletDistanceNorm',
      'bulletLaneThreat',
      'bulletTimeToImpactNorm',
      ...ACTION_MODE_FEATURE_NAMES,
      ...this._weaponKeys.map(key => `weapon_${key}`),
    ];
  }

  /**
   * @returns {string[]}
   */
  getFeatureNames() {
    return [...this._featureNames];
  }

  /**
   * Build a normalized sample from live gameplay context.
   * @param {{
   *   enemyType: string,
   *   player?: object,
   *   weapon?: object,
   *   enemyX: number,
   *   enemyY: number,
   *   speed?: number,
   *   squad?: object,
   * }} context
   * @returns {object}
   */
  buildSample(context = {}) {
    const player = context.player ?? {};
    const weapon = context.weapon ?? {};
    const enemyX = context.enemyX ?? 0;
    const enemyY = context.enemyY ?? 0;
    const squad = context.squad ?? {};
    const dx = enemyX - (player.x ?? 0);
    const dy = enemyY - (player.y ?? 0);
    const distanceNorm = clamp(
      Math.hypot(dx, dy) / Math.max(1, this._normalization.diagonal),
      0,
      1.5
    );
    const proximityNorm = clamp(1 - distanceNorm, 0, 1);
    const sameLane = Math.abs(dx) <= this._normalization.sameLaneThresholdPx ? 1 : 0;
    const playerShieldUp = player.hasShield ? 1 : 0;
    const threat = context.threat ?? {};
    const actionMode = context.actionMode ?? DEFAULT_ENEMY_ACTION_MODE;
    const actionModeFlags = Object.fromEntries(
      ENEMY_ACTION_MODES.map((mode) => [toActionModeFeatureName(mode), actionMode === mode ? 1 : 0])
    );

    return {
      enemyType: context.enemyType ?? 'skirm',
      playerXNorm: clamp((player.x ?? 0) / this._width, 0, 1),
      playerYNorm: clamp((player.y ?? 0) / this._height, 0, 1),
      playerShieldUp,
      playerShieldRatio: clamp(player.shieldRatio ?? 0, 0, 1),
      playerHpRatio: clamp(player.hpRatio ?? 0, 0, 1),
      playerHeatRatio: clamp(weapon.heatRatio ?? 0, 0, 1),
      playerOverheated: weapon.isOverheated ? 1 : 0,
      playerDamageMultiplierNorm: clamp(
        (weapon.primaryDamageMultiplier ?? 1) / this._normalization.maxPrimaryDamageMultiplier,
        0,
        1.5
      ),
      enemyXNorm: clamp(enemyX / this._width, 0, 1),
      enemyYNorm: clamp(enemyY / this._height, -0.25, 1.25),
      squadXNorm: clamp((squad.centroidX ?? enemyX) / this._width, 0, 1),
      squadYNorm: clamp((squad.centroidY ?? enemyY) / this._height, -0.25, 1.25),
      dxNorm: clamp(dx / this._width, -1.5, 1.5),
      dyNorm: clamp(dy / this._height, -1.5, 1.5),
      squadWidthNorm: clamp((squad.width ?? 0) / this._width, 0, 1),
      squadAliveNorm: clamp(squad.aliveRatio ?? 1, 0, 1),
      speedNorm: clamp((context.speed ?? 0) / Math.max(1, this._normalization.maxSpeed), 0, 2),
      shotAlignment: resolveShotAlignment(
        context.enemyType ?? 'skirm',
        -dx,
        -dy,
        this._normalization
      ),
      proximityNorm,
      shieldedProximityNorm: playerShieldUp ? proximityNorm : 0,
      shieldedLaneRisk: playerShieldUp ? sameLane * proximityNorm : 0,
      nearestBulletDistanceNorm: clamp(
        (threat.nearestBulletDistance ?? this._normalization.maxBulletThreatDistance)
          / Math.max(1, this._normalization.maxBulletThreatDistance),
        0,
        1.5
      ),
      bulletLaneThreat: clamp(threat.bulletLaneThreat ?? 0, 0, 1.5),
      bulletTimeToImpactNorm: clamp(
        (threat.bulletTimeToImpactMs ?? this._normalization.maxBulletTimeToImpactMs)
          / Math.max(1, this._normalization.maxBulletTimeToImpactMs),
        0,
        1.5
      ),
      ...actionModeFlags,
      weaponKey: weapon.primaryWeaponKey ?? null,
    };
  }

  /**
   * @param {object} sample
   * @returns {{vector: number[], featureNames: string[]}}
   */
  encodeSample(sample) {
    const vector = [
      sample.playerXNorm ?? 0,
      sample.playerYNorm ?? 0,
      sample.playerShieldUp ?? 0,
      sample.playerShieldRatio ?? 0,
      sample.playerHpRatio ?? 0,
      sample.playerHeatRatio ?? 0,
      sample.playerOverheated ?? 0,
      sample.playerDamageMultiplierNorm ?? 0,
      sample.enemyXNorm ?? 0,
      sample.enemyYNorm ?? 0,
      sample.squadXNorm ?? 0,
      sample.squadYNorm ?? 0,
      sample.dxNorm ?? 0,
      sample.dyNorm ?? 0,
      sample.squadWidthNorm ?? 0,
      sample.squadAliveNorm ?? 0,
      sample.speedNorm ?? 0,
      sample.shotAlignment ?? 0,
      sample.proximityNorm ?? 0,
      sample.shieldedProximityNorm ?? 0,
      sample.shieldedLaneRisk ?? 0,
      sample.nearestBulletDistanceNorm ?? 0,
      sample.bulletLaneThreat ?? 0,
      sample.bulletTimeToImpactNorm ?? 0,
      ...ACTION_MODE_FEATURE_NAMES.map(name => sample[name] ?? 0),
      ...this._weaponKeys.map(key => (sample.weaponKey === key ? 1 : 0)),
    ];

    return {
      vector,
      featureNames: this.getFeatureNames(),
    };
  }

  /**
   * Backwards-compatible alias used by tests and callers that previously
   * invoked `encode()`.
   * @param {object} sample
   * @returns {{vector: number[], featureNames: string[]}}
   */
  encode(sample) {
    return this.encodeSample(sample);
  }
}
