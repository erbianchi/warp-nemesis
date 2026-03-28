import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../helpers/phaser.mock.js';

installPhaserGlobal();

// Extend mock to support the physics group pool pattern WeaponManager uses
const { GAME_CONFIG } = await import('../../config/game.config.js');
const { WEAPONS } = await import('../../config/weapons.config.js');

const LASER = WEAPONS.laser;
const assertClose = (actual, expected, epsilon = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
};
// ---------------------------------------------------------------------------
// Minimal pool mock — mirrors the Phaser arcade physics group API
// ---------------------------------------------------------------------------
function createMockPool(maxSize = 80) {
  const children = [];
  return {
    _children: children,
    getChildren: () => children,
    killAndHide: (b) => { b.active = false; b.visible = false; },
    get: (x, y) => {
      // Reuse first inactive child
      const reuse = children.find(b => !b.active);
      if (reuse) {
        reuse.active = true; reuse.visible = true;
        reuse.x = x; reuse.y = y;
        return reuse;
      }
      if (children.length >= maxSize) return null;
      const b = {
        active: true, visible: true, x, y, texture: 'bullet_laser', rotation: 0,
        setActive:  (v) => { b.active  = v; return b; },
        setVisible: (v) => { b.visible = v; return b; },
        setTexture: (v) => { b.texture = v; return b; },
        setRotation: (v) => { b.rotation = v; return b; },
        setScale:   (sx, sy = sx) => { b.scaleX = sx; b.scaleY = sy; return b; },
        body: {
          _vx: 0, _vy: 0, enable: true,
          reset:         (x, y) => { b.x = x; b.y = y; },
          setVelocityY:  (v)    => { b.body._vy = v; },
          stop:          ()     => { b.body._vx = 0; b.body._vy = 0; },
          updateFromGameObject: () => {},
          allowGravity:  false,
        },
      };
      children.push(b);
      return b;
    },
  };
}

// Patch createMockScene to inject our controllable pool
function createSceneWithPool(pool) {
  const scene = createMockScene();
  scene.physics.add.group = () => pool;
  return scene;
}

// ---------------------------------------------------------------------------

