/** @module SquadFeatureEncoder */

import { GAME_CONFIG } from '../../config/game.config.js';
import { WEAPONS } from '../../config/weapons.config.js';
import { ENEMY_LEARNING_CONFIG } from '../../config/enemyLearning.config.js';
import { resolveShotAlignment } from './EnemyPolicyMath.js';
import { clamp } from '../../utils/math.js';

const WEAPON_KEYS = Object.freeze(Object.keys(WEAPONS));
const DANCE_KEYS = Object.freeze([
  'straight',
  'sweep_left',
  'sweep_right',
  'zigzag',
  'drift_drop',
  'jink_drop',
  'whirl',
  'hourglass',
  'side_cross',
  'fan_out',
  'side_left',
  'side_right',
]);

export class SquadFeatureEncoder {
  constructor(options = {}) {
    this._width = options.width ?? GAME_CONFIG.WIDTH;
    this._height = options.height ?? GAME_CONFIG.HEIGHT;
    this._normalization = {
      ...ENEMY_LEARNING_CONFIG.normalization,
      ...(options.normalization ?? {}),
    };
    this._weaponKeys = options.weaponKeys ?? WEAPON_KEYS;
    this._danceKeys = options.danceKeys ?? DANCE_KEYS;
    this._featureNames = [
      'playerXNorm',
      'playerYNorm',
      'playerShieldUp',
      'playerShieldRatio',
      'playerHpRatio',
      'playerHeatRatio',
      'playerOverheated',
      'playerDamageMultiplierNorm',
      'squadXNorm',
      'squadYNorm',
      'squadWidthNorm',
      'squadAliveNorm',
      'dxNorm',
      'dyNorm',
      'distanceNorm',
      'sameLane',
      'shotAlignment',
      'closestEnemyDistanceNorm',
      'shotCountNorm',
      'playerHitCountNorm',
      'hpDamageNorm',
      'shieldDamageNorm',
      'collisionDeathNorm',
      'overlayRaid',
      'formationPresent',
      ...this._weaponKeys.map(key => `weapon_${key}`),
      ...this._danceKeys.map(key => `dance_${key}`),
    ];
  }

  getFeatureNames() {
    return [...this._featureNames];
  }

  buildSample(context = {}) {
    const player = context.player ?? {};
    const weapon = context.weapon ?? {};
    const squad = context.squad ?? {};
    const stats = context.stats ?? {};
    const centroidX = squad.centroidX ?? 0;
    const centroidY = squad.centroidY ?? 0;
    const dx = centroidX - (player.x ?? 0);
    const dy = centroidY - (player.y ?? 0);
    const distanceNorm = clamp(
      Math.hypot(dx, dy) / Math.max(1, this._normalization.diagonal),
      0,
      1.5
    );
    const primaryType = context.primaryEnemyType ?? 'skirm';

    return {
      playerXNorm: clamp((player.x ?? 0) / this._width, 0, 1),
      playerYNorm: clamp((player.y ?? 0) / this._height, 0, 1),
      playerShieldUp: player.hasShield ? 1 : 0,
      playerShieldRatio: clamp(player.shieldRatio ?? 0, 0, 1),
      playerHpRatio: clamp(player.hpRatio ?? 0, 0, 1),
      playerHeatRatio: clamp(weapon.heatRatio ?? 0, 0, 1),
      playerOverheated: weapon.isOverheated ? 1 : 0,
      playerDamageMultiplierNorm: clamp(
        (weapon.primaryDamageMultiplier ?? 1) / this._normalization.maxPrimaryDamageMultiplier,
        0,
        1.5
      ),
      squadXNorm: clamp(centroidX / this._width, 0, 1),
      squadYNorm: clamp(centroidY / this._height, -0.25, 1.25),
      squadWidthNorm: clamp((squad.width ?? 0) / this._width, 0, 1),
      squadAliveNorm: clamp(squad.aliveRatio ?? 1, 0, 1),
      dxNorm: clamp(dx / this._width, -1.5, 1.5),
      dyNorm: clamp(dy / this._height, -1.5, 1.5),
      distanceNorm,
      sameLane: Math.abs(dx) <= this._normalization.sameLaneThresholdPx ? 1 : 0,
      shotAlignment: resolveShotAlignment(primaryType, -dx, -dy, this._normalization),
      closestEnemyDistanceNorm: clamp(
        (context.closestEnemyDistance ?? 0) / Math.max(1, this._normalization.diagonal),
        0,
        1.5
      ),
      shotCountNorm: clamp(
        (stats.shotCount ?? 0) / Math.max(1, this._normalization.maxShotsPerSquad),
        0,
        2
      ),
      playerHitCountNorm: clamp(
        (stats.playerHitCount ?? 0) / Math.max(1, stats.spawnCount ?? 1),
        0,
        2
      ),
      hpDamageNorm: clamp(
        (stats.hpDamageToPlayer ?? 0) / Math.max(1, this._normalization.maxHpDamagePerSquad),
        0,
        2
      ),
      shieldDamageNorm: clamp(
        (stats.shieldDamageToPlayer ?? 0) / Math.max(1, this._normalization.maxShieldDamagePerSquad),
        0,
        2
      ),
      collisionDeathNorm: clamp(
        (stats.collisionDeathCount ?? 0) / Math.max(1, stats.spawnCount ?? 1),
        0,
        1
      ),
      overlayRaid: context.overlay ? 1 : 0,
      formationPresent: context.formation ? 1 : 0,
      weaponKey: weapon.primaryWeaponKey ?? null,
      danceKey: context.dance ?? null,
    };
  }

  encodeSample(sample = {}) {
    return {
      vector: [
        sample.playerXNorm ?? 0,
        sample.playerYNorm ?? 0,
        sample.playerShieldUp ?? 0,
        sample.playerShieldRatio ?? 0,
        sample.playerHpRatio ?? 0,
        sample.playerHeatRatio ?? 0,
        sample.playerOverheated ?? 0,
        sample.playerDamageMultiplierNorm ?? 0,
        sample.squadXNorm ?? 0,
        sample.squadYNorm ?? 0,
        sample.squadWidthNorm ?? 0,
        sample.squadAliveNorm ?? 0,
        sample.dxNorm ?? 0,
        sample.dyNorm ?? 0,
        sample.distanceNorm ?? 0,
        sample.sameLane ?? 0,
        sample.shotAlignment ?? 0,
        sample.closestEnemyDistanceNorm ?? 0,
        sample.shotCountNorm ?? 0,
        sample.playerHitCountNorm ?? 0,
        sample.hpDamageNorm ?? 0,
        sample.shieldDamageNorm ?? 0,
        sample.collisionDeathNorm ?? 0,
        sample.overlayRaid ?? 0,
        sample.formationPresent ?? 0,
        ...this._weaponKeys.map(key => (sample.weaponKey === key ? 1 : 0)),
        ...this._danceKeys.map(key => (sample.danceKey === key ? 1 : 0)),
      ],
      featureNames: this.getFeatureNames(),
    };
  }
}
