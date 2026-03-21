import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../helpers/phaser.mock.js';

installPhaserGlobal();

const {
  EffectsSystem,
  composeFragmentVelocity,
  calcShockwavePush,
  resolveExplosionProfile,
} = await import('../../systems/EffectsSystem.js');

describe('EffectsSystem', () => {
  let scene;
  let effects;
  let completions;

  beforeEach(() => {
    scene = createMockScene();
    completions = [];
    scene.tweens.add = (cfg) => {
      if (cfg.onComplete) completions.push(cfg.onComplete);
      return cfg;
    };
    effects = new EffectsSystem(scene, { fragmentPoolSize: 4 });
  });

  it('prewarms the fragment pool once up front', () => {
    assert.equal(effects._fragmentPool.getChildren().length, 4);
    for (const frag of effects._fragmentPool.getChildren()) {
      assert.equal(frag.active, false);
      assert.equal(frag.body.enable, false);
    }
  });

  it('reuses pooled fragments across explosions', () => {
    effects.explodeForType(100, 100, 'skirm', 0, 0, [], []);
    assert.equal(effects._fragmentPool.getChildren().length, 4, 'pool should stop at max size');

    for (const complete of completions.splice(0)) complete();

    effects.explodeForType(120, 120, 'skirm', 0, 0, [], []);
    assert.equal(effects._fragmentPool.getChildren().length, 4, 'second explosion should reuse pool');
  });

  it('recycles fragments back to an inert state after their tween completes', () => {
    effects.explodeForType(100, 100, 'skirm', 0, 0, [], []);

    for (const complete of completions.splice(0)) complete();

    for (const frag of effects._fragmentPool.getChildren()) {
      assert.equal(frag.active, false);
      assert.equal(frag.visible, false);
      assert.equal(frag.body.enable, false);
      assert.equal(frag.body.gravityY, 0);
      assert.equal(frag.body.drag, 0);
    }
  });

  it('applies shockwave push to nearby enemies and bullets', () => {
    const pushes = [];
    const enemy = {
      alive: true,
      x:     112,
      y:     100,
      applyPush: (vx, vy) => pushes.push({ vx, vy }),
    };
    const bullet = { active: true, x: 88, y: 100 };

    effects.explodeForType(100, 100, 'skirm', 0, 0, [enemy], [bullet]);

    assert.equal(pushes.length, 1);
    assert.ok(pushes[0].vx > 0, 'enemy to the right should be pushed rightward');
    assert.ok(Math.abs(pushes[0].vy) < 0.001, 'enemy aligned horizontally should get ~0 vertical push');
    assert.ok(bullet._pushVx < 0, 'bullet to the left should be pushed leftward');
  });

  it('fragments inherit carrier momentum instead of only rotating the burst cone', () => {
    const fragment = composeFragmentVelocity(300, 0, Math.PI, 120);

    assert.ok(fragment.inheritRatio > 0.5, 'fast ships should contribute substantial carried velocity');
    assert.ok(fragment.vx > 0, 'even a backward fragment should still drift forward with the carrier inertia');
  });

  it('shockwave reaches farther and hits harder in front of a fast-moving craft', () => {
    const front = calcShockwavePush(100, 100, 180, 100, 300, 0);
    const rear  = calcShockwavePush(100, 100, 20, 100, 300, 0);

    assert.ok(front, 'front target should be inside the forward lobe');
    assert.ok(rear, 'rear target should still be inside the weaker rear lobe at this distance');
    assert.ok(front.effectiveRadius > rear.effectiveRadius, 'forward blast radius should be larger');
    assert.ok(front.vx > Math.abs(rear.vx), 'forward push should be stronger than rear push');
  });

  it('uses a deterministic blast envelope for the same ship motion', () => {
    const a = resolveExplosionProfile(180, 0);
    const b = resolveExplosionProfile(180, 0);

    assert.deepEqual(a, b, 'same velocity should resolve to the same base explosion profile');
  });
});