describe('WeaponManager', () => {
  let pool;
  let manager;
  let scene;

  beforeEach(async () => {
    // Re-import fresh each time via cache-busting is not needed;
    // WeaponManager is stateless at module level
    const { WeaponManager } = await import('../../weapons/WeaponManager.js');
    pool    = createMockPool(LASER.poolSize);
    scene = createSceneWithPool(pool);
    scene.soundCalls = [];
    scene.soundConfigs = [];
    scene.soundStopCalls = [];
    scene.soundAddCalls = [];
    scene.sound = {
      play: (key, config = {}) => {
        scene.soundCalls.push(key);
        scene.soundConfigs.push({ key, config });
        return { isPlaying: true, stop: () => { scene.soundStopCalls.push(key); } };
      },
      add: (key, config = {}) => {
        scene.soundAddCalls.push({ key, config });
        return {
          play: () => {
            scene.soundCalls.push(key);
            scene.soundConfigs.push({ key, config });
          },
          stop: () => {
            scene.soundStopCalls.push(key);
          },
        };
      },
      stopByKey: (key) => {
        scene.soundStopCalls.push(key);
      },
    };
    manager = new WeaponManager(scene);
  });

  // --- Construction ---

  it('exposes pool via .pool getter', () => {
    assert.ok(manager.pool !== undefined);
  });

  it('exposes damage via .damage getter', () => {
    assert.equal(manager.damage, LASER.damage);
  });

  it('starts with zero heat and not overheated', () => {
    assert.equal(manager.heatShots, 0);
    assert.equal(manager.isOverheated, false);
  });

  it('starts with zero cooldown (can fire immediately)', () => {
    assert.equal(manager._cooldown, 0);
  });

  it('resetHeat clears heat and the overheat lock', () => {
    manager._heatShots = manager.maxHeatShots;
    manager._isOverheated = true;
    manager._lastShotInfo = { warningShot: true };

    manager.resetHeat();

    assert.equal(manager.heatShots, 0);
    assert.equal(manager.isOverheated, false);
    assert.equal(manager.lastShotInfo, null);
  });

  it('can temporarily speed up heat recovery to 50 ms per shot and restore the default later', () => {
    manager._heatShots = 8;

    manager.setHeatRecoveryStepMs(50);
    manager.update(50, false);

    assert.equal(manager.heatRecoveryStepMs, 50);
    assert.equal(manager.heatShots, 7);

    manager.resetHeatRecoveryStepMs();
    manager.update(GAME_CONFIG.PLAYER_HEAT_RECOVERY_MS, false);

    assert.equal(manager.heatRecoveryStepMs, GAME_CONFIG.PLAYER_HEAT_RECOVERY_MS);
    assert.equal(manager.heatShots, 6);
  });

  it('does not play laserCooling during a normal per-shot cooldown', () => {
    manager.tryFire(240, 500);
    scene.soundCalls = ['laserSmall_000'];
    scene.soundConfigs = scene.soundConfigs.slice(0, 1);

    manager.update(LASER.fireRate - 1, false);

    assert.deepEqual(scene.soundCalls, ['laserSmall_000']);
    assert.equal(scene.soundAddCalls.length, 0);

    manager.update(1, false);
    assert.deepEqual(scene.soundStopCalls, []);
  });

  it('plays laserCooling only while overheated and stops it when the overheat lock clears', () => {
    manager._heatShots = manager.maxHeatShots;
    manager._isOverheated = true;
    scene.soundCalls = [];
    scene.soundStopCalls = [];

    manager.update(manager._heatRecoveryStepMs * 19, false);

    assert.deepEqual(scene.soundCalls, ['laserCooling']);
    assert.deepEqual(scene.soundStopCalls, []);

    manager.update(manager._heatRecoveryStepMs, false);

    assert.deepEqual(scene.soundStopCalls, ['laserCooling']);
  });

  it('does not start laserCooling during repeated normal shots once regular cooldown ends', () => {
    manager.tryFire(240, 500);
    manager.update(LASER.fireRate, false);

    scene.soundCalls = [];
    scene.soundConfigs = [];
    scene.soundStopCalls = [];
    manager.tryFire(240, 500);

    assert.deepEqual(scene.soundCalls, ['laserSmall_000']);
    assert.deepEqual(scene.soundStopCalls, []);
  });

  it('stacks slot-1 laser power bonuses and exposes the multiplier in the HUD snapshot', () => {
    assert.equal(manager.primaryDamageMultiplier, 1);

    manager.multiplyPrimaryDamage(2);
    manager.multiplyPrimaryDamage(2);

    assert.equal(manager.primaryDamageMultiplier, 4);
    assert.equal(manager.damage, LASER.damage * 4);
    assert.equal(manager.getSlots()[0].multiplierLabel, 'x4');

    manager.resetPrimaryDamageMultiplier();

    assert.equal(manager.primaryDamageMultiplier, 1);
    assert.equal(manager.getSlots()[0].multiplierLabel, '');
  });

  it('resetPrimaryWeapon restores the base laser and clears live bullets', () => {
    manager.equipPrimaryWeapon('tLaser');
    manager.tryFire(240, 500);

    manager.resetPrimaryWeapon();

    assert.equal(manager._slots[0], 'laser');
    assert.equal(manager.getSlots()[0].name, 'LASER');
    assert.ok(pool._children.every(bullet => bullet.active === false));
    assert.ok(pool._children.every(bullet => bullet.rotation === 0));
  });

  it('restores a persisted between-level weapon state', () => {
    manager.applyPersistentState({
      slots: ['tLaser', null],
      cooldown: 180,
      heatShots: 7,
      isOverheated: true,
      heatRecoveryStepMs: 50,
      primaryDamageMultiplier: 4,
    });

    assert.equal(manager.primaryWeaponKey, 'tLaser');
    assert.equal(manager._cooldown, 180);
    assert.equal(manager.heatShots, 7);
    assert.equal(manager.isOverheated, true);
    assert.equal(manager.heatRecoveryStepMs, 50);
    assert.equal(manager.primaryDamageMultiplier, 4);
    assert.equal(manager.getSlots()[0].multiplierLabel, 'x4');
  });

  it('has exactly WEAPON_SLOTS slots', async () => {
    const { GAME_CONFIG } = await import('../../config/game.config.js');
    assert.equal(manager._slots.length, GAME_CONFIG.WEAPON_SLOTS);
  });

  it('slot 0 is loaded with laser', () => {
    assert.equal(manager._slots[0], 'laser');
  });

  it('slot 1 is empty (null)', () => {
    assert.equal(manager._slots[1], null);
  });

  it('can equip a different slot-1 laser and expose its HUD name', () => {
    manager.equipPrimaryWeapon('tLaser');

    assert.equal(manager._slots[0], 'tLaser');
    assert.equal(manager.getSlots()[0].name, 'T-LASER');
  });

  // --- getSlots ---

  it('getSlots returns an array of length WEAPON_SLOTS', async () => {
    const { GAME_CONFIG } = await import('../../config/game.config.js');
    assert.equal(manager.getSlots().length, GAME_CONFIG.WEAPON_SLOTS);
  });

  it('getSlots slot 0 has key, name, and color', () => {
    const slot = manager.getSlots()[0];
    assert.ok(slot !== null);
    assert.equal(slot.key, 'laser');
    assert.equal(slot.name, 'LASER');
    assert.ok(typeof slot.color === 'number', 'color should be a number');
  });

  it('getSlots slot 0 color matches weapons config', async () => {
    const { WEAPONS } = await import('../../config/weapons.config.js');
    const slot = manager.getSlots()[0];
    assert.equal(slot.color, WEAPONS.laser.color);
  });

  it('getSlots slot 1 is null', () => {
    assert.equal(manager.getSlots()[1], null);
  });

  it('getSlots returns a copy — mutations do not affect internal state', () => {
    const slots = manager.getSlots();
    slots[0] = null;
    assert.equal(manager._slots[0], 'laser');
  });

  // --- tryFire ---

  it('adds a bullet to the pool on first fire', () => {
    manager.tryFire(240, 500);
    assert.equal(pool._children.length, 1);
    assert.equal(pool._children[0].active, true);
  });

  it('positions bullet above the player origin', () => {
    manager.tryFire(240, 500);
    const b = pool._children[0];
    assert.ok(b.y < 500, `bullet y (${b.y}) should be above player y (500)`);
  });

  it('fires the normal laser from the centered ship muzzle', () => {
    manager.tryFire(240, 500);
    assert.equal(pool._children[0].x, 240);
  });

  it('bullet travels upward (negative Y velocity)', () => {
    manager.tryFire(240, 500);
    assert.ok(pool._children[0].body._vy < 0, 'bullet should have negative Y velocity');
  });

  it('bullet speed matches laser config', () => {
    manager.tryFire(240, 500);
    assert.equal(pool._children[0].body._vy, -LASER.speed);
  });

  it('normal laser shots keep the default thickness and base damage', () => {
    manager.tryFire(240, 500);
    const bullet = pool._children[0];
    assert.equal(bullet.texture, 'bullet_laser');
    assert.equal(bullet.scaleX, 1);
    assert.equal(bullet.scaleY, 1);
    assert.equal(bullet._damage, LASER.damage);
    assert.equal(bullet._scoreMultiplier, 1);
    assert.equal(bullet._shotPayload.damage, LASER.damage);
  });

  it('sets cooldown after firing', () => {
    manager.tryFire(240, 500);
    assert.ok(manager._cooldown > 0, 'cooldown should be set after firing');
    assert.equal(manager._cooldown, LASER.fireRate);
  });

  it('adds 1 heat shot per successful laser shot', () => {
    manager.tryFire(240, 500);
    assert.equal(manager.heatShots, 1);
  });

  it('plays the default laser sound on a successful laser shot', () => {
    manager.tryFire(240, 500);
    assert.deepEqual(scene.soundCalls, ['laserSmall_000']);
  });

  it('switches to the overheat warning sound once laser heat is in the yellow zone', () => {
    manager._heatShots = manager.maxHeatShots * 0.7;
    manager.tryFire(240, 500);
    assert.deepEqual(scene.soundCalls, ['laserOverheat_000']);
  });

  it('the first yellow-bar shot fires ONE bullet centered on the ship with a 10 percent bonus', () => {
    manager._heatShots = manager.maxHeatShots * 0.7 - 1;
    manager.tryFire(240, 500);
    assert.equal(pool._children.length, 1);

    const bullet = pool._children[0];
    assert.equal(bullet.x, 240);
    assert.equal(bullet.texture, 'bullet_laser_warning');
    assert.equal(bullet._damage, 11);
    assert.equal(bullet._scoreMultiplier, 1.1);
    assert.equal(bullet.scaleX, 1);
    assert.equal(manager.lastShotInfo.warningShot, true);
    assert.equal(manager.lastShotInfo.shotShakeMs, 24);
    assertClose(manager.lastShotInfo.shotShakeIntensity, 0.0018);
  });

  it('fractional cooling near the threshold still keeps the next yellow shot at 10 percent', () => {
    manager._heatShots = manager.maxHeatShots * 0.7 - 0.1;
    manager.tryFire(240, 500);

    assert.equal(pool._children.length, 1);
    assert.equal(pool._children[0]._damage, 11);
    assert.equal(pool._children[0]._scoreMultiplier, 1.1);
  });

  it('warning-zone shots keep ramping by 10 percent per extra yellow-bar shot', () => {
    manager._heatShots = manager.maxHeatShots * 0.7;
    manager.tryFire(240, 500);
    assert.equal(pool._children.length, 1);

    const bullet = pool._children[0];
    assert.equal(bullet.x, 240);
    assert.equal(bullet.texture, 'bullet_laser_warning');
    assert.equal(bullet.scaleX, 1);
    assert.equal(bullet._damage, 12);
    assert.equal(bullet._scoreMultiplier, 1.2);
    assert.equal(manager.lastShotInfo.shotShakeMs, 26);
    assertClose(manager.lastShotInfo.shotShakeIntensity, 0.002);
  });

  it('the final pre-overheat shot carries the full stacked yellow-bar bonus', () => {
    manager._heatShots = manager.maxHeatShots - 1;
    manager.tryFire(240, 500);
    assert.equal(pool._children.length, 1);

    const bullet = pool._children[0];
    assert.equal(bullet.x, 240);
    assert.equal(bullet.texture, 'bullet_laser_warning');
    assert.equal(bullet._damage, 20);
    assert.equal(bullet._scoreMultiplier, 2);
    assert.equal(bullet.scaleX, 1);
    assert.equal(manager.lastShotInfo.shotShakeMs, 42);
    assertClose(manager.lastShotInfo.shotShakeIntensity, 0.0036);
    assert.equal(manager.isOverheated, true);
  });

  it('does not fire again while cooldown is active', () => {
    manager.tryFire(240, 500);
    manager.tryFire(240, 500); // should be blocked by cooldown
    assert.equal(pool._children.length, 1);
  });

  it('does not replay the laser sound when firing is blocked by cooldown', () => {
    manager.tryFire(240, 500);
    manager.tryFire(240, 500);
    assert.deepEqual(scene.soundCalls, ['laserSmall_000']);
  });

  it('fires again once cooldown expires', () => {
    manager.tryFire(240, 500);
    manager.update(LASER.fireRate); // advance past cooldown
    manager.tryFire(240, 500);
    assert.equal(pool._children.filter(b => b.active).length, 2);
  });

  it('fires the T-Laser forward plus both 90-degree side shots', () => {
    manager.equipPrimaryWeapon('tLaser');

    manager.tryFire(240, 500);

    assert.equal(pool._children.length, 3);
    const velocities = pool._children
      .map(bullet => [bullet.body._vx, bullet.body._vy])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    assertClose(velocities[0][0], -700);
    assertClose(velocities[0][1], 0);
    assertClose(velocities[1][0], 0);
    assertClose(velocities[1][1], -700);
    assertClose(velocities[2][0], 700);
    assertClose(velocities[2][1], 0);
  });

  it('renders the T-Laser side beams horizontally', () => {
    manager.equipPrimaryWeapon('tLaser');

    manager.tryFire(240, 500);

    const leftBeam = pool._children.find(bullet => bullet.body._vx < 0);
    const centerBeam = pool._children.find(bullet => bullet.body._vx === 0);
    const rightBeam = pool._children.find(bullet => bullet.body._vx > 0);

    assertClose(leftBeam.rotation, -Math.PI / 2);
    assertClose(centerBeam.rotation, 0);
    assertClose(rightBeam.rotation, Math.PI / 2);
  });

  it('fires the Y-Laser forward plus both 45-degree side shots', () => {
    manager.equipPrimaryWeapon('yLaser');

    manager.tryFire(240, 500);

    assert.equal(pool._children.length, 3);
    const sideSpeed = Math.sin(Math.PI / 4) * 700;
    const velocities = pool._children
      .map(bullet => [bullet.body._vx, bullet.body._vy])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    assertClose(velocities[0][0], -sideSpeed);
    assertClose(velocities[0][1], -sideSpeed);
    assertClose(velocities[1][0], 0);
    assertClose(velocities[1][1], -700);
    assertClose(velocities[2][0], sideSpeed);
    assertClose(velocities[2][1], -sideSpeed);
  });

  // --- update: cooldown ---

  it('update reduces cooldown by delta', () => {
    manager.tryFire(240, 500);
    const before = manager._cooldown;
    manager.update(50);
    assert.equal(manager._cooldown, before - 50);
  });

  it('cooldown does not go below zero', () => {
    manager.tryFire(240, 500);
    manager.update(LASER.fireRate * 10);
    assert.equal(manager._cooldown, 0);
  });

  it('recovers 1 full heat shot over 100 ms when not firing', () => {
    manager.tryFire(240, 500);
    manager.update(100, false);
    assert.equal(manager.heatShots, 0);
  });

  it('recovers heat smoothly before 100 ms has elapsed', () => {
    manager.tryFire(240, 500);
    manager.update(50, false);
    assert.equal(manager.heatShots, 0.5);

    manager.update(25, false);
    assert.equal(manager.heatShots, 0.25);
  });

  it('does not recover heat while the trigger is held and the weapon is not overheated', () => {
    manager.tryFire(240, 500);
    manager.update(500, true);
    assert.equal(manager.heatShots, 1);
  });

  it('overheats on the 30th shot and blocks further firing', () => {
    for (let i = 0; i < manager.maxHeatShots; i++) {
      manager.tryFire(240, 500);
      if (i < manager.maxHeatShots - 1) manager.update(LASER.fireRate, true);
    }

    assert.equal(manager.heatShots, manager.maxHeatShots);
    assert.equal(manager.isOverheated, true);

    manager.update(LASER.fireRate, true);
    const beforeCount = pool._children.length;
    assert.equal(manager.tryFire(240, 500), false);
    assert.equal(pool._children.length, beforeCount);
  });

  it('unlocks again after cooling 20 shots from full overheat', () => {
    for (let i = 0; i < manager.maxHeatShots; i++) {
      manager.tryFire(240, 500);
      if (i < manager.maxHeatShots - 1) manager.update(LASER.fireRate, true);
    }

    manager.update(manager._heatRecoveryStepMs * 19, false);
    assert.equal(manager.isOverheated, true);
    assert.equal(manager.heatShots, 11);

    manager.update(manager._heatRecoveryStepMs, false);
    assert.equal(manager.heatShots, manager.unlockHeatShots);
    assert.equal(manager.isOverheated, false);
  });

  it('can fire again immediately once the overheat lock clears', () => {
    for (let i = 0; i < manager.maxHeatShots; i++) {
      manager.tryFire(240, 500);
      if (i < manager.maxHeatShots - 1) manager.update(LASER.fireRate, true);
    }

    manager.update(manager._heatRecoveryStepMs * manager._overheatRecoveryShots, false);
    const beforeCount = pool._children.length;
    assert.equal(manager.tryFire(240, 500), true);
    assert.equal(pool._children.length, beforeCount + 1);
  });

  // --- update: bullet recycling ---

  it('recycles bullets that travel off the top of the screen (y < -20)', () => {
    manager.tryFire(240, 500);
    const b = pool._children[0];
    b.y = -25; // simulate bullet leaving canvas
    manager.update(0);
    assert.equal(b.active, false);
  });

  it('recycles sideways T-Laser bullets after they leave the playfield', () => {
    manager.equipPrimaryWeapon('tLaser');
    manager.tryFire(240, 500);
    const sideBullet = pool._children.find(bullet => bullet.body._vx > 0);
    sideBullet.x = 9999;

    manager.update(0);

    assert.equal(sideBullet.active, false);
    assert.equal(sideBullet.body.enable, false);
  });

  it('does not recycle bullets still on screen', () => {
    manager.tryFire(240, 500);
    const b = pool._children[0];
    b.y = 300; // mid-screen
    manager.update(0);
    assert.equal(b.active, true);
  });

  it('reuses recycled bullets instead of creating new ones', () => {
    manager.tryFire(240, 500);
    const b = pool._children[0];
    b.y = -25;
    manager.update(LASER.fireRate); // recycle + expire cooldown
    manager.tryFire(240, 500);
    // Pool should still have only 1 child (reused)
    assert.equal(pool._children.length, 1);
    assert.equal(pool._children[0].active, true);
  });

  // --- body.enable: the ghost-bullet bug fix ---

  it('off-screen recycle disables the physics body', () => {
    manager.tryFire(240, 500);
    const b = pool._children[0];
    b.y = -25;
    manager.update(0);
    assert.equal(b.body.enable, false, 'recycled bullet body must be disabled');
  });

  it('tryFire re-enables the physics body when reusing a recycled bullet', () => {
    manager.tryFire(240, 500);
    const b = pool._children[0];
    // Simulate hit-kill path: body disabled externally (as GameScene does)
    b.active = false; b.visible = false; b.body.enable = false;
    manager.update(LASER.fireRate); // expire cooldown
    manager.tryFire(240, 500);
    assert.equal(b.body.enable, true, 'reused bullet body must be re-enabled');
  });

  it('tryFire gives the reused bullet an upward velocity after re-enable', () => {
    manager.tryFire(240, 500);
    const b = pool._children[0];
    b.active = false; b.visible = false; b.body.enable = false; b.body._vy = 0;
    manager.update(LASER.fireRate);
    manager.tryFire(240, 500);
    assert.ok(b.body._vy < 0, 'reused bullet must travel upward');
  });
});
