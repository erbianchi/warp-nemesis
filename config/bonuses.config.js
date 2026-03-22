/** @module bonuses.config
 * Bonus pickup definitions. */

export const BONUS_TYPES = Object.freeze({
  EXTRA_LIFE:     'extraLife',
  HEALTH_50:      'health50',
  SHIELD_50:      'shield50',
  WEAPON_UPGRADE: 'weaponUpgrade',
  COOLING_BOOST:  'coolingBoost',
  LASER_POWER_2X: 'laserPower2x',
  T_LASER:        'tLaser',
  Y_LASER:        'yLaser',
});

export const BONUS_SHIELD_ROLL = Object.freeze({
  chance:    0.35,
  minPoints: 100,
  maxPoints: 200,
});

export const BONUS_PICKUP_MOTION = Object.freeze({
  fallSpeed: 64,
});

export const BONUS_PICKUP_SOUNDS = Object.freeze({
  NONE:        '',
  FORCE_FIELD: 'forceField_001',
});

export const BONUS_EFFECT_VALUES = Object.freeze({
  COOLING_BOOST: Object.freeze({
    recoveryMs: 50,
    durationMs: 30000,
  }),
  LASER_POWER_2X: Object.freeze({
    multiplier: 2,
  }),
});

export const BONUSES = Object.freeze({
  [BONUS_TYPES.EXTRA_LIFE]: {
    key:         BONUS_TYPES.EXTRA_LIFE,
    label:       '1-Up',
    kind:        'life',
    value:       1,
    weight:      1,
    pickupSound: BONUS_PICKUP_SOUNDS.FORCE_FIELD,
    pending:     false,
  },
  [BONUS_TYPES.HEALTH_50]: {
    key:         BONUS_TYPES.HEALTH_50,
    label:       '+50 Life',
    kind:        'health',
    value:       50,
    weight:      3,
    pickupSound: BONUS_PICKUP_SOUNDS.FORCE_FIELD,
    pending:     false,
  },
  [BONUS_TYPES.SHIELD_50]: {
    key:         BONUS_TYPES.SHIELD_50,
    label:       '+50 Shield',
    kind:        'shield',
    value:       50,
    weight:      3,
    pickupSound: BONUS_PICKUP_SOUNDS.FORCE_FIELD,
    pending:     false,
  },
  [BONUS_TYPES.WEAPON_UPGRADE]: {
    key:         BONUS_TYPES.WEAPON_UPGRADE,
    label:       'Weapon Upgrade',
    kind:        'weaponUpgrade',
    value:       1,
    weight:      1,
    pickupSound: BONUS_PICKUP_SOUNDS.NONE,
    pending:     true,
  },
  [BONUS_TYPES.COOLING_BOOST]: {
    key:         BONUS_TYPES.COOLING_BOOST,
    label:       'Cooling Boost',
    kind:        'coolingBoost',
    value:       BONUS_EFFECT_VALUES.COOLING_BOOST.recoveryMs,
    recoveryMs:  BONUS_EFFECT_VALUES.COOLING_BOOST.recoveryMs,
    durationMs:  BONUS_EFFECT_VALUES.COOLING_BOOST.durationMs,
    weight:      1,
    pickupSound: BONUS_PICKUP_SOUNDS.FORCE_FIELD,
    pending:     false,
  },
  [BONUS_TYPES.LASER_POWER_2X]: {
    key:         BONUS_TYPES.LASER_POWER_2X,
    label:       'Laser x2',
    kind:        'laserPower',
    value:       BONUS_EFFECT_VALUES.LASER_POWER_2X.multiplier,
    multiplier:  BONUS_EFFECT_VALUES.LASER_POWER_2X.multiplier,
    weight:      1,
    pickupSound: BONUS_PICKUP_SOUNDS.FORCE_FIELD,
    pending:     false,
  },
  [BONUS_TYPES.T_LASER]: {
    key:         BONUS_TYPES.T_LASER,
    label:       'T-Laser',
    kind:        'newWeapon',
    value:       1,
    weaponKey:   'tLaser',
    weight:      1,
    pickupSound: BONUS_PICKUP_SOUNDS.FORCE_FIELD,
    pending:     false,
  },
  [BONUS_TYPES.Y_LASER]: {
    key:         BONUS_TYPES.Y_LASER,
    label:       'Y-Laser',
    kind:        'newWeapon',
    value:       1,
    weaponKey:   'yLaser',
    weight:      1,
    pickupSound: BONUS_PICKUP_SOUNDS.FORCE_FIELD,
    pending:     false,
  },
});
