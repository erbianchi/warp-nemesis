import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene, createMockEnemyOptions } from '../../helpers/phaser.mock.js';

installPhaserGlobal();

const { Mine } = await import('../../../entities/enemies/Mine.js');
const { ENEMIES } = await import('../../../config/enemies.config.js');
const { resolveStats } = await import('../../../systems/WaveSpawner.js');

const BASE_STATS = resolveStats('mine', 1.0, 1.0, {});

function makeMine(statsOverride = {}, dance = 'creep_drop') {
  const scene = createMockScene();
  let gravityWellUpdateCount = 0;
  let gravityWellDestroyCount = 0;
  let gravityArgs = null;

  scene._player = { x: 220, y: 520, active: true };
  scene._effects = {
    createGravityWell: (source, target, opts) => {
      gravityArgs = { source, target, opts };
      return {
        update: () => { gravityWellUpdateCount += 1; },
        destroy: () => { gravityWellDestroyCount += 1; },
      };
    },
  };

  const stats = { ...BASE_STATS, ...statsOverride };
  const mine = new Mine(scene, 180, -40, stats, dance, createMockEnemyOptions(scene));

  return {
    mine,
    scene,
    gravityArgs,
    getGravityWellUpdateCount: () => gravityWellUpdateCount,
    getGravityWellDestroyCount: () => gravityWellDestroyCount,
  };
}

describe('Mine', () => {
  describe('config', () => {
    it('has a mine entry in ENEMIES', () => {
      assert.ok('mine' in ENEMIES);
    });

    it('base contact damage is 200', () => {
      assert.equal(ENEMIES.mine.contactDamage, 200);
    });

    it('base hp is 500', () => {
      assert.equal(ENEMIES.mine.hp, 500);
    });

    it('has no ranged fire by default', () => {
      assert.equal(ENEMIES.mine.damage, 0);
      assert.equal(ENEMIES.mine.fireRate, 0);
      assert.equal(ENEMIES.mine.bulletSpeed, 0);
    });

    it('moves more slowly than a skirm', () => {
      assert.ok(ENEMIES.mine.speed < ENEMIES.skirm.speed);
    });
  });

  describe('construction', () => {
    it('starts with its resolved hp, zero shield points, and the mine display size', () => {
      const { mine } = makeMine();

      assert.equal(mine.hp, BASE_STATS.hp);
      assert.equal(mine.maxHp, BASE_STATS.hp);
      assert.equal(mine.shield, 0);
      assert.equal(mine.maxShield, 400);
      assert.equal(mine.contactDamage, BASE_STATS.contactDamage);
      assert.equal(mine.displayWidth, 28);
      assert.equal(mine.displayHeight, 28);
    });

    it('uses creep_drop as the default dance', () => {
      const scene = createMockScene();
      scene._player = { x: 220, y: 520, active: true };
      scene._effects = {
        createGravityWell: () => ({ update: () => {}, destroy: () => {} }),
      };

      const mine = new Mine(scene, 180, -40, BASE_STATS, 'creep_drop', createMockEnemyOptions(scene));

      assert.equal(mine.dance, 'creep_drop');
    });

    it('creates a gravity well tied to the mine and the player', () => {
      const { mine, scene, gravityArgs } = makeMine();

      assert.equal(gravityArgs.source, mine);
      assert.equal(gravityArgs.target, scene._player);
      assert.equal(gravityArgs.opts.power, 14);
      assert.equal(gravityArgs.opts.gravity, 360);
      assert.equal(gravityArgs.opts.pullRadius, 300);
      assert.equal(gravityArgs.opts.pullStrength, 3600);
    });
  });

  describe('movement', () => {
    it('creeps downward and updates its gravity field every frame', () => {
      const { mine, getGravityWellUpdateCount } = makeMine();
      const startX = mine.x;
      const startY = mine.y;

      mine.update(1000);

      assert.ok(mine.y > startY, 'mine should drift downward');
      assert.ok(Math.abs(mine.x - startX) < 30, 'mine should only creep gently side to side');
      assert.equal(getGravityWellUpdateCount(), 1);
    });
  });

  describe('lifecycle', () => {
    it('destroys the gravity field when the mine dies', () => {
      const { mine, getGravityWellDestroyCount } = makeMine();

      mine.die();

      assert.equal(mine.alive, false);
      assert.equal(getGravityWellDestroyCount(), 1);
    });

    it('destroys the gravity field when the mine is directly destroyed', () => {
      const { mine, getGravityWellDestroyCount } = makeMine();

      mine.destroy();

      assert.equal(mine.alive, false);
      assert.equal(getGravityWellDestroyCount(), 1);
    });
  });
});
