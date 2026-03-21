import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../helpers/phaser.mock.js';

installPhaserGlobal();

import { EnemyBase } from '../../entities/EnemyBase.js';

const TEST_STATS = {
  hp:          10,
  damage:      5,
  speed:       0,
  fireRate:    0,
  score:       25,
  dropChance:  0,
  bulletSpeed: 0,
};

class TestEnemy extends EnemyBase {
  constructor(scene, x = 100, y = 100, stats = TEST_STATS) {
    super(scene, x, y, 'test_enemy', stats, 'straight');
  }

  setupMovement() {
    this.body.setVelocity(0, 0);
  }

  setupWeapon() {}

  fire() {}
}

describe('EnemyBase', () => {
  let scene;
  let enemy;

  beforeEach(() => {
    scene = createMockScene();
    enemy = new TestEnemy(scene);
  });

  it('keeps shockwave displacement bounded during a 200 ms hitch', () => {
    enemy.applyPush(280, 0);

    enemy.update(200);

    assert.ok(Number.isFinite(enemy.x), 'enemy x should remain finite');
    assert.ok(Number.isFinite(enemy._pushOffX), 'push offset should remain finite');
    assert.ok(Math.abs(enemy.x - 100) < 50, `expected bounded x displacement, got ${enemy.x}`);
    assert.ok(Math.abs(enemy._pushOffX) < 50, `expected bounded push offset, got ${enemy._pushOffX}`);
  });

  it('syncs the Arcade body after push displacement', () => {
    let syncCalls = 0;
    enemy.body.updateFromGameObject = function() {
      syncCalls++;
      this.lastSync = { x: enemy.x, y: enemy.y };
    };

    enemy.applyPush(120, 60);
    enemy.update(16);

    assert.ok(syncCalls > 0, 'body should sync after manual displacement');
    assert.deepEqual(enemy.body.lastSync, { x: enemy.x, y: enemy.y });
  });
});
