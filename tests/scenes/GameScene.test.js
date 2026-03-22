import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../helpers/phaser.mock.js';

installPhaserGlobal();

const { GAME_CONFIG } = await import('../../config/game.config.js');
const { RunState } = await import('../../systems/RunState.js');
const { EVENTS } = await import('../../config/events.config.js');
const { resolveStats } = await import('../../systems/WaveSpawner.js');
const { Skirm } = await import('../../entities/enemies/Skirm.js');
const {
  GameScene,
  isHeatWarningActive,
  resolveHeatBarStyle,
} = await import('../../scenes/GameScene.js');
const SKIRM_STATS = resolveStats('skirm', 1.0, 1.0, {});

function createHeatWarningScene(heatShots) {
  const calls = [];
  const scene = new GameScene();
  scene._weapons = {
    heatShots,
    maxHeatShots: GAME_CONFIG.PLAYER_HEAT_MAX,
  };
  scene.cameras = {
    main: {
      shake: (duration, intensity, force) => {
        calls.push({ type: 'shake', duration, intensity, force });
      },
      stopShake: () => {
        calls.push({ type: 'stopShake' });
      },
    },
  };
  scene._heatWarningActive = false;
  scene._nextHeatWarningShakeAt = 0;
  return { scene, calls };
}

describe('isHeatWarningActive', () => {
  it('returns false below the warning threshold', () => {
    assert.equal(
      isHeatWarningActive(
        GAME_CONFIG.PLAYER_HEAT_MAX * GAME_CONFIG.PLAYER_HEAT_WARNING_RATIO - 0.01,
        GAME_CONFIG.PLAYER_HEAT_MAX
      ),
      false
    );
  });

  it('returns true at the warning threshold', () => {
    assert.equal(
      isHeatWarningActive(
        GAME_CONFIG.PLAYER_HEAT_MAX * GAME_CONFIG.PLAYER_HEAT_WARNING_RATIO,
        GAME_CONFIG.PLAYER_HEAT_MAX
      ),
      true
    );
  });
});

describe('resolveHeatBarStyle', () => {
  it('keeps the heat bar red and fully opaque below the warning threshold', () => {
    const style = resolveHeatBarStyle(
      GAME_CONFIG.PLAYER_HEAT_MAX * GAME_CONFIG.PLAYER_HEAT_WARNING_RATIO - 0.01,
      GAME_CONFIG.PLAYER_HEAT_MAX,
      0
    );

    assert.equal(style.color, 0xff3300);
    assert.equal(style.alpha, 1);
  });

  it('turns the heat bar yellow and blinks once the warning threshold is reached', () => {
    const heatShots = GAME_CONFIG.PLAYER_HEAT_MAX * GAME_CONFIG.PLAYER_HEAT_WARNING_RATIO;
    const bright = resolveHeatBarStyle(heatShots, GAME_CONFIG.PLAYER_HEAT_MAX, 0);
    const dim = resolveHeatBarStyle(
      heatShots,
      GAME_CONFIG.PLAYER_HEAT_MAX,
      GAME_CONFIG.PLAYER_HEAT_WARNING_BLINK_MS
    );

    assert.equal(bright.color, 0xffdd33);
    assert.equal(bright.alpha, 1);
    assert.equal(dim.color, 0xffdd33);
    assert.equal(dim.alpha, 0.3);
  });
});

describe('GameScene heat warning shake', () => {
  it('starts a fast camera shake while heat is in the warning zone', () => {
    const { scene, calls } = createHeatWarningScene(
      GAME_CONFIG.PLAYER_HEAT_MAX * GAME_CONFIG.PLAYER_HEAT_WARNING_RATIO
    );

    scene._updateHeatWarningShake(1000);

    assert.equal(scene._heatWarningActive, true);
    assert.deepEqual(calls, [{
      type: 'shake',
      duration: GAME_CONFIG.PLAYER_HEAT_WARNING_SHAKE_MS,
      intensity: GAME_CONFIG.PLAYER_HEAT_WARNING_SHAKE_INTENSITY,
      force: true,
    }]);
    assert.equal(scene._nextHeatWarningShakeAt, 1000 + GAME_CONFIG.PLAYER_HEAT_WARNING_SHAKE_MS);
  });

  it('stops the camera shake once heat drops back below the warning zone', () => {
    const { scene, calls } = createHeatWarningScene(
      GAME_CONFIG.PLAYER_HEAT_MAX * GAME_CONFIG.PLAYER_HEAT_WARNING_RATIO
    );

    scene._updateHeatWarningShake(1000);
    scene._weapons.heatShots = GAME_CONFIG.PLAYER_HEAT_MAX * GAME_CONFIG.PLAYER_HEAT_WARNING_RATIO - 0.01;
    scene._updateHeatWarningShake(1020);

    assert.equal(scene._heatWarningActive, false);
    assert.deepEqual(calls.at(-1), { type: 'stopShake' });
  });

  it('adds a short extra punch when a hot twin-laser shot fires', () => {
    const { scene, calls } = createHeatWarningScene(0);

    scene._playPlayerShotFeedback({
      warningShot: true,
      shotShakeMs: 24,
      shotShakeIntensity: 0.0018,
    });

    assert.deepEqual(calls, [{
      type: 'shake',
      duration: 24,
      intensity: 0.0018,
      force: true,
    }]);
  });

  it('does not add the hot-shot punch for normal laser shots', () => {
    const { scene, calls } = createHeatWarningScene(0);

    scene._playPlayerShotFeedback({
      warningShot: false,
      shotShakeMs: 24,
      shotShakeIntensity: 0.0018,
    });

    assert.deepEqual(calls, []);
  });
});

