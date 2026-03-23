import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../helpers/phaser.mock.js';

installPhaserGlobal();

const {
  EffectsSystem,
  composeFragmentVelocity,
  calcShockwavePush,
  resolveEnemyExplosionSpec,
  resolveExplosionProfile,
} = await import('../../systems/EffectsSystem.js');

describe('EffectsSystem', () => {
  let scene;
  let effects;
  let completions;

  beforeEach(() => {
    scene = createMockScene();
    scene.soundCalls = [];
    scene.sound = {
      play: (key) => {
        scene.soundCalls.push(key);
      },
    };
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

  it('plays the skirm explosion sound for skirm deaths', () => {
    effects.explodeForType(100, 100, 'skirm', 0, 0, [], []);
    assert.deepEqual(scene.soundCalls, ['explosionSkirm_000']);
  });

  it('uses the generic executor for mine deaths and keeps explosion audio', () => {
    const spawnedWaves = [];
    effects._spawnExplosionWave = (x, y, vx, vy, wave) => {
      spawnedWaves.push(wave.shape);
    };
    effects._applyShockwave = () => {};

    effects.explodeForType(100, 100, 'mine', 0, 0, [], []);

    assert.deepEqual(spawnedWaves, ['radial', 'radial']);
    assert.deepEqual(scene.soundCalls, ['explosionSkirm_000']);
  });

  it('resolves distinct blast specs for skirm, raptor, and mine', () => {
    const skirm = resolveEnemyExplosionSpec('skirm', 180, 0);
    const raptor = resolveEnemyExplosionSpec('raptor', 180, 0);
    const mine = resolveEnemyExplosionSpec('mine', 180, 0);

    assert.equal(skirm.waves.length, 1);
    assert.deepEqual(skirm.waves.map((wave) => wave.shape), ['directional']);
    assert.deepEqual(raptor.waves.map((wave) => wave.shape), ['directional', 'radial']);
    assert.deepEqual(mine.waves.map((wave) => wave.shape), ['radial', 'radial']);
    assert.ok(raptor.disruption.radius > skirm.disruption.radius);
    assert.ok(mine.disruption.maxPush > skirm.disruption.maxPush);
  });

  it('can suppress the category explosion sound for placeholder blasts', () => {
    effects.explodeForType(100, 100, 'skirm', 0, 0, [], [], { playSound: false });
    assert.deepEqual(scene.soundCalls, []);
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

  it('spawns a short-lived particle firework when a shield breaks', () => {
    let exploded = null;
    let destroyed = false;
    let particleConfig = null;
    scene.add.particles = (x, y, texture, config) => {
      particleConfig = config;
      return ({
      setDepth: () => {},
      explode: (count, x, y) => { exploded = { count, x, y }; },
      destroy: () => { destroyed = true; },
      });
    };
    scene.time.delayedCall = (delay, cb) => {
      assert.equal(delay, 540);
      cb();
    };

    effects.explodeShield(120, 160, 20);

    assert.deepEqual(exploded, { count: 18, x: 120, y: 160 });
    assert.deepEqual(particleConfig.tint, [0xd6f0ff, 0x9fdbff, 0x63bbff, 0x2e86ff, 0x1458ff]);
    assert.equal(destroyed, true);
  });

  it('creates a flares gravity well and pulls the target toward its source', () => {
    const source = { x: 100, y: 120, active: true, visible: true };
    const target = {
      x: 150,
      y: 120,
      active: true,
      body: {
        velocity: { x: 0, y: 0 },
        setVelocity(x, y) {
          this.velocity.x = x;
          this.velocity.y = y;
        },
      },
    };

    const controller = effects.createGravityWell(source, target, {
      radius: 52,
      pullRadius: 180,
      pullStrength: 600,
      power: 4.2,
      epsilon: 250,
      gravity: 100,
    });

    assert.equal(controller.emitter.texture, 'flares');
    assert.equal(controller.emitter.emitZone.type, 'random');
    assert.equal(controller.emitter.emitZone.source.radius, 52);
    assert.equal(controller.gravityWell.power, 4.2);
    assert.equal(controller.gravityWell.gravity, 100);

    controller.update(1000);
    assert.equal(controller.emitter.emitting, true);
    assert.ok(target.body.velocity.x < 0, 'target to the right should be pulled leftward');

    source.x = 112;
    source.y = 136;
    controller.update(16);
    assert.equal(controller.emitter.x, 112);
    assert.equal(controller.emitter.y, 136);
    assert.equal(controller.gravityWell.x, 112);
    assert.equal(controller.gravityWell.y, 136);

    controller.destroy();
    assert.equal(controller.emitter.active, false);
  });

  it('shows a floating damage number that rises and fades out', () => {
    let tweenConfig = null;
    let destroyed = false;
    scene.tweens.add = (config) => {
      tweenConfig = config;
      return config;
    };
    scene.add.text = (x, y, value, style) => ({
      x,
      y,
      value,
      style,
      preFX: { addGlow: () => ({}) },
      setOrigin() { return this; },
      setDepth() { return this; },
      setAlpha() { return this; },
      setScale() { return this; },
      destroy() { destroyed = true; },
    });

    const text = effects.showDamageNumber(120, 150, 17);

    assert.equal(text.value, '17');
    assert.equal(tweenConfig.y, 132);
    tweenConfig.onComplete();
    assert.equal(destroyed, true);
  });

  it('can show large bonus text using the same floating-text effect', () => {
    let tweenConfig = null;
    let destroyed = false;
    scene.tweens.add = (config) => {
      tweenConfig = config;
      return config;
    };
    scene.add.text = (x, y, value, style) => ({
      x,
      y,
      value,
      style,
      preFX: { addGlow: () => ({}) },
      setOrigin() { return this; },
      setDepth() { return this; },
      setAlpha() { return this; },
      setScale() { return this; },
      destroy() { destroyed = true; },
    });

    const text = effects.showDamageNumber(120, 150, '1-UP', {
      fontSize: '26px',
      lift: 28,
      duration: 520,
      scaleTo: 1.08,
    });

    assert.equal(text.value, '1-UP');
    assert.equal(text.style.fontSize, '26px');
    assert.equal(tweenConfig.y, 122);
    assert.equal(tweenConfig.duration, 520);
    tweenConfig.onComplete();
    assert.equal(destroyed, true);
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
