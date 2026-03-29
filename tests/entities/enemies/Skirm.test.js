import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../../helpers/phaser.mock.js';

installPhaserGlobal();

import { Skirm } from '../../../entities/enemies/Skirm.js';
import { ENEMIES } from '../../../config/enemies.config.js';
import { GAME_CONFIG } from '../../../config/game.config.js';
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
    const DANCES = [
      'straight',
      'sweep_left',
      'sweep_right',
      'side_cross',
      'fan_out',
      'zigzag',
      'drift_drop',
      'jink_drop',
      'whirl',
      'hourglass',
    ];

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

    it('keeps sweep dances fast enough to feel like authored bursts while still respecting the class cap', () => {
      const scene = createMockScene();
      const tweenCalls = [];
      scene.tweens.add = (config) => {
        tweenCalls.push({
          startX: config.targets.x,
          startY: config.targets.y,
          x: config.x,
          y: config.y,
          duration: config.duration,
        });
        return { stop: () => {} };
      };

      new Skirm(scene, 100, -40, BASE_STATS, 'sweep_right');

      const firstTravel = tweenCalls[0];
      assert.ok(firstTravel, 'expected an initial sweep tween');

      const distance = Math.hypot(
        firstTravel.x - firstTravel.startX,
        firstTravel.y - firstTravel.startY
      );
      const impliedSpeed = distance / Math.max(firstTravel.duration / 1000, 0.001);

      assert.ok(
        impliedSpeed > 200,
        `expected authored sweep pace above 200 px/s, got ${impliedSpeed}`
      );
      assert.ok(
        impliedSpeed <= ENEMIES.skirm.maxSpeed + 0.001,
        `expected sweep pace <= ${ENEMIES.skirm.maxSpeed} px/s, got ${impliedSpeed}`
      );
    });

    it('whirl enters on screen and starts a looping orbit instead of exiting', () => {
      const scene = createMockScene();
      const tweenCalls = [];
      scene.tweens.add = (config) => {
        tweenCalls.push(config);
        return { stop: () => {} };
      };

      const skirm = new Skirm(scene, 120, -40, BASE_STATS, 'whirl');
      assert.equal(skirm.alive, true);
      assert.ok(tweenCalls.length >= 1, 'whirl should schedule an entry tween');

      const entry = tweenCalls[0];
      assert.ok(entry.y >= 0 && entry.y <= GAME_CONFIG.HEIGHT * 0.5, 'whirl entry should move on screen');

      entry.onComplete();

      assert.ok(tweenCalls.length >= 2, 'whirl should schedule a looping orbit step');
      const orbit = tweenCalls[1];
      assert.ok(orbit.x >= 0 && orbit.x <= GAME_CONFIG.WIDTH, 'whirl orbit x should stay on screen');
      assert.ok(orbit.y >= 0 && orbit.y <= GAME_CONFIG.HEIGHT, 'whirl orbit y should stay on screen');
    });

    it('hourglass enters on screen and starts a mirrored hold pattern instead of exiting', () => {
      const scene = createMockScene();
      const tweenCalls = [];
      scene.tweens.add = (config) => {
        tweenCalls.push(config);
        return { stop: () => {} };
      };

      const skirm = new Skirm(scene, 200, -40, BASE_STATS, 'hourglass');
      assert.equal(skirm.alive, true);
      assert.ok(tweenCalls.length >= 1, 'hourglass should schedule an entry tween');

      const entry = tweenCalls[0];
      assert.ok(entry.y >= 0 && entry.y <= GAME_CONFIG.HEIGHT * 0.5, 'hourglass entry should move on screen');

      entry.onComplete();

      assert.ok(tweenCalls.length >= 2, 'hourglass should schedule a looping weave step');
      const firstLoop = tweenCalls[1];
      assert.ok(firstLoop.x >= 0 && firstLoop.x <= GAME_CONFIG.WIDTH, 'hourglass loop x should stay on screen');
      assert.ok(firstLoop.y >= 0 && firstLoop.y <= GAME_CONFIG.HEIGHT, 'hourglass loop y should stay on screen');
      assert.notEqual(firstLoop.x, entry.x, 'hourglass should move off the center line during its loop');
    });

    it('can use the learned policy to pick a safer lane and faster speed within class limits', () => {
      const { skirm, scene } = makeSkirm('straight', {
        adaptive: {
          enabled: true,
          minSpeedScalar: 0.9,
          maxSpeedScalar: 1.15,
        },
      });
      scene._enemyAdaptivePolicy = {
        getPositionOffsets() { return [-1, 0, 1]; },
        getVerticalOffsets() { return [-1, 0, 1]; },
        getSpeedCandidates() { return [0.9, 1, 1.15]; },
        resolveBehavior({ candidates }) {
          return candidates.at(-1);
        },
      };
      skirm.unlockAdaptiveBehavior();

      const plan = skirm.resolveAdaptiveMovePlan(180, {
        candidateY: 200,
        rangePx: 80,
        yRangePx: 60,
        marginPx: 30,
      });

      assert.ok(plan.x > 180);
      assert.ok(plan.y >= 200);
      assert.equal(plan.speedScalar, 1.15);
      assert.equal(skirm.adaptiveProfile.currentSpeedScalar, 1.15);
      assert.equal(plan.actionMode, 'flank');
    });

    it('completes one authored dance pass before unlocking adaptive movement', () => {
      const scene = createMockScene();
      const tweenCalls = [];
      scene.tweens.add = (config) => {
        tweenCalls.push(config);
        return { stop: () => {} };
      };

      const skirm = new Skirm(scene, 120, -40, {
        ...BASE_STATS,
        adaptive: {
          enabled: true,
          minSpeedScalar: 0.9,
          maxSpeedScalar: 1.15,
        },
      }, 'zigzag');

      assert.equal(skirm.canUseAdaptiveBehavior(), false);
      tweenCalls[0].onComplete();
      assert.equal(skirm.canUseAdaptiveBehavior(), true);
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

    it('a 15-damage hot bullet (= round(10 × 1.5)) reduces a 20-HP Skirm to 5 HP without killing it', () => {
      const { skirm } = makeSkirm('straight', { hp: 20 });
      skirm.takeDamage(15);
      assert.equal(skirm.hp, 5);
      assert.equal(skirm.alive, true);
    });

    it('a 12-damage hot bullet (= round(10 × 1.2)) one-shots a standard 10-HP Skirm', () => {
      const { skirm } = makeSkirm();
      skirm.takeDamage(12, 1.2);
      assert.equal(skirm.hp, 0);
      assert.equal(skirm.alive, false);
    });

    it('shielded skirm loses shield before hp and keeps firing stats intact', () => {
      const { skirm } = makeSkirm('straight', { hp: 10, shield: 6, damage: 13, bulletSpeed: 260 });

      skirm.takeDamage(4);
      assert.equal(skirm.shield, 2);
      assert.equal(skirm.hp, 10);
      assert.equal(skirm.damage, 13);
      assert.equal(skirm.bulletSpeed, 260);

      skirm.takeDamage(5);
      assert.equal(skirm.shield, 0);
      assert.equal(skirm.hp, 7);
      assert.equal(skirm.alive, true);
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

    it('keeps its laser firing straight down even when learned movement is enabled', () => {
      const { skirm, scene } = makeSkirm('straight', {
        adaptive: {
          enabled: true,
          minSpeedScalar: 0.9,
          maxSpeedScalar: 1.15,
        },
      });
      const fired = [];
      scene.events.emit = (event, data) => { if (event === EVENTS.ENEMY_FIRE) fired.push(data); };

      skirm.x = 100;
      skirm.y = 120;
      skirm.fire();

      assert.equal(fired.length, 1);
      assert.equal(fired[0].vx, 0);
      assert.ok(fired[0].vy > 0);
    });

    it('can hold fire until the learned window looks favorable', () => {
      const { skirm, scene } = makeSkirm();
      scene._enemyAdaptivePolicy = {
        scoreCurrentPosition() {
          return {
            score: 0.2,
            predictedPressure: 0.3,
            predictedEnemyWinRate: 0.4,
          };
        },
      };
      scene._weapons = {
        pool: {
          getChildren() {
            return [{ active: true }];
          },
        },
      };
      skirm.adaptiveProfile.enabled = true;
      skirm.unlockAdaptiveBehavior();

      assert.equal(skirm.shouldFireNow(), false);

      skirm._fireCooldown = skirm.fireRate * 3;
      assert.equal(skirm.shouldFireNow(), true);

      scene._enemyAdaptivePolicy.scoreCurrentPosition = () => ({
        score: 0.8,
        predictedPressure: 0.7,
        predictedEnemyWinRate: 0.65,
      });

      assert.equal(skirm.shouldFireNow(), true);
    });

    it('fires immediately when the player is not shooting', () => {
      const { skirm, scene } = makeSkirm();
      scene._enemyAdaptivePolicy = {
        scoreCurrentPosition() {
          return {
            score: 0.05,
            predictedPressure: 0.1,
            predictedEnemyWinRate: 0.15,
          };
        },
      };
      scene._weapons = {
        pool: {
          getChildren() {
            return [];
          },
        },
      };
      skirm.adaptiveProfile.enabled = true;
      skirm.unlockAdaptiveBehavior();

      assert.equal(skirm.shouldFireNow(), true);
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

    it('the killing shot alone decides the ENEMY_DIED score multiplier', () => {
      const { skirm, scene } = makeSkirm({ hp: 10 });
      const events = [];
      scene.events.emit = (e, d) => events.push({ event: e, data: d });

      skirm.takeDamage(5, 1.2);
      skirm.takeDamage(5, 1);

      const died = events.find(e => e.event === EVENTS.ENEMY_DIED);
      assert.ok(died);
      assert.equal(died.data.scoreMultiplier, 1);
    });
  });
});
