/** @module BonusSystem
 * Handles bonus drop rolls, pickup lifecycles, and collection payloads. */

import { BONUSES, BONUS_SHIELD_ROLL } from '../config/bonuses.config.js';
import { EVENTS }      from '../config/events.config.js';
import { GAME_CONFIG } from '../config/game.config.js';
import { BonusPickup } from '../entities/BonusPickup.js';

const BONUS_KEYS = Object.freeze(Object.keys(BONUSES));

/**
 * Weighted random choice from the configured bonus pool.
 * @param {Function} [rng=Math.random]
 * @param {string[]} [pool=Object.keys(BONUSES)]
 * @returns {string}
 */
export function pickWeightedBonusKey(rng = Math.random, pool = BONUS_KEYS) {
  const entries = pool.map(key => {
    const config = BONUSES[key];
    if (!config) throw new Error(`BonusSystem: unknown bonus key "${key}"`);
    return config;
  });

  const totalWeight = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight ?? 0), 0);
  if (totalWeight <= 0) throw new Error('BonusSystem: bonus pool must contain at least one positive weight');

  let roll = rng() * totalWeight;
  for (const entry of entries) {
    roll -= Math.max(0, entry.weight ?? 0);
    if (roll <= 0) return entry.key;
  }

  return entries.at(-1).key;
}

/**
 * Roll the optional shield applied to a spawned bonus.
 * @param {Function} [rng=Math.random]
 * @param {object} [shieldRoll=BONUS_SHIELD_ROLL]
 * @param {number} [shieldRoll.chance]
 * @param {number} [shieldRoll.minPoints]
 * @param {number} [shieldRoll.maxPoints]
 * @returns {number}
 */
export function rollBonusShieldPoints(rng = Math.random, shieldRoll = BONUS_SHIELD_ROLL) {
  const chance = Math.max(0, Math.min(1, shieldRoll?.chance ?? 0));
  if (chance <= 0 || rng() >= chance) return 0;

  const minPoints = Math.max(0, Math.min(shieldRoll?.minPoints ?? 0, shieldRoll?.maxPoints ?? 0));
  const maxPoints = Math.max(minPoints, shieldRoll?.maxPoints ?? minPoints);
  const spread = maxPoints - minPoints + 1;
  const roll = Math.max(0, Math.min(1, rng()));

  return Math.min(maxPoints, minPoints + Math.floor(roll * spread));
}

export class BonusSystem {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} [opts]
   * @param {Function} [opts.rng=Math.random]
   * @param {EffectsSystem} [opts.effects]
   */
  constructor(scene, opts = {}) {
    this._scene = scene;
    this._rng = opts.rng ?? Math.random;
    this._effects = opts.effects ?? null;
    this._bonuses = [];
    this._group = scene.physics.add.group();
  }

  /** Physics group used for player overlaps. */
  get group() {
    return this._group;
  }

  /** Active pickups. */
  get bonuses() {
    return this._bonuses;
  }

  /**
   * Try to spawn a random bonus after an enemy death.
   * @param {number} x
   * @param {number} y
   * @param {number} [dropChance=0]
   * @param {object} [opts]
   * @param {string[]} [opts.pool]
   * @param {number} [opts.shieldPoints=0]
   * @param {object} [opts.shieldRoll]
   * @returns {BonusPickup|null}
   */
  spawnRandomDrop(x, y, dropChance = 0, opts = {}) {
    if (Math.max(0, dropChance ?? 0) <= 0) return null;
    if (this._rng() > dropChance) return null;

    const bonusKey = pickWeightedBonusKey(this._rng, opts.pool ?? BONUS_KEYS);
    return this.spawnBonus(bonusKey, x, y, opts);
  }

  /**
   * Spawn a specific pickup type.
   * @param {string} bonusKey
   * @param {number} x
   * @param {number} y
   * @param {object} [opts]
   * @param {number} [opts.shieldPoints=0]
   * @param {object} [opts.shieldRoll]
   * @returns {BonusPickup}
   */
  spawnBonus(bonusKey, x, y, opts = {}) {
    const config = BONUSES[bonusKey];
    if (!config) throw new Error(`BonusSystem: unknown bonus key "${bonusKey}"`);

    const shieldPoints = opts.shieldPoints
      ?? rollBonusShieldPoints(this._rng, opts.shieldRoll ?? BONUS_SHIELD_ROLL);

    const bonus = new BonusPickup(this._scene, x, y, config, {
      effects:      this._effects,
      shieldPoints,
      rng:          this._rng,
    });

    this._bonuses.push(bonus);
    this._group.add?.(bonus);
    return bonus;
  }

  /**
   * Update and cull bonuses.
   * @param {number} delta
   */
  update(delta) {
    for (let i = this._bonuses.length - 1; i >= 0; i--) {
      const bonus = this._bonuses[i];
      if (!bonus.active) {
        this._bonuses.splice(i, 1);
        continue;
      }

      bonus.update(delta);
      if (bonus.y > GAME_CONFIG.HEIGHT + 40) {
        bonus.remove();
        this._bonuses.splice(i, 1);
      }
    }
  }

  /**
   * Collect a pickup and emit the bonus payload.
   * @param {BonusPickup} bonus
   * @returns {object|null}
   */
  collectBonus(bonus) {
    if (!bonus?.active || bonus.canCollect?.() === false) return null;

    const payload = {
      key:         bonus.bonusConfig.key,
      kind:        bonus.bonusConfig.kind,
      value:       bonus.bonusConfig.value,
      label:       bonus.bonusConfig.label,
      pickupSound: bonus.bonusConfig.pickupSound ?? '',
      pending:     bonus.bonusConfig.pending === true,
      x:           bonus.x,
      y:           bonus.y,
    };

    ['weaponKey', 'recoveryMs', 'durationMs', 'multiplier'].forEach((field) => {
      if (bonus.bonusConfig[field] !== undefined) payload[field] = bonus.bonusConfig[field];
    });

    this._removeTrackedBonus(bonus);
    bonus.remove();
    this._scene.events.emit(EVENTS.BONUS_COLLECTED, payload);
    return payload;
  }

  /** Remove every live pickup, used when replaying a squadron after death. */
  clear() {
    for (const bonus of this._bonuses) {
      this._group.remove?.(bonus, false, false);
      bonus.remove();
    }
    this._bonuses = [];
  }

  _removeTrackedBonus(bonus) {
    const idx = this._bonuses.indexOf(bonus);
    if (idx !== -1) this._bonuses.splice(idx, 1);
    this._group.remove?.(bonus, false, false);
  }
}
