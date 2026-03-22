import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../helpers/phaser.mock.js';

installPhaserGlobal();

const {
  ShieldController,
  resolveShieldDamage,
} = await import('../../systems/ShieldController.js');

describe('resolveShieldDamage', () => {
  it('absorbs damage into the shield before any overflow remains', () => {
    assert.deepEqual(resolveShieldDamage(30, 12), {
      absorbed: 12,
      overflow: 0,
      remaining: 18,
    });
  });

  it('returns overflow once the shield pool is exhausted', () => {
    assert.deepEqual(resolveShieldDamage(15, 20), {
      absorbed: 15,
      overflow: 5,
      remaining: 0,
    });
  });
});

describe('ShieldController', () => {
  let scene;
  let target;
  let breaks;
  let damageNumbers;
  let changes;
  let controller;

  beforeEach(() => {
    scene = createMockScene();
    target = scene.add.rectangle(120, 200, 20, 20, 0xffffff);
    breaks = [];
    damageNumbers = [];
    changes = [];
    scene._effects = {
      explodeShield: (x, y, radius) => breaks.push({ x, y, radius }),
      showDamageNumber: (x, y, amount, opts) => damageNumbers.push({ x, y, amount, opts }),
    };

    controller = new ShieldController(scene, target, {
      effects: scene._effects,
      points: 40,
      radius: 18,
      onChange: (payload) => changes.push(payload),
    });
  });

  it('tracks remaining shield points after absorbed damage', () => {
    const result = controller.takeDamage(12);

    assert.equal(result.absorbed, 12);
    assert.equal(result.overflow, 0);
    assert.equal(controller.points, 28);
    assert.equal(breaks.length, 0);
    assert.deepEqual(damageNumbers, [{
      x: 120,
      y: 191.9,
      amount: 12,
      opts: { color: '#bfe8ff' },
    }]);
  });

  it('bursts once the shield depletes and returns overflow damage', () => {
    const result = controller.takeDamage(50);

    assert.equal(result.absorbed, 40);
    assert.equal(result.overflow, 10);
    assert.equal(result.depleted, true);
    assert.equal(controller.points, 0);
    assert.deepEqual(breaks, [{ x: 120, y: 200, radius: 18 }]);
  });

  it('can be refilled after breaking', () => {
    controller.takeDamage(80);
    controller.addPoints(25);

    assert.equal(controller.points, 25);
    assert.equal(controller.maxPoints, 400);
    assert.ok(changes.at(-1).active, 'refilled shield should become active again');
  });

  it('draws a compact top-rear shield bar that stays smaller than the host object and follows it', () => {
    controller.sync();

    assert.ok(controller._barBg.displayWidth <= target.displayWidth);
    assert.ok(controller._barFill.displayWidth <= controller._barBg.displayWidth);
    assert.equal(controller._barFill.x, controller._barBg.x + 1);

    target.x = 156;
    target.y = 228;
    controller.sync();

    assert.equal(controller._barFill.x, controller._barBg.x + 1);
    assert.ok(controller._barBg.y < 228, 'shield bar should sit above the target');
  });

  it('can place the shield bar on the bottom-rear side for the player', () => {
    const playerController = new ShieldController(scene, target, {
      effects: scene._effects,
      points: 40,
      radius: 18,
      barPlacement: 'bottom',
    });

    playerController.sync();

    assert.ok(playerController._barBg.y > target.y, 'player shield bar should sit below the target');
    assert.equal(playerController.maxPoints, 400);
  });
});
