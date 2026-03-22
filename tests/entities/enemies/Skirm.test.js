import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../../helpers/phaser.mock.js';

installPhaserGlobal();

import { Skirm } from '../../../entities/enemies/Skirm.js';
import { ENEMIES } from '../../../config/enemies.config.js';
import { resolveStats } from '../../../systems/WaveSpawner.js';
import { EVENTS } from '../../../config/events.config.js';

const BASE_STATS = resolveStats('skirm', 1.0, 1.0, {});

function makeSkirm(dance = 'straight', statsOverride = {}) {
  const scene = createMockScene();
  const stats = { ...BASE_STATS, ...statsOverride };
  return { skirm: new Skirm(scene, 100, -40, stats, dance), scene };
}

describe('Skirm', () => {
  describe('config', () => {
    it('has a skirm entry in ENEMIES', () => {
      assert.ok('skirm' in ENEMIES);
    });

    it('base hp is 10', () => {
      assert.equal(ENEMIES.skirm.hp, 10);
    });

    it('base damage is 10', () => {
      assert.equal(ENEMIES.skirm.damage, 10);
    });

    it('speed is slow (≤ 100 px/s)', () => {
      assert.ok(ENEMIES.skirm.speed <= 100);
    });
  });

  describe('construction', () => {
    it('initialises hp and maxHp from stats', () => {
      const { skirm } = makeSkirm();
      assert.equal(skirm.hp,    BASE_STATS.hp);
      assert.equal(skirm.maxHp, BASE_STATS.hp);
    });

    it('stores the assigned dance', () => {
      const { skirm } = makeSkirm('zigzag');
      assert.equal(skirm.dance, 'zigzag');
    });

    it('defaults dance to straight when omitted', () => {
      const scene = createMockScene();
      const skirm = new Skirm(scene, 0, 0, BASE_STATS);
      assert.equal(skirm.dance, 'straight');
    });

    it('starts alive', () => {
      const { skirm } = makeSkirm();
      assert.equal(skirm.alive, true);
    });
  });

  describe('stats at base difficulty', () => {
    it('Level 1 Wave 1 → hp=10, damage=10', () => {
      const s = resolveStats('skirm', 1.0, 1.0, {});
      assert.equal(s.hp,     10);
      assert.equal(s.damage, 10);
    });

    it('+20% damage modifier → damage=12', () => {
      assert.equal(resolveStats('skirm', 1.0, 1.0, { damageModifier: 1.2 }).damage, 12);
    });

    it('-20% damage modifier → damage=8', () => {
      assert.equal(resolveStats('skirm', 1.0, 1.0, { damageModifier: 0.8 }).damage, 8);
    });

    it('higher difficulty scales hp and damage but not speed', () => {
      const s = resolveStats('skirm', 2.0, 1.5, {});
      assert.equal(s.hp,     Math.round(10 * 2.0 * 1.5));
      assert.equal(s.damage, Math.round(10 * 2.0 * 1.5));
      assert.equal(s.speed,  ENEMIES.skirm.speed);
    });
  });

  describe('movement dances', () => {
    // setVelocity/setVelocityX/setVelocityY are tracked by reading the mock body calls
    // We verify setupMovement runs without throwing for each dance.
    const DANCES = ['straight', 'sweep_left', 'sweep_right', 'side_cross', 'fan_out', 'zigzag'];

    for (const dance of DANCES) {
      it(`constructs without error for dance "${dance}"`, () => {
        assert.doesNotThrow(() => makeSkirm(dance));
      });
    }

    it('unknown dance falls back to straight without throwing', () => {
      assert.doesNotThrow(() => makeSkirm('unknown_future_dance'));
    });

    it('zigzag: update() runs without error', () => {
      const { skirm } = makeSkirm('zigzag');
      assert.doesNotThrow(() => skirm.update(16));
      assert.doesNotThrow(() => skirm.update(32));
    });
  });

  describe('combat', () => {
    it('takeDamage reduces hp', () => {
      const { skirm } = makeSkirm();
      skirm.takeDamage(5);
      assert.equal(skirm.hp, BASE_STATS.hp - 5);
    });

    it('lethal damage kills the skirm', () => {
      const { skirm } = makeSkirm();
      skirm.takeDamage(BASE_STATS.hp);
      assert.equal(skirm.alive, false);
    });

    it('hp does not go below 0', () => {
      const { skirm } = makeSkirm();
      skirm.takeDamage(BASE_STATS.hp * 10);
      assert.equal(skirm.hp, 0);
    });

    it('dead skirm ignores further damage', () => {
      const { skirm } = makeSkirm();
      skirm.takeDamage(BASE_STATS.hp);
      skirm.takeDamage(5);
      assert.equal(skirm.hp, 0);
    });
  });

  describe('fire()', () => {
    it('emits ENEMY_FIRE with correct damage and downward velocity', () => {
      const { skirm, scene } = makeSkirm();
      const fired = [];
      scene.events.emit = (event, data) => { if (event === EVENTS.ENEMY_FIRE) fired.push(data); };
      skirm.fire();
      assert.equal(fired.length, 1);
      assert.equal(fired[0].damage, BASE_STATS.damage);
      assert.ok(fired[0].vy > 0);
      assert.equal(fired[0].vx, 0);
    });
  });

  describe('death', () => {
    it('die() emits ENEMY_DIED with score', () => {
      const { skirm, scene } = makeSkirm();
      const events = [];
      scene.events.emit = (e, d) => events.push({ event: e, data: d });
      skirm.die();
      const died = events.find(e => e.event === EVENTS.ENEMY_DIED);
      assert.ok(died);
      assert.equal(died.data.score, BASE_STATS.score);
      assert.equal(died.data.scoreMultiplier, 1);
    });

    it('lethal weapon hits carry their score multiplier into ENEMY_DIED', () => {
      const { skirm, scene } = makeSkirm();
      const events = [];
      scene.events.emit = (e, d) => events.push({ event: e, data: d });
      skirm.takeDamage(BASE_STATS.hp, 1.4);
      const died = events.find(e => e.event === EVENTS.ENEMY_DIED);
      assert.ok(died);
      assert.equal(died.data.scoreMultiplier, 1.4);
    });
  });
});