describe('GameScene bullet damage', () => {
  it('uses the shared hot-shot payload when a warning beam hits an enemy', () => {
    const scene = new GameScene();
    let hitDamage = 0;
    let hitScoreMultiplier = 0;
    let hiddenBullet = null;
    const enemy = {
      alive: true,
      takeDamage: (damage, scoreMultiplier) => {
        hitDamage = damage;
        hitScoreMultiplier = scoreMultiplier;
      },
    };
    const shotPayload = {
      damage: 12,
      hitEnemies: new Set(),
      scoreMultiplier: 1.2,
    };
    const bullet = {
      _damage: 12,
      _scoreMultiplier: 1.2,
      _shotPayload: shotPayload,
      body: {
        enable: true,
        stop: () => {},
      },
    };

    scene._weapons = {
      damage: 10,
      pool: {
        killAndHide: (target) => {
          hiddenBullet = target;
        },
      },
    };

    scene._onBulletHitEnemy(bullet, enemy);

    assert.equal(hiddenBullet, bullet);
    assert.equal(hitDamage, 12);
    assert.equal(hitScoreMultiplier, 1.2);
    assert.ok(shotPayload.hitEnemies.has(enemy));
    assert.equal(bullet.body.enable, false);
  });

  it('does not let the sister warning beam hit the same enemy twice', () => {
    const scene = new GameScene();
    let hitCount = 0;
    const enemy = {
      alive: true,
      takeDamage: () => { hitCount++; },
    };
    const shotPayload = {
      damage: 12,
      hitEnemies: new Set([enemy]),  // enemy already recorded as hit
      scoreMultiplier: 1.2,
    };
    const bullet = {
      _damage: 12,
      _scoreMultiplier: 1.2,
      _shotPayload: shotPayload,
      body: {
        enable: true,
        stop: () => {},
      },
    };

    scene._weapons = {
      damage: 10,
      pool: {
        killAndHide: () => {},
      },
    };

    scene._onBulletHitEnemy(bullet, enemy);

    assert.equal(hitCount, 0);
  });
});

