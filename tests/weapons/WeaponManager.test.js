import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../helpers/phaser.mock.js';

installPhaserGlobal();

// Extend mock to support the physics group pool pattern WeaponManager uses
const { WEAPONS } = await import('../../config/weapons.config.js');

const LASER = WEAPONS.laser;

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
        active: true, visible: true, x, y,
        setActive:  (v) => { b.active  = v; return b; },
        setVisible: (v) => { b.visible = v; return b; },
        body: {
          _vx: 0, _vy: 0,
          reset:         (x, y) => { b.x = x; b.y = y; },
          setVelocityY:  (v)    => { b.body._vy = v; },
          stop:          ()     => { b.body._vx = 0; b.body._vy = 0; },
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

  beforeEach(async () => {
    // Re-import fresh each time via cache-busting is not needed;
    // WeaponManager is stateless at module level
    const { WeaponManager } = await import('../../weapons/WeaponManager.js');
    pool    = createMockPool(LASER.poolSize);
    const scene = createSceneWithPool(pool);
    manager = new WeaponManager(scene);
  });

  // --- Construction ---

  it('exposes pool via .pool getter', () => {
    assert.ok(manager.pool !== undefined);
  });

  it('starts with zero cooldown (can fire immediately)', () => {
    assert.equal(manager._cooldown, 0);
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

  it('bullet travels upward (negative Y velocity)', () => {
    manager.tryFire(240, 500);
    assert.ok(pool._children[0].body._vy < 0, 'bullet should have negative Y velocity');
  });

  it('bullet speed matches laser config', () => {
    manager.tryFire(240, 500);
    assert.equal(pool._children[0].body._vy, -LASER.speed);
  });

  it('sets cooldown after firing', () => {
    manager.tryFire(240, 500);
    assert.ok(manager._cooldown > 0, 'cooldown should be set after firing');
    assert.equal(manager._cooldown, LASER.fireRate);
  });

  it('does not fire again while cooldown is active', () => {
    manager.tryFire(240, 500);
    manager.tryFire(240, 500); // should be blocked by cooldown
    assert.equal(pool._children.length, 1);
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
});
