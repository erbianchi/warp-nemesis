import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WEAPONS } from '../../config/weapons.config.js';

const REQUIRED_WEAPONS = ['laser', 'tLaser', 'yLaser', 'spreadShot', 'missile', 'plasma', 'railgun', 'dualLaser', 'bomb'];
const REQUIRED_KEYS    = ['fireRate', 'speed', 'damage', 'color', 'poolSize'];

describe('WEAPONS config', () => {
  it('exports an object', () => {
    assert.equal(typeof WEAPONS, 'object');
    assert.notEqual(WEAPONS, null);
  });

  it('defines all required weapon types', () => {
    for (const id of REQUIRED_WEAPONS) {
      assert.ok(id in WEAPONS, `Missing weapon: ${id}`);
    }
  });

  it('every weapon has all required keys', () => {
    for (const [id, def] of Object.entries(WEAPONS)) {
      for (const key of REQUIRED_KEYS) {
        assert.ok(key in def, `${id} missing key: ${key}`);
      }
    }
  });

  it('all numeric values are finite and positive', () => {
    const numericKeys = ['fireRate', 'speed', 'damage', 'poolSize'];
    for (const [id, def] of Object.entries(WEAPONS)) {
      for (const key of numericKeys) {
        const v = def[key];
        assert.ok(typeof v === 'number' && isFinite(v) && v > 0,
          `${id}.${key} must be a finite positive number, got ${v}`);
      }
    }
  });

  it('color is a valid 24-bit integer', () => {
    for (const [id, def] of Object.entries(WEAPONS)) {
      assert.ok(Number.isInteger(def.color) && def.color >= 0 && def.color <= 0xffffff,
        `${id}.color is not a valid hex color: ${def.color}`);
    }
  });

  it('laser has the highest fire rate (lowest fireRate ms)', () => {
    const laserRate = WEAPONS.laser.fireRate;
    for (const [id, def] of Object.entries(WEAPONS)) {
      assert.ok(def.fireRate >= laserRate,
        `${id}.fireRate (${def.fireRate}) is faster than laser (${laserRate}) — laser should be the fastest`);
    }
  });

  it('missile has the highest damage', () => {
    const missileDamage = WEAPONS.missile.damage;
    for (const [id, def] of Object.entries(WEAPONS)) {
      if (id === 'bomb') continue; // bomb is area-effect, exempt
      assert.ok(def.damage <= missileDamage || id === 'bomb',
        `${id}.damage (${def.damage}) exceeds missile (${missileDamage})`);
    }
  });

  it('railgun is the fastest bullet', () => {
    const railSpeed = WEAPONS.railgun.speed;
    for (const [id, def] of Object.entries(WEAPONS)) {
      assert.ok(def.speed <= railSpeed,
        `${id}.speed (${def.speed}) exceeds railgun (${railSpeed})`);
    }
  });

  it('laser variants define readable names and shot patterns', () => {
    assert.equal(WEAPONS.laser.name, 'LASER');
    assert.equal(WEAPONS.tLaser.name, 'T-LASER');
    assert.equal(WEAPONS.yLaser.name, 'Y-LASER');
    assert.deepEqual(WEAPONS.laser.shots, [{ angle: 0, x: 0 }]);
    assert.deepEqual(WEAPONS.tLaser.shots, [{ angle: 0, x: 0 }, { angle: -90, x: -16 }, { angle: 90, x: 16 }]);
    assert.deepEqual(WEAPONS.yLaser.shots, [{ angle: 0, x: 0 }, { angle: -45, x: -10 }, { angle: 45, x: 10 }]);
  });
});