describe('GameScene enemy score awards', () => {
  it('applies the killing shot score multiplier to the awarded score', () => {
    RunState.reset();
    const scene = new GameScene();
    scene._explodeForType = () => {};
    scene._animateScore = () => {};

    scene._onEnemyDied({ x: 0, y: 0, type: 'skirm', score: 10, scoreMultiplier: 1.4 });

    assert.equal(RunState.score, 14);
    assert.equal(RunState.kills, 1);
  });

  it('awards the hotter kill score through the real bullet-hit to enemy-death path', () => {
    RunState.reset();
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene._explodeForType = () => {};
    scene._animateScore = () => {};
    scene._weapons = {
      damage: 10,
      pool: {
        killAndHide: () => {},
      },
    };
    scene.events.emit = (event, data) => {
      if (event === EVENTS.ENEMY_DIED) scene._onEnemyDied(data);
    };

    const skirm = new Skirm(scene, 120, 80, SKIRM_STATS, 'straight');
    const bullet = {
      _damage: 11,
      _scoreMultiplier: 1.1,
      _shotPayload: {
        damage: 11,
        scoreMultiplier: 1.1,
        hitEnemies: new Set(),
      },
      body: {
        enable: true,
        stop: () => {},
      },
    };

    scene._onBulletHitEnemy(bullet, skirm);

    assert.equal(RunState.score, 55);
    assert.equal(RunState.kills, 1);
  });

  it('uses the killing shot multiplier for score even after earlier hot damage', () => {
    RunState.reset();
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene._explodeForType = () => {};
    scene._animateScore = () => {};
    scene._weapons = {
      damage: 10,
      pool: {
        killAndHide: () => {},
      },
    };
    scene.events.emit = (event, data) => {
      if (event === EVENTS.ENEMY_DIED) scene._onEnemyDied(data);
    };

    const skirm = new Skirm(scene, 120, 80, { ...SKIRM_STATS, hp: 10 }, 'straight');
    const hotBullet = {
      _damage: 5,
      _scoreMultiplier: 1.2,
      _shotPayload: {
        damage: 5,
        scoreMultiplier: 1.2,
        hitEnemies: new Set(),
      },
      body: {
        enable: true,
        stop: () => {},
      },
    };
    const normalBullet = {
      _damage: 5,
      _scoreMultiplier: 1,
      body: {
        enable: true,
        stop: () => {},
      },
    };

    scene._onBulletHitEnemy(hotBullet, skirm);
    scene._onBulletHitEnemy(normalBullet, skirm);

    assert.equal(RunState.score, 50);
    assert.equal(RunState.kills, 1);
  });

  it('a 1.5× hot bullet (damage=15) kills a 10-HP Skirm and awards 75 points (= round(50 × 1.5))', () => {
    RunState.reset();
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene._explodeForType = () => {};
    scene._animateScore = () => {};
    scene._weapons = { damage: 10, pool: { killAndHide: () => {} } };
    scene.events.emit = (event, data) => {
      if (event === EVENTS.ENEMY_DIED) scene._onEnemyDied(data);
    };

    const skirm = new Skirm(scene, 120, 80, SKIRM_STATS, 'straight');
    const bullet = {
      _damage: 15,
      _scoreMultiplier: 1.5,
      _shotPayload: { damage: 15, scoreMultiplier: 1.5, hitEnemies: new Set() },
      body: { enable: true, stop: () => {} },
    };

    scene._onBulletHitEnemy(bullet, skirm);

    assert.equal(skirm.hp, 0);
    assert.equal(skirm.alive, false);
    assert.equal(RunState.score, 75);
    assert.equal(RunState.kills, 1);
  });

  it('a 1.5× hot bullet (damage=15) only reduces a 20-HP Skirm to 5 HP — no kill, no score', () => {
    RunState.reset();
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene._explodeForType = () => {};
    scene._animateScore = () => {};
    scene._weapons = { damage: 10, pool: { killAndHide: () => {} } };
    scene.events.emit = (event, data) => {
      if (event === EVENTS.ENEMY_DIED) scene._onEnemyDied(data);
    };

    const skirm = new Skirm(scene, 120, 80, { ...SKIRM_STATS, hp: 20 }, 'straight');
    const bullet = {
      _damage: 15,
      _scoreMultiplier: 1.5,
      _shotPayload: { damage: 15, scoreMultiplier: 1.5, hitEnemies: new Set() },
      body: { enable: true, stop: () => {} },
    };

    scene._onBulletHitEnemy(bullet, skirm);

    assert.equal(skirm.hp, 5);
    assert.equal(skirm.alive, true);
    assert.equal(RunState.score, 0);
    assert.equal(RunState.kills, 0);
  });

  it('tracks the animated HUD score from the current tween value during rapid updates', () => {
    const scene = new GameScene();
    let tweenConfig = null;
    let scoreText = '';
    scene._displayedScore = 0;
    scene._scoreText = {
      setText: (value) => {
        scoreText = value;
      },
    };
    scene.tweens = {
      add: (config) => {
        tweenConfig = config;
        return { stop: () => {} };
      },
    };

    scene._animateScore(55);
    tweenConfig.targets.val = 27.9;
    tweenConfig.onUpdate();

    assert.equal(scene._displayedScore, 27.9);
    assert.equal(scoreText, 'SCORE  27');
  });
});

describe('GameScene player explosion', () => {
  it('calls explodePlayer on the effects system and flashes the camera', () => {
    const scene = new GameScene();
    let explodePlayerCalled = false;
    let flashCalled = false;
    scene._effects = {
      explodePlayer: () => { explodePlayerCalled = true; },
    };
    scene.cameras = { main: { flash: () => { flashCalled = true; } } };

    scene._explode(120, 240);

    assert.equal(explodePlayerCalled, true, 'explodePlayer must be called');
    assert.equal(flashCalled, true, 'camera flash must be called');
  });
});

