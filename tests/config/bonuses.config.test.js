import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BONUSES,
  BONUS_EFFECT_VALUES,
  BONUS_PICKUP_MOTION,
  BONUS_PICKUP_SOUNDS,
  BONUS_SHIELD_ROLL,
  BONUS_TYPES,
} from '../../config/bonuses.config.js';
import { WEAPONS } from '../../config/weapons.config.js';

describe('BONUSES', () => {
  it('defines the expected pickup types', () => {
    assert.deepEqual(Object.keys(BONUS_TYPES), [
      'EXTRA_LIFE',
      'HEALTH_50',
      'SHIELD_50',
      'WEAPON_UPGRADE',
      'COOLING_BOOST',
      'LASER_POWER_2X',
      'T_LASER',
      'Y_LASER',
    ]);
  });

  it('contains all configured bonus entries', () => {
    for (const bonusKey of Object.values(BONUS_TYPES)) {
      assert.ok(BONUSES[bonusKey], `Missing bonus config for ${bonusKey}`);
    }
  });

  it('uses positive weights for weighted drop selection', () => {
    for (const bonus of Object.values(BONUSES)) {
      assert.ok(bonus.weight > 0, `${bonus.key} must have a positive weight`);
    }
  });

  it('keeps weapon upgrades pending but ships concrete laser pickups live', () => {
    assert.equal(BONUSES.weaponUpgrade.pending, true);
    assert.equal(BONUSES.coolingBoost.pending, false);
    assert.equal(BONUSES.laserPower2x.pending, false);
    assert.equal(BONUSES.tLaser.pending, false);
    assert.equal(BONUSES.yLaser.pending, false);
    assert.equal(BONUSES.extraLife.pending, false);
    assert.equal(BONUSES.health50.pending, false);
    assert.equal(BONUSES.shield50.pending, false);
  });

  it('defines the random shield roll range for spawned bonuses', () => {
    assert.equal(BONUS_SHIELD_ROLL.chance, 0.35);
    assert.equal(BONUS_SHIELD_ROLL.minPoints, 100);
    assert.equal(BONUS_SHIELD_ROLL.maxPoints, 200);
  });

  it('defines the slower default pickup drift speed', () => {
    assert.equal(BONUS_PICKUP_MOTION.fallSpeed, 64);
  });

  it('defines readable pickup sound keys for bonus config entries', () => {
    assert.equal(BONUS_PICKUP_SOUNDS.FORCE_FIELD, 'forceField_001');
    assert.equal(BONUS_PICKUP_SOUNDS.NONE, '');
  });

  it('gives every bonus an explicit pickup sound key or an empty string', () => {
    for (const bonus of Object.values(BONUSES)) {
      assert.equal(typeof bonus.pickupSound, 'string');
    }
    assert.equal(BONUSES.extraLife.pickupSound, BONUS_PICKUP_SOUNDS.FORCE_FIELD);
    assert.equal(BONUSES.health50.pickupSound, BONUS_PICKUP_SOUNDS.FORCE_FIELD);
    assert.equal(BONUSES.shield50.pickupSound, BONUS_PICKUP_SOUNDS.FORCE_FIELD);
    assert.equal(BONUSES.weaponUpgrade.pickupSound, BONUS_PICKUP_SOUNDS.NONE);
    assert.equal(BONUSES.coolingBoost.pickupSound, BONUS_PICKUP_SOUNDS.FORCE_FIELD);
    assert.equal(BONUSES.laserPower2x.pickupSound, BONUS_PICKUP_SOUNDS.FORCE_FIELD);
    assert.equal(BONUSES.tLaser.pickupSound, BONUS_PICKUP_SOUNDS.FORCE_FIELD);
    assert.equal(BONUSES.yLaser.pickupSound, BONUS_PICKUP_SOUNDS.FORCE_FIELD);
  });

  it('defines concrete slot-1 weapon pickups with explicit weapon keys', () => {
    assert.equal(BONUSES.tLaser.kind, 'newWeapon');
    assert.equal(BONUSES.tLaser.weaponKey, 'tLaser');
    assert.equal(BONUSES.tLaser.label, WEAPONS.tLaser.name);
    assert.equal(BONUSES.yLaser.kind, 'newWeapon');
    assert.equal(BONUSES.yLaser.weaponKey, 'yLaser');
    assert.equal(BONUSES.yLaser.label, WEAPONS.yLaser.name);
  });

  it('defines the timed cooling boost in readable config values', () => {
    assert.equal(BONUS_EFFECT_VALUES.COOLING_BOOST.recoveryMs, 50);
    assert.equal(BONUS_EFFECT_VALUES.COOLING_BOOST.durationMs, 30000);
    assert.equal(BONUSES.coolingBoost.kind, 'coolingBoost');
    assert.equal(BONUSES.coolingBoost.recoveryMs, BONUS_EFFECT_VALUES.COOLING_BOOST.recoveryMs);
    assert.equal(BONUSES.coolingBoost.durationMs, BONUS_EFFECT_VALUES.COOLING_BOOST.durationMs);
  });

  it('defines the stackable laser power multiplier in readable config values', () => {
    assert.equal(BONUS_EFFECT_VALUES.LASER_POWER_2X.multiplier, 2);
    assert.equal(BONUSES.laserPower2x.kind, 'laserPower');
    assert.equal(BONUSES.laserPower2x.multiplier, BONUS_EFFECT_VALUES.LASER_POWER_2X.multiplier);
    assert.equal(BONUSES.laserPower2x.label, `${WEAPONS.laser.name} x2`);
  });
});
