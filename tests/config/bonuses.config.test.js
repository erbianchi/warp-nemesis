import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BONUSES,
  BONUS_PICKUP_MOTION,
  BONUS_PICKUP_SOUNDS,
  BONUS_SHIELD_ROLL,
  BONUS_TYPES,
} from '../../config/bonuses.config.js';

describe('BONUSES', () => {
  it('defines the expected pickup types', () => {
    assert.deepEqual(Object.keys(BONUS_TYPES), [
      'EXTRA_LIFE',
      'HEALTH_50',
      'SHIELD_50',
      'WEAPON_UPGRADE',
      'NEW_WEAPON',
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

  it('keeps weapon-related bonuses marked pending until their behavior is designed', () => {
    assert.equal(BONUSES.weaponUpgrade.pending, true);
    assert.equal(BONUSES.newWeapon.pending, true);
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
    assert.equal(BONUSES.newWeapon.pickupSound, BONUS_PICKUP_SOUNDS.NONE);
  });
});
