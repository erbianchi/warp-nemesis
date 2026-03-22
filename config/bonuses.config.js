/** @module bonuses.config
 * Bonus pickup definitions. */

export const BONUS_TYPES = Object.freeze({
  EXTRA_LIFE:     'extraLife',
  HEALTH_50:      'health50',
  SHIELD_50:      'shield50',
  WEAPON_UPGRADE: 'weaponUpgrade',
  NEW_WEAPON:     'newWeapon',
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
  [BONUS_TYPES.NEW_WEAPON]: {
    key:         BONUS_TYPES.NEW_WEAPON,
    label:       'New Weapon',
    kind:        'newWeapon',
    value:       1,
    weight:      1,
    pickupSound: BONUS_PICKUP_SOUNDS.NONE,
    pending:     true,
  },
});
