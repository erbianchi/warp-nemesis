import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../helpers/phaser.mock.js';

installPhaserGlobal();

// Extend mock to support the physics group pool pattern WeaponManager uses
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
        active: true, visible: true, x, y, texture: 'bullet_laser',
        setActive:  (v) => { b.active  = v; return b; },
        setVisible: (v) => { b.visible = v; return b; },
        setTexture: (v) => { b.texture = v; return b; },
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
    scene.sound = {
      play: (key) => {
        scene.soundCalls.push(key);
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
