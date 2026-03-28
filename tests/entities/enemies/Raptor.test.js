import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../../helpers/phaser.mock.js';

installPhaserGlobal();

const { Raptor } = await import('../../../entities/enemies/Raptor.js');
const { ENEMIES } = await import('../../../config/enemies.config.js');
const { resolveStats } = await import('../../../systems/WaveSpawner.js');
const { EVENTS } = await import('../../../config/events.config.js');

const BASE_STATS = resolveStats('raptor', 1.0, 1.0, {});

function makeRaptor(statsOverride = {}, dance = 'side_left') {
  const scene = createMockScene();
  const stats = { ...BASE_STATS, ...statsOverride };
  return { raptor: new Raptor(scene, 120, -60, stats, dance), scene };
}

describe('Raptor', () => {
  describe('config', () => {
    it('has a raptor entry in ENEMIES', () => {
      assert.ok('raptor' in ENEMIES);
    });

    it('base hp and shield are both 100', () => {
      assert.equal(ENEMIES.raptor.hp, 100);
      assert.equal(ENEMIES.raptor.shield, 100);
    });

    it('base damage is 25', () => {
      assert.equal(ENEMIES.raptor.damage, 25);
    });

    it('moves more slowly than a skirm', () => {
      assert.ok(ENEMIES.raptor.speed < ENEMIES.skirm.speed);
    });
  });

  describe('construction', () => {
    it('starts with the resolved hp, shield, and doubled display size', () => {
      const { raptor } = makeRaptor();

      assert.equal(raptor.hp, BASE_STATS.hp);
      assert.equal(raptor.maxHp, BASE_STATS.hp);
      assert.equal(raptor.shield, BASE_STATS.shield);
      assert.equal(raptor.maxShield, 400);
      assert.equal(raptor.displayWidth, 40);
      assert.equal(raptor.displayHeight, 32);
      assert.equal(raptor._persistUntilDestroyed, true);
    });

    it('uses the default side-left dance when none is provided', () => {
      const scene = createMockScene();
      const raptor = new Raptor(scene, 120, -60, BASE_STATS);

      assert.equal(raptor.dance, 'side_left');
    });

    it('enters from the left when using the side_left dance', () => {
      const scene = createMockScene();
      const raptor = new Raptor(scene, -40, 180, BASE_STATS, 'side_left');

      raptor.update(1000);

      assert.ok(raptor.x > -40);
    });

    it('enters from the right when using the side_right dance', () => {
      const scene = createMockScene();
      const raptor = new Raptor(scene, 520, 180, BASE_STATS, 'side_right');

      raptor.update(1000);

      assert.ok(raptor.x < 520);
    });

    it('keeps patrolling on screen instead of exiting once it has entered', () => {
      const scene = createMockScene();
      const raptor = new Raptor(scene, -40, 220, BASE_STATS, 'side_left');

      for (let i = 0; i < 80; i++) raptor.update(250);

      assert.ok(raptor.x >= 56 && raptor.x <= 424);
      assert.ok(raptor.y >= 96 && raptor.y <= 484);
      assert.equal(raptor.active, true);
    });

    it('unlocks adaptive behavior only after the entry pass completes', () => {
      const scene = createMockScene();
      const raptor = new Raptor(scene, -40, 220, {
        ...BASE_STATS,
        adaptive: {
          enabled: true,
          minSpeedScalar: 0.9,
          maxSpeedScalar: 1.1,
        },
      }, 'side_left');

      assert.equal(raptor.canUseAdaptiveBehavior(), false);

      for (let index = 0; index < 20; index += 1) {
        raptor.update(250);
      }

      assert.equal(raptor.canUseAdaptiveBehavior(), true);
    });
  });

  describe('fire()', () => {
    it('emits an 8-direction star burst of blue beams', () => {
      const { raptor, scene } = makeRaptor();
      const fired = [];
      scene.events.emit = (event, data) => {
        if (event === EVENTS.ENEMY_FIRE) fired.push(data);
      };

      raptor.fire();

      assert.equal(fired.length, 8);
      assert.ok(fired.every(shot => shot.damage === BASE_STATS.damage));
      assert.ok(fired.every(shot => shot.width === 7));
      assert.ok(fired.every(shot => shot.height === 22));
      assert.ok(fired.every(shot => shot.color === 0x4ab8ff));

      const vectors = fired
        .map(({ vx, vy }) => `${Math.round(vx)},${Math.round(vy)}`)
        .sort();
      const expected = [
        '-230,0',
        '-163,-163',
        '-163,163',
        '0,-230',
        '0,230',
        '163,-163',
        '163,163',
        '230,0',
      ].sort();

      assert.deepEqual(vectors, expected);
    });
  });
});
